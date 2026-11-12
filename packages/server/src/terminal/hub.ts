import type { CoreClient } from '../core/client.js';
import { type Logger, silentLogger } from '../log.js';
import { encodeKeys, encodePaste, isAnswerKeys } from './keys.js';
import type { Subscriber } from './subscriber.js';
import { TerminalUpstream } from './upstream.js';

/** What the hub needs to know about a terminal from the world store. */
export interface TerminalFacts {
  /** The raw 7501 word (`blocked`, `working`, ...), null when it reports none. */
  word: string | null;
  turn: number;
  cols: number;
  rows: number;
}

export interface TerminalHubOptions {
  client: CoreClient;
  /** The terminal as the world store knows it; null when unknown. */
  facts: (terminalId: string) => TerminalFacts | null;
  logger?: Logger;
  coreHistory?: number;
  scrollback?: number;
  graceMs?: number;
  typingIdleMs?: number;
  /** Pause between a chat paste and its Enter (herdr-core's PASTE_GAP). */
  pasteGapMs?: number;
  /** The terminal submits with something other than Enter (a template's `submit`): chat send goes through the core. */
  customSubmit?: (terminalId: string) => boolean;
}

/**
 * History rows asked of herdr-core's first paint: all it keeps (it holds ~5 MB of rows per terminal, about
 * 3000 rows at 200 columns), with a ceiling so the paint stays well under the core's 4 MB per-viewer backlog.
 */
export const CORE_HISTORY = 10_000;
/** History rows the bridge's mirror keeps per open terminal (pages for `term.history`): ~14 MB at 200 columns. */
export const MIRROR_HISTORY = 6000;

/** How long and how many idempotency keys are remembered. */
const RECENT_MS = 10 * 60_000;
const RECENT_MAX = 2000;

/** herdr-core input.rs PASTE_GAP: so the program sees the paste and the Enter apart. */
export const PASTE_GAP_MS = 200;

/** A request the hub refuses, with the protocol's error code. */
export class TerminalInputError extends Error {
  constructor(
    readonly code: 'not_found' | 'bad_key' | 'not_blocked' | 'stale' | 'unavailable' | 'core_error',
    message: string,
  ) {
    super(message);
    this.name = 'TerminalInputError';
  }
}

/**
 * All live terminal streams: one shared upstream per terminal, opened on the
 * first viewer (or input) and closed `graceMs` after the last one left. Input
 * goes through each upstream's typing attach (raw bytes, named keys, answers)
 * or herdr-core's `terminal.send` (chat send).
 */
export class TerminalHub {
  private readonly ups = new Map<string, TerminalUpstream>();
  /** Per terminal: input runs one at a time, so a chat send's paste and Enter are never split by other input. */
  private readonly locks = new Map<string, Promise<void>>();
  /** Recent idempotency keys (`terminal\0id`) and the input they started. */
  private readonly recent = new Map<string, { done: Promise<void>; at: number }>();
  private readonly log: Logger;
  private readonly client: CoreClient;
  private readonly onReady = () => {
    for (const up of this.ups.values()) up.reconnect();
  };

  constructor(private readonly opts: TerminalHubOptions) {
    this.client = opts.client;
    this.log = opts.logger ?? silentLogger;
    this.client.on('ready', this.onReady);
  }

  /** Open upstreams (tests, health). */
  get streams(): number {
    return this.ups.size;
  }

  upstream(terminalId: string): TerminalUpstream | undefined {
    return this.ups.get(terminalId);
  }

  subscribe(sub: Subscriber, req: number): Promise<void> {
    return this.get(sub.terminalId).add(sub, req);
  }

  unsubscribe(sub: Subscriber): void {
    this.ups.get(sub.terminalId)?.remove(sub);
  }

