import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { NewTabResult, NewTabStart, SpaceSessions, SpaceView, World } from '@herdr-mobile/protocol';
import { allowResume, expectRun, markStartedTab, SPAWN_ENV, unexpectRun } from '../core/policy.js';
import { type Logger, silentLogger } from '../log.js';
import type { HerdrApp } from './app.js';
import { CreateError, freshId, type Offer, paneSize } from './create.js';
import { display } from './folders.js';
import { type ClaudeConfig, type ClaudeSessions, SESSION_ID } from './sessions.js';

interface Core {
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface TabCreatorOptions {
  core: Core;
  store: Pick<EventEmitter, 'on' | 'off'> & { readonly world: World };
  app: Pick<HerdrApp, 'isOpen' | 'renameTab'>;
  /** The + menu's offers (SpaceCreator.offers): Claude Code's launch comes from there. */
  offers: () => Promise<Offer[]>;
  sessions: ClaudeSessions;
  home: string;
  logger?: Logger;
  adoptTimeoutMs?: number;
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * A new tab in a space Herdr shows, the way the desktop's + menu makes one (window.rs `new_tab`
 * -> `spawn`): a terminal in the space's folder with the space's `herdr.space` id, a fresh
 * `herdr.tab` id, `herdr.seen=0`, kept, herdr-app's env; the Herdr window adopts it as a new tab
 * of that space (`adopt`). Agent tabs get the agent's name, as the + menu names them (`tab.rename`).
 * Differences from `tab.new`, on purpose: the desktop keeps showing what it showed.
 */
export class TabCreator {
  private readonly log: Logger;
  private readonly times: number[] = [];
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly opts: TabCreatorOptions) {
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  /** A space this machine shows (local, open). */
  private space(spaceId: string): SpaceView {
    const s = this.opts.store.world.spaces[spaceId];
    if (!s) throw new CreateError('That space isn’t open any more', 404);
    if (s.machine !== null) throw new CreateError('New tabs only in this computer’s spaces', 400);
    return s;
  }

  /**
   * Where its new tabs start (window.rs `folder_for`): the live folder of its terminal (the bridge
   * can't see which pane the desktop focuses: its first one), else the space's folder.
   */
  folderOf(space: SpaceView): string {
    const world = this.opts.store.world;
    const first = space.tabIds.flatMap((id) => world.tabs[id]?.panes ?? []).find((p) => p.terminalId)?.terminalId;
    const candidates = [first ? world.terminals[first]?.cwd : null, space.folder];
    for (const c of candidates) {
      if (!c?.startsWith('/')) continue;
      try {
        const real = fs.realpathSync(c);
        if (fs.statSync(real).isDirectory()) return real;
      } catch {}
    }
    throw new CreateError('This space’s folder is gone', 409);
  }

  private async claudeOffer(): Promise<Offer | null> {
    const offer = (await this.opts.offers()).find((o) => o.choice.kind === 'agent' && o.choice.key === 'claude');
    return offer?.choice.installed ? offer : null;
  }

  async sessions(spaceId: string): Promise<SpaceSessions> {
    const space = this.space(spaceId);
    const folder = this.folderOf(space);
    const [appOpen, claude] = await Promise.all([this.opts.app.isOpen(), this.claudeOffer()]);
    const configs = this.opts.sessions.configs();
    const sessions = this.opts.sessions.list(folder, this.opts.store.world, configs);
    // Only the configs that hold sessions here can resume them; with none, all (nothing to pick).
    const stores = new Set(sessions.map((s) => configs.find((c) => c.id === s.config)?.projects));
    const usable = configs.filter((c) => stores.has(c.projects));
    return {
      folder,
      display: display(folder, this.opts.home),
      appOpen,
      claudeInstalled: Boolean(claude),
      configs: this.opts.sessions.choices(usable.length ? usable : configs),
      sessions,
    };
  }

  async create(spaceId: string, body: unknown): Promise<NewTabResult> {
    const start = parseTabRequest(body);
    if (this.busy) throw new CreateError('Already opening a tab', 429);
    const now = this.now();
    const windowMs = this.opts.windowMs ?? 10 * 60_000;
    while (this.times.length && now - (this.times[0] as number) > windowMs) this.times.shift();
    if (this.times.length >= (this.opts.maxPerWindow ?? 6))
      throw new CreateError('Too many new tabs for now; try again in a few minutes', 429);
    this.busy = true;
    try {
      return await this.make(spaceId, start);
    } finally {
      this.busy = false;
    }
  }

  private async make(spaceId: string, start: NewTabStart): Promise<NewTabResult> {
    const space = this.space(spaceId);
    const folder = this.folderOf(space);
    let argv: string[] = [];
    let name = '';
    let config: ClaudeConfig | null = null;
    if (start.kind !== 'shell') {
      const offer = await this.claudeOffer();
      if (!offer) throw new CreateError('Claude Code isn’t installed on this computer', 400);
      name = offer.choice.name;
      if (start.kind === 'claude') {
        argv = offer.argv;
      } else {
        config = this.opts.sessions.resolve(folder, start.session, start.config);
        if (!config) throw new CreateError('That session isn’t in this folder (or that login can’t see it)', 400);
        const open = this.opts.sessions
          .list(folder, this.opts.store.world)
          .find((s) => s.id === start.session && (s.openIn || s.runningElsewhere));
        if (open || this.opts.sessions.isRunning(start.session)) throw new CreateError('That session is already open', 409);
        // window.rs `agent_argv`: the program in the interactive shell, which stays after it.
        const [wrapper, program] = [offer.argv.slice(0, 4), offer.argv.slice(4)];
        argv = [...wrapper, ...(config.isDefault ? [] : ['env', `CLAUDE_CONFIG_DIR=${config.dir}`]), ...program, '--resume', start.session];
        allowResume(offer.argv);
      }
    }
    if (!(await this.opts.app.isOpen())) {
      throw new CreateError('Herdr isn’t open on the computer: open it, then try again (it adds the tab)', 409);
    }
    this.times.push(this.now());

    const tabId = freshId('tb');
    const params: Record<string, unknown> = {
      argv,
      cwd: folder,
      env: { ...SPAWN_ENV },
      labels: { 'herdr.space': spaceId, 'herdr.tab': tabId, 'herdr.seen': '0' },
      keep: true,
    };
    const size = spaceSize(this.opts.store.world, space) ?? paneSize(this.opts.store.world);
    if (size) params.size = size;
    expectRun(spaceId, tabId, argv, config?.dir);
    let address: string;
    try {
      const r = await this.opts.core.call<{ address?: string }>('terminal.run', params, 15_000);
      if (typeof r.address !== 'string') throw new Error('no address');
      address = r.address;
    } catch (e) {
      unexpectRun(spaceId, tabId);
      this.log.warn({ err: (e as Error).message }, 'new tab: terminal.run failed');
      throw new CreateError(`Couldn’t start a terminal there: ${(e as Error).message}`, 502);
    }
    markStartedTab(address, tabId);
    this.log.info({ space: spaceId, tab: tabId, terminal: address, start: start.kind }, 'new tab started; waiting for Herdr to show it');
    if (!(await this.adopted(address, tabId))) {
      await this.end(address);
      throw new CreateError('Herdr didn’t pick up the new tab, so it was closed again. Is Herdr open?', 504);
    }
    if (name) {
      try {
        await this.opts.app.renameTab(tabId, name);
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'new tab: naming it failed');
      }
    }
    return { spaceId, tabId, terminalId: address };
  }

