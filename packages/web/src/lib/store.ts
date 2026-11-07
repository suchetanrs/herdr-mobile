import {
  type AttentionAlert,
  applyPatch,
  type ConversationServerMessage,
  emptyWorld,
  type PatchOp,
  type ServerMessage,
  type TerminalServerMessage,
  type TerminalView,
  type World,
} from '@herdr-mobile/protocol';
import { load, save } from './storage';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

export interface ConnState {
  status: ConnStatus;
  /** Failed attempts since the last good connection. */
  attempt: number;
  /** When the next attempt starts (ms since the epoch), while waiting. */
  retryAt: number | null;
  /** Round trip of the last ping, ms. */
  rttMs: number | null;
  /** The page has had a world from the bridge at least once (so there is something to keep showing). */
  everSynced: boolean;
  /** When the connection was lost (what's shown is as of then); null while connected. */
  lostAt: number | null;
  /** The device says it has no network. */
  offline: boolean;
}

export interface AlertEntry extends AttentionAlert {
  read: boolean;
}

export interface AppState {
  /** The bridge's world, exactly. */
  world: World;
  /**
   * The world as screens show it: the same object as `world`, except that it keeps its identity
   * across patches that only change terminals' grid sizes (the desktop sends one per pane on every
   * window resize, and no list shows a size), so those don't re-render the screens.
   */
  view: World;
  seq: number;
  serverId: string | null;
  /** The web build the bridge serves now (from `welcome`); null until heard or from an older bridge. */
  serverBuild: string | null;
  conn: ConnState;
  /** Newest first. */
  alerts: AlertEntry[];
}

const MAX_ALERTS = 100;
const READ_KEY = 'alerts.read';

/** The world after `ops`, as a new object (and new maps for what changed) so React sees the change. */
export function patchWorld(world: World, ops: readonly PatchOp[]): World {
  const next: World = { ...world };
  const touched = new Set(ops.map((o) => o.op));
  if (touched.has('space') || touched.has('delSpace')) next.spaces = { ...world.spaces };
  if (touched.has('tab') || touched.has('delTab')) next.tabs = { ...world.tabs };
  if (touched.has('terminal') || touched.has('delTerminal')) next.terminals = { ...world.terminals };
  return applyPatch(next, ops);
}

/** Whether `next` differs from `prev` only in its grid size. */
export function sizeOnlyChange(prev: TerminalView | undefined, next: TerminalView): boolean {
  if (!prev) return false;
  if (prev.cols === next.cols && prev.rows === next.rows) return false;
  return JSON.stringify({ ...prev, cols: 0, rows: 0 }) === JSON.stringify({ ...next, cols: 0, rows: 0 });
}

/** Ops that only resize terminals (nothing a screen shows). */
export function sizeOnlyPatch(world: World, ops: readonly PatchOp[]): boolean {
  return ops.length > 0 && ops.every((o) => o.op === 'terminal' && sizeOnlyChange(world.terminals[o.value.id], o.value));
}

type Listener = () => void;
type AlertListener = (alert: AttentionAlert, live: boolean) => void;
type TermListener = (m: TerminalServerMessage) => void;
type ConvListener = (m: ConversationServerMessage) => void;

/**
 * The page's copy of the bridge's world plus connection and alert state.
 * Fed by `Connection` with server messages; read by React through
 * `useSyncExternalStore`. Pure state: no sockets, no DOM.
 */