  /**
   * Runs `run` at most once per (`terminalId`, `id`) within 10 min: a retry with the same id (after a
   * reconnect) waits for the first run and succeeds with it, instead of typing again. A failed run may be retried.
   */
  once(terminalId: string, id: string | undefined, run: () => Promise<void>): Promise<void> {
    if (id === undefined) return run();
    const now = Date.now();
    for (const [k, v] of this.recent) {
      if (now - v.at < RECENT_MS && this.recent.size <= RECENT_MAX) break;
      this.recent.delete(k);
    }
    const key = `${terminalId}\0${id}`;
    const hit = this.recent.get(key);
    if (hit) return hit.done;
    const done = run();
    this.recent.set(key, { done, at: now });
    done.catch(() => {
      if (this.recent.get(key)?.done === done) this.recent.delete(key);
    });
    return done;
  }

  /** Raw keyboard bytes. */
  input(terminalId: string, bytes: Uint8Array): Promise<void> {
    return this.locked(terminalId, async () => {
      const up = this.get(terminalId);
      try {
        await up.open();
        await up.typing.write(bytes);
      } catch (err) {
        throw asInputError(err);
      } finally {
        up.touchIdle();
      }
    });
  }

  /** Named keys, encoded for the terminal's current modes. */
  keys(terminalId: string, names: readonly string[]): Promise<void> {
    return this.locked(terminalId, () => this.keysNow(terminalId, names));
  }

  /** Quick approve/deny: only for a blocked agent, only answer keys, only on the turn the client saw. */
  answer(terminalId: string, names: readonly string[], turn?: number): Promise<void> {
    if (!isAnswerKeys(names))
      return Promise.reject(new TerminalInputError('bad_key', 'answers are short: digits, y, n, a, enter, esc, tab, arrows'));
    return this.locked(terminalId, () =>
      // Checked right before typing (inside the lock), not before waiting for it.
      this.keysNow(terminalId, names, () => {
        const f = this.opts.facts(terminalId);
        if (!f) throw new TerminalInputError('not_found', `no terminal ${terminalId}`);
        if (f.word !== 'blocked') throw new TerminalInputError('not_blocked', `${terminalId} is not waiting for an answer`);
        if (turn !== undefined && turn !== f.turn) throw new TerminalInputError('stale', `${terminalId} moved on (turn ${f.turn})`);
      }),
    );
  }

  /**
   * Chat-style: paste + Enter. Typed through the typing attach the way
   * herdr-core's `terminal.send` does it (bracketed when the program asked,
   * a 200 ms pause, then Enter), without the core's 3 s wait for human quiet:
   * the person sending is the human. `enter: false` pastes only. Falls back to
   * the core's `terminal.send` when the hub can't type itself (a template with
   * its own submit key).
   */
  async send(terminalId: string, text: string, force = false, enter = true): Promise<void> {
    const f = this.opts.facts(terminalId);
    if (!f) throw new TerminalInputError('not_found', `no terminal ${terminalId}`);
    if (f.word === 'blocked' && !force) {
      throw new TerminalInputError('unavailable', `${terminalId} is waiting for an answer: answer its prompt first, or force`);
    }
    if (enter && this.opts.customSubmit?.(terminalId)) return this.coreSend(terminalId, text, force);
    return this.locked(terminalId, async () => {
      const up = this.get(terminalId);
      try {
        const modes = await up.keyModes();
        await up.typing.write(Buffer.from(encodePaste(text, modes.bracketedPaste ?? false), 'utf8'));
        if (!enter) return;
        await new Promise((r) => setTimeout(r, this.opts.pasteGapMs ?? PASTE_GAP_MS));
        await up.typing.write(Buffer.from('\r', 'utf8'));
      } catch (err) {
        throw asInputError(err);
      } finally {
        up.touchIdle();
      }
    });
  }

