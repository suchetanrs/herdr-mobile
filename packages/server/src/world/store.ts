import { EventEmitter } from 'node:events';
import { type AgentAccount, type AgentStatus, emptyWorld, LOOKING_TTL_MS, type PatchOp, type World } from '@herdr-mobile/protocol';
import type { CoreClient, CoreNotification } from '../core/client.js';
import type { CoreEvent, CoreSnapshot, CoreTerminal } from '../core/types.js';
import { type Logger, silentLogger } from '../log.js';
import { deriveWorld } from './derive.js';
import { diffWorld } from './diff.js';
import { asLayoutDoc, type LayoutDoc } from './layout.js';
import { agentName, CheckoutResolver } from './names.js';
import { RemoteCheckouts } from './remoteCheckouts.js';
import { appOf, wordOf } from './status.js';
import { TerminalTable } from './terminals.js';

export const LAYOUT_DOC = 'herdr-app';

/** One terminal's 7501 word changed (input to the attention engine). */
export interface WordTransition {
  terminalId: string;
  prev: string | null;
  next: string | null;
  turn: number;
  /** Started by another terminal (`parent`): reports to its parent, never alerts on its own. */
  subAgent: boolean;
  /** Has a pane in one of the spaces (else it isn't this person's business). */
  hasPane: boolean;
  /** A client says the person is looking at it right now. */
  looking: boolean;
  /** Its name for alerts: name, else the agent's name, else null. */
  name: string | null;
  /** "<space> / <tab>" of where it lives. */
  place: string | null;
}

interface AgentState {
  word: string | null;
  app: string | null;
  /** The person saw it since it last stopped working (model.rs `Agent.seen`; new agents start seen). */
  seen: boolean;
  /** It had a pane at the last decision. */
  placed: boolean;
}

type StoreEvents = {
  /** The world changed: ops to apply, and the world after them. */
  patch: [PatchOp[], World];
  /** Words that changed in one rebuild (never on the very first listing). */
  transitions: [WordTransition[]];
  /** What the people at the clients are looking at changed. */
  looking: [];
};

export interface WorldStoreOptions {
  client: CoreClient;
  logger?: Logger;
  home: string;
  checkout?: CheckoutResolver;
  /** See DeriveInput.includeUnplaced. */
  includeUnplaced?: boolean;
  /** See DeriveInput.spaceColor. */
  spaceColor?: (spaceId: string) => string | null;
  /** See DeriveInput.statusSince. */
  statusSince?: (address: string, status: AgentStatus | null) => number | null;
  /** See DeriveInput.transcriptOf. */
  transcriptOf?: (t: CoreTerminal) => string | null;
  /** See DeriveInput.accountOf. */
  accountOf?: (address: string) => AgentAccount | null;
  /** See DeriveInput.agentName. */
  agentName?: (app: string) => string;
  /** How often to ask the core for its machines (the desktop asks every 2.5 s); 0 = only on connect. */
  machinePollMs?: number;
  /** A client's `looking` counts this long unless it renews it (LOOKING_TTL_MS). */
  lookingTtlMs?: number;
  /** Word changes are decided on this tick, like the desktop's 500 ms tick (a flap inside one isn't news). */
  tickMs?: number;
  now?: () => number;
}

/**
 * Keeps the world in sync with herdr-core: subscribes to events, reads the
 * layout docs, and rebuilds the client-facing world (coalesced to one rebuild
 * per event-loop turn) whenever something changes.
 */
export class WorldStore extends EventEmitter<StoreEvents> {
  private readonly client: CoreClient;
  private readonly log: Logger;
  private readonly home: string;
  private readonly checkout: CheckoutResolver;
  private readonly table = new TerminalTable();
  /** Layout docs by machine ('' = this one), with the core generation they came from. */
  private readonly docs = new Map<string, { version: number; doc: LayoutDoc; gen: number }>();
  /** Machines with a doc.get in flight: `again` when another change came meanwhile. */
  private readonly docFetches = new Map<string, { again: boolean }>();
  private readonly remote: RemoteCheckouts;
  private readonly tickMs: number;
  private tickTimer: NodeJS.Timeout | null = null;
  /** The first decision after the first listing has been made: from then on changes are news. */
  private decidedListed = false;
  private readonly agents = new Map<string, AgentState>();
  /** Per client: what it says is on screen, and until when that holds (a lease the client renews). */
  private readonly lookingBy = new Map<string, { ids: Set<string>; until: number; timer: NodeJS.Timeout }>();
  private readonly lookingTtlMs: number;
  private readonly now: () => number;
  private current: World = emptyWorld();
  private listedOnce = false;
  private subscribed = false;
  private buffered: CoreNotification[] = [];
  private rebuildQueued = false;
  private generation = 0;
  private readonly includeUnplaced: boolean;
  private readonly spaceColor: ((spaceId: string) => string | null) | undefined;
  private readonly statusSince: WorldStoreOptions['statusSince'];
  private readonly transcriptOf: WorldStoreOptions['transcriptOf'];
  private readonly accountOf: WorldStoreOptions['accountOf'];
  private readonly agentName: (app: string) => string;
  private readonly machinePollMs: number;
  private machineTimer: NodeJS.Timeout | null = null;
  private machines: string[] = [];