export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<Listener>();
  private readonly alertListeners = new Set<AlertListener>();
  private readonly termListeners = new Set<TermListener>();
  private readonly convListeners = new Set<ConvListener>();
  private readonly readIds: Set<string>;

  constructor() {
    this.readIds = new Set(load<string[]>(READ_KEY, []));
    const world = emptyWorld();
    this.state = {
      world,
      view: world,
      seq: 0,
      serverId: null,
      serverBuild: null,
      conn: { status: 'connecting', attempt: 0, retryAt: null, rttMs: null, everSynced: false, lostAt: null, offline: false },
      alerts: [],
    };
  }

  getState = (): AppState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  onAlert(l: AlertListener): () => void {
    this.alertListeners.add(l);
    return () => this.alertListeners.delete(l);
  }

  onTerminal(l: TermListener): () => void {
    this.termListeners.add(l);
    return () => this.termListeners.delete(l);
  }

  onConversation(l: ConvListener): () => void {
    this.convListeners.add(l);
    return () => this.convListeners.delete(l);
  }

  setConn(patch: Partial<ConnState>): void {
    this.set({ conn: { ...this.state.conn, ...patch } });
  }

  /** Where to resume from after a reconnect (null: ask for a snapshot). */
  resumePoint(): { serverId: string; seq: number } | null {
    return this.state.serverId && this.state.conn.everSynced ? { serverId: this.state.serverId, seq: this.state.seq } : null;
  }

  /** Forget the resume point: the next connection starts from a fresh snapshot. */
  dropResume(): void {
    this.set({ serverId: null });
  }

  /**
   * Applies one server message. Returns 'gap' when a numbered message doesn't
   * follow the last one (the caller reconnects for a fresh snapshot).
   */
  handle(m: ServerMessage): 'ok' | 'gap' {
    switch (m.t) {
      case 'welcome':
        if (this.state.serverId !== m.serverId) this.set({ serverId: m.serverId, seq: 0 });
        if ((m.build ?? null) !== this.state.serverBuild) this.set({ serverBuild: m.build ?? null });
        return 'ok';
      case 'snapshot': {
        const alerts = this.mergeAlerts(m.alerts);
        this.set({ world: m.world, view: m.world, seq: m.seq, alerts, conn: { ...this.state.conn, everSynced: true } });
        return 'ok';
      }
      case 'patch': {
        if (m.seq !== this.state.seq + 1) return 'gap';
        const resizeOnly = sizeOnlyPatch(this.state.world, m.ops);
        const world = patchWorld(this.state.world, m.ops);
        this.set({ world, view: resizeOnly ? this.state.view : world, seq: m.seq });
        return 'ok';
      }
      case 'alert': {
        if (m.seq !== this.state.seq + 1) return 'gap';
        const known = this.state.alerts.some((a) => a.id === m.alert.id);
        this.set({ seq: m.seq, alerts: known ? this.state.alerts : this.mergeAlerts([m.alert]) });
        if (!known) for (const l of this.alertListeners) l(m.alert, true);
        return 'ok';
      }
      case 'hb':
        // Messages arrive in order: a heartbeat ahead of us means one went missing.
        return this.state.conn.everSynced && m.seq > this.state.seq ? 'gap' : 'ok';
      case 'error':
        return 'ok';
      default:
        if (m.t.startsWith('conv.')) for (const l of this.convListeners) l(m as ConversationServerMessage);
        else for (const l of this.termListeners) l(m as TerminalServerMessage);
        return 'ok';
    }
  }

  markAlertsRead(ids?: readonly string[]): void {
    const which = new Set(ids ?? this.state.alerts.map((a) => a.id));
    let changed = false;
    const alerts = this.state.alerts.map((a) => {
      if (a.read || !which.has(a.id)) return a;
      changed = true;
      this.readIds.add(a.id);
      return { ...a, read: true };
    });
    if (!changed) return;
    // Only remember ids still listed, so the set stays small.
    save(
      READ_KEY,
      alerts.filter((a) => a.read).map((a) => a.id),
    );
    this.set({ alerts });
  }

  clearAlerts(): void {
    for (const a of this.state.alerts) this.readIds.add(a.id);
    save(READ_KEY, []);
    this.set({ alerts: [] });
  }

  private mergeAlerts(incoming: readonly AttentionAlert[]): AlertEntry[] {
    const byId = new Map(this.state.alerts.map((a) => [a.id, a]));
    for (const a of incoming) if (!byId.has(a.id)) byId.set(a.id, { ...a, read: this.readIds.has(a.id) });
    return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ALERTS);
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