  /** True once the world shows the terminal in its new tab, false after the timeout. */
  private adopted(address: string, tabId: string): Promise<boolean> {
    const store = this.opts.store;
    return new Promise((resolve) => {
      const check = () => {
        if (store.world.terminals[address]?.tabId === tabId) stop(true);
      };
      const timer = setTimeout(() => stop(false), this.opts.adoptTimeoutMs ?? 10_000);
      const stop = (v: boolean) => {
        clearTimeout(timer);
        store.off('patch', check);
        resolve(v);
      };
      store.on('patch', check);
      check();
    });
  }

  private async end(address: string): Promise<void> {
    for (const [method, ms] of [
      ['terminal.kill', 10_000],
      ['terminal.rm', 5000],
    ] as const) {
      try {
        await this.opts.core.call(method, { terminal: address }, ms);
      } catch (e) {
        this.log.warn({ err: (e as Error).message, terminal: address }, `new tab: ${method} failed`);
      }
    }
  }
}

/** The grid of a terminal alone in its tab in this space (the most common), if any. */
function spaceSize(world: World, space: SpaceView): { cols: number; rows: number } | null {
  return paneSize({ ...world, tabs: Object.fromEntries(space.tabIds.flatMap((id) => (world.tabs[id] ? [[id, world.tabs[id]]] : []))) });
}

/** `{start: {kind: 'shell' | 'claude'}}` or `{start: {kind: 'resume', session: <uuid>, config?: '.claude…'}}`, nothing else. */
export function parseTabRequest(body: unknown): NewTabStart {
  const bad = () => new CreateError('Pick what to open', 400, 'start');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CreateError('Bad request', 400);
  const b = body as Record<string, unknown>;
  if (Object.keys(b).join() !== 'start') throw bad();
  const s = b.start;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad();
  const o = s as Record<string, unknown>;
  const keys = Object.keys(o).sort().join();
  if ((o.kind === 'shell' || o.kind === 'claude') && keys === 'kind') return { kind: o.kind };
  if (o.kind === 'resume' && (keys === 'kind,session' || keys === 'config,kind,session')) {
    if (typeof o.session !== 'string' || !SESSION_ID.test(o.session)) throw new CreateError('That isn’t a Claude session id', 400, 'start');
    if (o.config === undefined) return { kind: 'resume', session: o.session };
    if (typeof o.config !== 'string' || !/^\.claude(-[A-Za-z0-9._-]{1,64})?$/.test(o.config)) throw bad();
    return { kind: 'resume', session: o.session, config: o.config };
  }
  throw bad();
}