  constructor(opts: WorldStoreOptions) {
    super();
    this.client = opts.client;
    this.log = opts.logger ?? silentLogger;
    this.home = opts.home;
    this.checkout = opts.checkout ?? new CheckoutResolver();
    this.includeUnplaced = opts.includeUnplaced ?? false;
    this.spaceColor = opts.spaceColor;
    this.statusSince = opts.statusSince;
    this.transcriptOf = opts.transcriptOf;
    this.accountOf = opts.accountOf;
    this.agentName = opts.agentName ?? ((app) => agentName(app));
    this.machinePollMs = opts.machinePollMs ?? 2500;
    this.lookingTtlMs = opts.lookingTtlMs ?? LOOKING_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 500;
    this.remote = new RemoteCheckouts(this.client, () => this.scheduleRebuild(), this.log);
  }

  /** Something the world is derived from changed outside the core (e.g. the desktop's space colors). */
  refresh(): void {
    this.scheduleRebuild();
  }

  get world(): World {
    return this.current;
  }

  /** Raw core record (for modules that need more than the world shows). */
  terminal(address: string): CoreTerminal | undefined {
    return this.table.get(address);
  }

  start(): void {
    this.client.on('ready', () => void this.onReady());
    this.client.on('eventsClosed', () => void this.onReady());
    this.client.on('down', () => {
      this.subscribed = false;
      this.generation++;
      this.scheduleRebuild();
    });
    this.client.start();
    if (this.machinePollMs > 0) {
      this.machineTimer = setInterval(() => void this.pollMachines(), this.machinePollMs);
      this.machineTimer.unref();
    }
  }

  stop(): void {
    if (this.machineTimer) clearInterval(this.machineTimer);
    this.machineTimer = null;
    for (const l of this.lookingBy.values()) clearTimeout(l.timer);
    this.lookingBy.clear();
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.client.stop();
  }

  /**
   * What one client says the person is looking at (replaces its previous set). Empty clears it.
   * It's a lease: unless the client says it again within `lookingTtlMs`, it lapses (a phone that
   * locked or dropped off can't leave "looking" behind; window.rs re-checks every tick too).
   */
  setLooking(clientId: string, terminalIds: readonly string[]): void {
    const old = this.lookingBy.get(clientId);
    if (old) clearTimeout(old.timer);
    if (terminalIds.length === 0) this.lookingBy.delete(clientId);
    else {
      const timer = setTimeout(() => {
        if (this.lookingBy.get(clientId)?.timer !== timer) return;
        this.lookingBy.delete(clientId);
        this.emit('looking');
      }, this.lookingTtlMs);
      timer.unref();
      this.lookingBy.set(clientId, { ids: new Set(terminalIds), until: this.now() + this.lookingTtlMs, timer });
    }
    // model.rs `mark_seen`: what's in front of someone is seen.
    for (const id of terminalIds) {
      const a = this.agents.get(id);
      if (a) a.seen = true;
    }
    const renewal = old !== undefined && sameIds(old.ids, terminalIds);
    if (renewal) return;
    this.scheduleRebuild();
    this.emit('looking');
  }

  /** Every terminal some client is looking at (fresh leases only). */
  lookingIds(): Set<string> {
    const all = new Set<string>();
    const now = this.now();
    for (const l of this.lookingBy.values()) if (l.until > now) for (const id of l.ids) all.add(id);
    return all;
  }

  private isLooking(id: string): boolean {
    const now = this.now();
    for (const l of this.lookingBy.values()) if (l.until > now && l.ids.has(id)) return true;
    return false;
  }

  // ---- core sync ----

