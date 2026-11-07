import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import {
  type NewSpaceError,
  type NewSpaceOptions,
  type NewSpaceRequest,
  type NewSpaceResult,
  SPACE_NAME_MAX,
  type StartChoice,
  type World,
} from '@herdr-mobile/protocol';
import { allowLaunches, expectRun, markStarted, SPAWN_ENV, unexpectRun } from '../core/policy.js';
import { type Logger, silentLogger } from '../log.js';
import { agentArgv, agentChoices, type InstalledAgents, type Startable, startable } from './agents.js';
import type { HerdrApp } from './app.js';
import { checkFolder, FolderError, folderChoices, recentSpaces } from './folders.js';

export class CreateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: NewSpaceError['field'],
  ) {
    super(message);
  }
}

interface Core {
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface SpaceCreatorOptions {
  core: Core;
  /** The world and its `patch` events (to see Herdr adopt the new space). */
  store: Pick<EventEmitter, 'on' | 'off'> & { readonly world: World };
  app: Pick<HerdrApp, 'isOpen' | 'renameSpace'>;
  installed: Pick<InstalledAgents, 'check'>;
  home: string;
  herdrAppDir: string;
  shell: string;
  logger?: Logger;
  /** How long Herdr has to adopt the terminal before it is ended again. */
  adoptTimeoutMs?: number;
  /** At most this many spaces per `windowMs`. */
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
}

export interface Offer {
  choice: StartChoice;
  argv: string[];
}

/** herdr-app's fresh ids (model.rs `fresh_id`): prefix + 32 hex digits. */
export const freshId = (prefix: string) => prefix + randomBytes(16).toString('hex');
const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Makes a space the way the desktop's `space.new` ends up: its first terminal started in the
 * folder with Herdr's labels (fresh `herdr.space`/`herdr.tab` ids, `herdr.seen=0`), kept, with
 * herdr-app's env, an agent in the interactive shell. The Herdr window adopts it (window.rs
 * `reconcile`/`adopt`), appending the space and writing its own document; a name is given
 * through the window's `space.rename`. The bridge never writes Herdr's document.
 */
export class SpaceCreator {
  private readonly log: Logger;
  private readonly times: number[] = [];
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly opts: SpaceCreatorOptions) {
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  async options(): Promise<NewSpaceOptions> {
    const [offers, appOpen] = await Promise.all([this.offers(), this.opts.app.isOpen()]);
    return {
      home: this.opts.home,
      appOpen,
      folders: folderChoices(this.opts.store.world, recentSpaces(this.opts.herdrAppDir), this.opts.home),
      starts: offers.map((o) => o.choice),
    };
  }

  /** The + menu's agents (installed first, two missing ones greyed) and the core's templates. */
  async offers(): Promise<Offer[]> {
    const list: Startable[] = startable(this.opts.herdrAppDir);
    const commands = [...new Set(list.map((s) => s.run[0] as string))];
    const [found, templates] = await Promise.all([this.opts.installed.check(commands), this.templates()]);
    const byKey = new Map(list.map((s) => [s.key, s]));
    const offers: Offer[] = agentChoices(list, found).map((choice) => ({
      choice,
      argv: agentArgv(this.opts.shell, byKey.get(choice.key)?.run ?? []),
    }));
    for (const t of templates) {
      offers.push({ choice: { kind: 'template', key: t.name, name: t.name, installed: true, description: t.description }, argv: [t.name] });
    }
    allowLaunches(offers.filter((o) => o.choice.installed).map((o) => o.argv));
    return offers;
  }

  private async templates(): Promise<Array<{ name: string; description: string }>> {
    try {
      const r = await this.opts.core.call<{ templates?: Array<{ name?: unknown; description?: unknown; error?: unknown }> }>(
        'templates.list',
      );
      return (r.templates ?? [])
        .filter((t) => typeof t.name === 'string' && TEMPLATE.test(t.name) && !t.error)
        .map((t) => ({ name: t.name as string, description: typeof t.description === 'string' ? t.description.slice(0, 200) : '' }));
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, 'templates.list failed');
      return [];
    }
  }

  async create(body: unknown): Promise<NewSpaceResult> {
    const req = parseRequest(body);
    if (this.busy) throw new CreateError('Already making a space', 429);
    const now = this.now();
    const windowMs = this.opts.windowMs ?? 10 * 60_000;
    while (this.times.length && now - (this.times[0] as number) > windowMs) this.times.shift();
    if (this.times.length >= (this.opts.maxPerWindow ?? 6))
      throw new CreateError('Too many new spaces for now; try again in a few minutes', 429);
    this.busy = true;
    try {
      return await this.make(req);
    } finally {
      this.busy = false;
    }
  }

  private async make(req: ParsedRequest): Promise<NewSpaceResult> {
    const world = this.opts.store.world;
    const known = [
      ...world.spaceOrder.map((id) => world.spaces[id]).flatMap((s) => (s && s.machine === null ? [s.folder] : [])),
      ...recentSpaces(this.opts.herdrAppDir).map((r) => r.folder),
    ];
    let folder: string;
    try {
      folder = checkFolder(req.folder, this.opts.home, known);
    } catch (e) {
      if (e instanceof FolderError) throw new CreateError(e.message, 400, 'folder');
      throw e;
    }
    let argv: string[] = [];
    if (req.start.kind !== 'shell') {
      const key = req.start.kind === 'agent' ? req.start.key : req.start.name;
      const offer = (await this.offers()).find((o) => o.choice.kind === req.start.kind && o.choice.key === key);
      if (!offer) throw new CreateError('Herdr doesn’t offer that here', 400, 'start');
      if (!offer.choice.installed) throw new CreateError(`${offer.choice.name} isn’t installed on this computer`, 400, 'start');
      argv = offer.argv;
    }
    if (!(await this.opts.app.isOpen())) {
      throw new CreateError('Herdr isn’t open on the computer: open it, then try again (it makes the space)', 409);
    }
    this.times.push(this.now());

    const spaceId = freshId('sp');
    const tabId = freshId('tb');
    const params: Record<string, unknown> = {
      argv,
      cwd: folder,
      env: { ...SPAWN_ENV },
      labels: { 'herdr.space': spaceId, 'herdr.tab': tabId, 'herdr.seen': '0' },
      keep: true,
    };
    const size = paneSize(world);
    if (size) params.size = size;
    const appearing = this.waitForSpace(spaceId);
    let address: string;
    expectRun(spaceId, tabId, argv);
    try {
      const r = await this.opts.core.call<{ address?: string }>('terminal.run', params, 15_000);
      if (typeof r.address !== 'string') throw new Error('no address');
      address = r.address;
    } catch (e) {
      unexpectRun(spaceId, tabId);
      appearing.cancel();
      this.log.warn({ err: (e as Error).message }, 'new space: terminal.run failed');
      throw new CreateError(`Couldn’t start a terminal there: ${(e as Error).message}`, 502);
    }
    markStarted(address, spaceId);
    this.log.info({ space: spaceId, terminal: address, folder, start: req.start.kind }, 'new space started; waiting for Herdr to show it');
    if (!(await appearing.promise)) {
      await this.end(address);
      throw new CreateError('Herdr didn’t pick up the new space, so it was closed again. Is Herdr open?', 504);
    }
    if (req.name) {
      try {
        await this.opts.app.renameSpace(spaceId, req.name);
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'new space: naming it failed');
      }
    }
    return { spaceId, tabId, terminalId: address };
  }

  /** Resolves true once the world shows the space (Herdr adopted the terminal), false after the timeout. */
  private waitForSpace(spaceId: string): { promise: Promise<boolean>; cancel: () => void } {
    const store = this.opts.store;
    let finish: (v: boolean) => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const check = () => {
      if (store.world.spaces[spaceId]) stop(true);
    };
    const timer = setTimeout(() => stop(false), this.opts.adoptTimeoutMs ?? 10_000);
    const stop = (v: boolean) => {
      clearTimeout(timer);
      store.off('patch', check);
      finish(v);
    };
    store.on('patch', check);
    return { promise, cancel: () => stop(false) };
  }

  /** A terminal Herdr never adopted: end it and remove it, so nothing is left behind. */
  private async end(address: string): Promise<void> {
    try {
      await this.opts.core.call('terminal.kill', { terminal: address }, 10_000);
    } catch (e) {
      this.log.warn({ err: (e as Error).message, terminal: address }, 'new space: kill failed');
    }
    try {
      await this.opts.core.call('terminal.rm', { terminal: address }, 5000);
    } catch (e) {
      this.log.warn({ err: (e as Error).message, terminal: address }, 'new space: rm failed');
    }
  }
}