  /**
   * Runs `run` with this terminal's screen and keyboard to itself: no other phone input is typed until it ends
   * (for multi-step work like Claude's menus). Keys go through the typing attach like any other input.
   */
  exclusive<T>(
    terminalId: string,
    run: (io: {
      screen(opts?: { solid?: boolean }): Promise<string[]>;
      type(text: string): Promise<void>;
      keys(names: string[]): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.locked(terminalId, async () => {
      const up = this.get(terminalId);
      try {
        return await run({
          screen: (opts) => up.screen(opts),
          type: (text) => up.typing.write(Buffer.from(text, 'utf8')),
          keys: (names) => this.keysNow(terminalId, names),
        });
      } finally {
        up.touchIdle();
      }
    });
  }

  private async keysNow(terminalId: string, names: readonly string[], check?: () => void): Promise<void> {
    const up = this.get(terminalId);
    try {
      const modes = await up.keyModes();
      let bytes: string;
      try {
        bytes = encodeKeys(names, modes);
      } catch (err) {
        throw new TerminalInputError('bad_key', (err as Error).message);
      }
      check?.();
      await up.typing.write(Buffer.from(bytes, 'utf8'));
    } catch (err) {
      throw asInputError(err);
    } finally {
      up.touchIdle();
    }
  }

  private locked<T>(terminalId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(terminalId) ?? Promise.resolve();
    const next = prev.then(run);
    const tail: Promise<void> = next.then(
      () => {},
      () => {},
    );
    this.locks.set(terminalId, tail);
    void tail.then(() => {
      if (this.locks.get(terminalId) === tail) this.locks.delete(terminalId);
    });
    return next;
  }

  /** herdr-core's own send (waits for ~3 s of human quiet; refuses a blocked program unless forced). */
  async coreSend(terminalId: string, text: string, force = false): Promise<void> {
    try {
      await this.client.call('terminal.send', { terminal: terminalId, text, force }, 60_000);
    } catch (err) {
      throw asInputError(err);
    }
  }

  /** The world changed: hand each open stream the size core events report (for cores without RESIZE notifications). */
  refreshSizes(): void {
    for (const [id, up] of this.ups) {
      const f = this.opts.facts(id);
      if (f) up.coreSize({ cols: f.cols, rows: f.rows });
    }
  }

  stop(): void {
    this.client.off('ready', this.onReady);
    for (const up of [...this.ups.values()]) up.end('shutdown');
    this.ups.clear();
  }

  private get(terminalId: string): TerminalUpstream {
    let up = this.ups.get(terminalId);
    if (up && !up.isClosed) return up;
    const f = this.opts.facts(terminalId);
    up = new TerminalUpstream({
      client: this.client,
      terminalId,
      coreHistory: this.opts.coreHistory ?? CORE_HISTORY,
      scrollback: this.opts.scrollback ?? MIRROR_HISTORY,
      graceMs: this.opts.graceMs ?? 10_000,
      typingIdleMs: this.opts.typingIdleMs ?? 5000,
      sizeHint: f ? { cols: f.cols, rows: f.rows } : null,
      logger: this.log,
    });
    const self = up;
    up.on('closed', (reason) => {
      if (this.ups.get(terminalId) === self) this.ups.delete(terminalId);
      this.log.debug({ terminal: terminalId, reason }, 'terminal stream closed');
    });
    this.ups.set(terminalId, up);
    return up;
  }
}

/** Maps a core or hub failure to the error a client gets. */
export function asInputError(err: unknown): TerminalInputError {
  if (err instanceof TerminalInputError) return err;
  const e = err as Error & { kind?: string };
  if (e?.name === 'RpcError') {
    if (e.kind === 'not_found') return new TerminalInputError('not_found', e.message);
    if (e.kind === 'finished' || e.kind === 'unavailable' || e.kind === 'blocked') return new TerminalInputError('unavailable', e.message);
    return new TerminalInputError('core_error', e.message);
  }
  if (e?.name === 'CoreUnavailableError') return new TerminalInputError('unavailable', e.message);
  return new TerminalInputError('core_error', e?.message ?? String(err));
}