  private async onReady(): Promise<void> {
    const gen = ++this.generation;
    this.subscribed = false;
    this.buffered = [];
    try {
      // Subscribe before reading docs (schema/README.md "Documents").
      const snapshot = await this.client.subscribe((n) => this.onNotification(n));
      if (gen !== this.generation) return;
      this.applySnapshot(snapshot);
      this.subscribed = true;
      const pending = this.buffered;
      this.buffered = [];
      for (const n of pending) this.onNotification(n);
      await this.refetchDocs(gen);
    } catch (err) {
      if (gen !== this.generation) return;
      // The socket may be fine while the subscription isn't: start over rather than sit on a stale world.
      this.log.warn({ err: (err as Error).message }, 'core sync failed; reconnecting');
      this.client.reconnect('subscribe failed');
    }
  }

  private applySnapshot(s: CoreSnapshot): void {
    this.table.reset(s.seq, s.terminals ?? []);
    this.scheduleRebuild();
  }

  private onNotification(n: CoreNotification): void {
    if (!this.subscribed) {
      this.buffered.push(n);
      return;
    }
    if (n.method === 'missed') {
      this.log.warn({ seq: n.params.seq }, 'core says we missed events; taking its snapshot');
      this.applySnapshot(n.params as unknown as CoreSnapshot);
      void this.refetchDocs(this.generation);
      return;
    }
    if (n.method !== 'event') return;
    const ev = n.params as unknown as CoreEvent;
    if (ev.type === 'doc') {
      const data = (ev.data ?? {}) as { name?: string; version?: number; machine?: string };
      const machine = ev.machine ?? data.machine ?? '';
      if (data.name === LAYOUT_DOC && (this.docs.get(machine)?.version ?? -1) !== data.version) {
        void this.fetchDoc(machine, this.generation);
      }
    }
    if (this.table.apply(ev)) this.scheduleRebuild();
  }

  private async listMachines(): Promise<string[] | null> {
    try {
      const r = await this.client.call<{ machines?: Array<{ name?: string }> }>('machine.list');
      return (r.machines ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string' && n !== '');
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'machine.list failed');
      return null;
    }
  }

  private async refetchDocs(gen: number): Promise<void> {
    const machines = (await this.listMachines()) ?? [];
    this.machines = machines;
    for (const key of [...this.docs.keys()]) if (key !== '' && !machines.includes(key)) this.docs.delete(key);
    await Promise.all(['', ...machines].map((m) => this.fetchDoc(m, gen)));
  }

  /** A machine added or removed while we run brings its spaces in or takes them out. */
  private async pollMachines(): Promise<void> {
    if (!this.subscribed || !this.client.connected) return;
    const gen = this.generation;
    const machines = await this.listMachines();
    if (machines === null || gen !== this.generation) return;
    const same = machines.length === this.machines.length && machines.every((m) => this.machines.includes(m));
    if (!same) await this.refetchDocs(gen);
  }

  /** One doc.get per machine at a time (a change meanwhile fetches again after it), newest version wins. */
  private async fetchDoc(machine: string, gen: number): Promise<void> {
    const inFlight = this.docFetches.get(machine);
    if (inFlight) {
      inFlight.again = true;
      return;
    }
    const state = { again: false };
    this.docFetches.set(machine, state);
    try {
      do {
        state.again = false;
        const params: Record<string, unknown> = { name: LAYOUT_DOC };
        if (machine) params.on = machine;
        const r = await this.client.call<{ value: unknown; version: number }>('doc.get', params);
        if (gen !== this.generation) return;
        const have = this.docs.get(machine);
        // Versions restart with a new core process (generation): only compare within one.
        if (have && have.gen === gen && r.version < have.version) continue;
        this.docs.set(machine, { version: r.version, doc: asLayoutDoc(r.value), gen });
        this.scheduleRebuild();
      } while (state.again && gen === this.generation);
    } catch (err) {
      this.log.warn({ machine: machine || 'local', err: (err as Error).message }, 'doc.get herdr-app failed');
    } finally {
      if (this.docFetches.get(machine) === state) this.docFetches.delete(machine);
    }
  }

  // ---- rebuild ----