interface ParsedRequest extends NewSpaceRequest {
  name: string;
}

/** Shape and limits of a request body (the folder itself is checked on disk later). */
export function parseRequest(body: unknown): ParsedRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CreateError('Bad request', 400);
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (!['folder', 'name', 'start'].includes(k)) throw new CreateError(`Unknown field ${k.slice(0, 20)}`, 400);
  if (typeof b.folder !== 'string') throw new CreateError('Pick a folder', 400, 'folder');
  if (b.name !== undefined && typeof b.name !== 'string') throw new CreateError('Bad name', 400, 'name');
  const name = ((b.name as string | undefined) ?? '').trim();
  if (name.length > SPACE_NAME_MAX) throw new CreateError(`Names are at most ${SPACE_NAME_MAX} characters`, 400, 'name');
  if (CONTROL.test(name)) throw new CreateError('Names can’t have control characters', 400, 'name');
  const s = b.start as Record<string, unknown> | undefined;
  let start: NewSpaceRequest['start'];
  if (s && typeof s === 'object' && s.kind === 'shell' && Object.keys(s).length === 1) start = { kind: 'shell' };
  else if (
    s &&
    typeof s === 'object' &&
    s.kind === 'agent' &&
    typeof s.key === 'string' &&
    TEMPLATE.test(s.key) &&
    Object.keys(s).length === 2
  )
    start = { kind: 'agent', key: s.key };
  else if (
    s &&
    typeof s === 'object' &&
    s.kind === 'template' &&
    typeof s.name === 'string' &&
    TEMPLATE.test(s.name) &&
    Object.keys(s).length === 2
  )
    start = { kind: 'template', name: s.name };
  else throw new CreateError('Pick what to start', 400, 'start');
  return { folder: b.folder, name, start };
}

/**
 * The size a new space's only pane gets on the desktop (window.rs `initial_size`): the grid of a
 * terminal that is alone in its tab here, the most common one; none known: the core's default
 * until the desktop shows it.
 */
export function paneSize(world: World): { cols: number; rows: number } | null {
  const counts = new Map<string, number>();
  for (const tab of Object.values(world.tabs)) {
    if (tab.panes.length !== 1) continue;
    const t = tab.panes[0]?.terminalId ? world.terminals[tab.panes[0].terminalId] : undefined;
    if (!t || t.machine !== null || !(t.cols > 0) || !(t.rows > 0)) continue;
    const k = `${t.cols}x${t.rows}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [k, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = k;
  if (!best) return null;
  const [cols, rows] = best.split('x').map(Number) as [number, number];
  return { cols, rows };
}
