import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { NewTabResult, NewTabStart, SpaceSessions, SpaceView, TerminalView, World } from '@herdr-mobile/protocol';
import { branchNameError } from '@herdr-mobile/protocol';
import { allowResume, expectRun, markStartedTab, SPAWN_ENV, unexpectRun } from '../core/policy.js';
import { type Logger, silentLogger } from '../log.js';
import { projectDirName } from '../transcripts/claude.js';
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
    let folder = start.kind === 'branch' ? '' : this.folderOf(space);
    let argv: string[] = [];
    let name = '';
    let config: ClaudeConfig | null = null;
    if (start.kind === 'branch') {
      const offer = await this.claudeOffer();
      if (!offer) throw new CreateError('Claude Code isn’t installed on this computer', 400);
      const b = this.branchSource(space, start.terminal);
      folder = b.folder;
      config = b.config;
      name = start.name;
      argv = claudeArgv(offer.argv, config, ['--resume', b.session, '--fork-session', '--name', start.name]);
      allowResume(offer.argv);
    } else if (start.kind !== 'shell') {
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
        argv = claudeArgv(offer.argv, config, ['--resume', start.session]);
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

  /**
   * What a branch of `terminalId`'s conversation resumes: its session (the transcript the world
   * shows for it), the login its `claude` runs under (CLAUDE_CONFIG_DIR of its process; not running:
   * the session's owner, as a resume picks), and the folder whose project folder holds it for that
   * login (the agent's live folder, else the transcript's, else the space's), where `--resume` finds it.
   */
  private branchSource(space: SpaceView, terminalId: string): { session: string; config: ClaudeConfig; folder: string } {
    const t: TerminalView | undefined = this.opts.store.world.terminals[terminalId];
    if (!t || t.spaceId !== space.id) throw new CreateError('That agent isn’t in this space any more', 404);
    if (t.machine !== null || t.program !== 'claude' || !t.transcript) {
      throw new CreateError('Only a Claude Code conversation on this computer can be branched', 400);
    }
    const session = path.basename(t.transcript, '.jsonl');
    if (!SESSION_ID.test(session)) throw new CreateError('Can’t tell which Claude session this is', 400);
    const configs = this.opts.sessions.configs();
    const running = this.opts.sessions.runningConfig(session, configs);
    if (running === null) throw new CreateError('This conversation’s Claude login isn’t one the bridge knows', 400);
    const candidates = [t.cwd, this.opts.sessions.summaries.get(t.transcript)?.cwd ?? null, space.folder];
    for (const c of candidates) {
      if (!c?.startsWith('/')) continue;
      let real: string;
      try {
        real = fs.realpathSync(c);
        if (!fs.statSync(real).isDirectory()) continue;
      } catch {
        continue;
      }
      if (path.basename(path.dirname(t.transcript)) !== projectDirName(real)) continue;
      const config = this.opts.sessions.resolve(real, session, running?.id, configs);
      if (config) return { session, config, folder: real };
    }
    throw new CreateError('Can’t find this conversation’s folder, so Claude couldn’t resume it', 409);
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

/**
 * Claude Code as the + menu starts it (window.rs `agent_argv`: the program in the interactive shell,
 * which stays after it), with `env CLAUDE_CONFIG_DIR=<dir>` before the program for a non-default
 * login, then `args`. Every argument stays one argv element: the shell gets them as "$@".
 */
export function claudeArgv(offer: readonly string[], config: ClaudeConfig, args: readonly string[]): string[] {
  const [wrapper, program] = [offer.slice(0, 4), offer.slice(4)];
  return [...wrapper, ...(config.isDefault ? [] : ['env', `CLAUDE_CONFIG_DIR=${config.dir}`]), ...program, ...args];
}

/**
 * `{start: {kind: 'shell' | 'claude'}}`, `{start: {kind: 'resume', session: <uuid>, config?: '.claude…'}}`
 * or `{start: {kind: 'branch', terminal: <id>, name}}`, nothing else.
 */
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
  if (o.kind === 'branch' && keys === 'kind,name,terminal') {
    if (typeof o.terminal !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.terminal)) throw bad();
    if (typeof o.name !== 'string') throw new CreateError('Give it a name', 400, 'name');
    const why = branchNameError(o.name);
    if (why) throw new CreateError(why, 400, 'name');
    return { kind: 'branch', terminal: o.terminal, name: o.name };
  }
  if (o.kind === 'resume' && (keys === 'kind,session' || keys === 'config,kind,session')) {
    if (typeof o.session !== 'string' || !SESSION_ID.test(o.session)) throw new CreateError('That isn’t a Claude session id', 400, 'start');
    if (o.config === undefined) return { kind: 'resume', session: o.session };
    if (typeof o.config !== 'string' || !/^\.claude(-[A-Za-z0-9._-]{1,64})?$/.test(o.config)) throw bad();
    return { kind: 'resume', session: o.session, config: o.config };
  }
  throw bad();
}