  private scheduleRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    setImmediate(() => {
      this.rebuildQueued = false;
      this.rebuild();
    });
  }

  private rebuild(): void {
    const haveListing = this.subscribed || this.table.size > 0;
    const hello = this.client.hello;
    const docs = [...this.docs.entries()]
      .sort(([a], [b]) => (a === b ? 0 : a === '' ? -1 : b === '' ? 1 : a < b ? -1 : 1))
      .map(([m, d]) => ({ machine: m === '' ? null : m, doc: d.doc }));
    const next = deriveWorld({
      core: { connected: this.client.connected, version: hello?.version ?? null, name: hello?.core?.name ?? null },
      docs,
      terminals: this.table,
      // model.rs `set_word`: an agent first heard of starts seen.
      seenLocally: (id) => this.agents.get(id)?.seen ?? true,
      home: this.home,
      checkoutTop: (f) => this.checkout.top(f),
      remoteCheckoutTop: (m, f) => this.remote.top(m, f),
      includeUnplaced: this.includeUnplaced,
      ...(this.spaceColor ? { spaceColor: this.spaceColor } : {}),
      ...(this.statusSince ? { statusSince: this.statusSince } : {}),
      ...(this.transcriptOf ? { transcriptOf: this.transcriptOf } : {}),
      ...(this.accountOf ? { accountOf: this.accountOf } : {}),
      agentName: this.agentName,
    });
    const ops = diffWorld(this.current, next);
    this.current = next;
    if (ops.length > 0) this.emit('patch', ops, next);
    // The first listing needs both the snapshot and the layout doc, else nothing has a pane yet.
    if (haveListing && this.docs.has('')) this.listedOnce = true;
    // The first listing is decided at once (it only records what was already so); then on the tick.
    if (this.listedOnce && !this.decidedListed) this.decide();
    else if (this.undecided()) this.scheduleTick();
  }

  /** Some word or placement differs from the last decision. */
  private undecided(): boolean {
    for (const t of this.table.all()) {
      const a = this.agents.get(t.address);
      if (!a || a.word !== wordOf(t) || a.placed !== Boolean(this.current.terminals[t.address]?.paneId)) return true;
    }
    return this.agents.size > this.table.size;
  }

  private scheduleTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.decide();
    }, this.tickMs);
    this.tickTimer.unref();
  }

  /**
   * The desktop's tick (window.rs `tend_terminals`, every 500 ms): apply what each word means now
   * (model.rs `set_word` seen rules), then announce the changes since the last tick. A flap inside
   * one tick is never seen; changes made before the first listing aren't news (`listed_once`).
   */
  private decide(): void {
    const changes: Array<{ id: string; prev: string | null; next: string | null; turn: number; sub: boolean }> = [];
    const announce = this.decidedListed;
    for (const t of this.table.all()) {
      const next = wordOf(t);
      const placed = Boolean(this.current.terminals[t.address]?.paneId);
      const a = this.agents.get(t.address) ?? { word: null, app: null, seen: true, placed };
      a.app = appOf(t) ?? a.app;
      if (a.word !== next) {
        changes.push({ id: t.address, prev: a.word, next, turn: t.turn ?? 0, sub: Boolean(t.parent) });
        const wasBusy = a.word === 'working' || a.word === 'blocked';
        if (next === 'working' || next === 'blocked') a.seen = true;
        else if (next !== null && wasBusy) a.seen = this.isLooking(t.address);
        a.word = next;
      } else if (placed && !a.placed && next === 'blocked') {
        // window.rs places terminals before deciding: one blocked before its pane arrived rings once it has one.
        changes.push({ id: t.address, prev: null, next, turn: t.turn ?? 0, sub: Boolean(t.parent) });
      }
      a.placed = placed;
      this.agents.set(t.address, a);
    }
    for (const id of [...this.agents.keys()]) if (!this.table.get(id)) this.agents.delete(id);
    if (this.listedOnce) this.decidedListed = true;
    if (changes.length === 0) return;
    // Seen flags changed what some agents show.
    this.rebuild();
    if (!announce) return;
    const world = this.current;
    const transitions: WordTransition[] = changes.map((c) => {
      const view = world.terminals[c.id];
      // A sub-agent lives where its top agent does.
      const space = view?.spaceId ? world.spaces[view.spaceId] : undefined;
      const tab = view?.tabId ? world.tabs[view.tabId] : undefined;
      const t = this.table.get(c.id);
      const app = this.agents.get(c.id)?.app ?? null;
      return {
        terminalId: c.id,
        prev: c.prev,
        next: c.next,
        turn: c.turn,
        subAgent: c.sub,
        hasPane: Boolean(view?.paneId),
        looking: this.isLooking(c.id),
        name: t?.name || (app ? this.agentName(app) : null),
        place: space && tab ? `${space.name} / ${tab.name}` : null,
      };
    });
    this.emit('transitions', transitions);
  }
}

function sameIds(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((id) => a.has(id));
}
