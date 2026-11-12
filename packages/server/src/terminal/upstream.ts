import { EventEmitter } from 'node:events';
import type { HistoryCursor, TermReset } from '@herdr-mobile/protocol';
import type { CoreClient } from '../core/client.js';
import { creditPayload, FrameKind } from '../core/frames.js';
import { type Logger, silentLogger } from '../log.js';
import { type HistoryPage, ScreenMirror } from './mirror.js';
import type { Subscriber } from './subscriber.js';
import { type Grid, TypingChannel } from './typing.js';

export interface UpstreamOptions {
  client: CoreClient;
  terminalId: string;
  /** Scrollback lines asked of the core's first paint (the desktop app uses 2000). */
  coreHistory: number;
  /** Scrollback lines the mirror keeps. */
  scrollback: number;
  /** Close the core attach this long after the last viewer left. */
  graceMs: number;
  /** Close the typing attach after this long without input. */
  typingIdleMs: number;
  /** Size to start the mirror with until the core says (the world's record). */
  sizeHint?: Grid | null;
  logger?: Logger;
}

/** The first paint is in once no data came for this long... */
const PAINT_QUIET_MS = 40;
/** ...(or none at all for this long)... */
const PAINT_FIRST_MS = 200;
/** ...and never waited for longer than this. */
const PAINT_WAIT_MS = 1500;

type UpstreamEvents = {
  /** Done for good (the program ended, the terminal is gone, or idle past the grace period). */
  closed: [string];
};

/**
 * One terminal's shared stream: a single read-only (`observe`) core attach,
 * fanned out to every client watching it, with a screen mirror for late
 * joiners and resyncs. Observers never type or resize; the grid comes from the
 * core's RESIZE notifications (asked with `resize_notifications`).
 */
export class TerminalUpstream extends EventEmitter<UpstreamEvents> {
  readonly terminalId: string;
  readonly typing: TypingChannel;
  private readonly log: Logger;
  private readonly client: CoreClient;
  private readonly subs = new Set<Subscriber>();
  private mirror: ScreenMirror;
  private channel: number | null = null;
  private state: 'idle' | 'attaching' | 'open' | 'down' | 'closed' = 'idle';
  private attached: Promise<void> | null = null;
  private grid: Grid | null = null;
  /** The core confirmed it sends RESIZE before each new grid. */
  private notified = false;
  private grace: NodeJS.Timeout | null = null;
  private firstData: (() => void) | null = null;
  private painted: Promise<void> = Promise.resolve();
  private appRead: Promise<{ lines: string[]; complete: boolean; why?: string } | null> | null = null;
  /** When the current attach opened, and when its last DATA frame came (the first paint streams in for a while). */
  private attachedAt = 0;
  private lastDataAt = 0;

  constructor(private readonly opts: UpstreamOptions) {
    super();
    this.terminalId = opts.terminalId;
    this.client = opts.client;
    this.log = opts.logger ?? silentLogger;
    const hint = opts.sizeHint && opts.sizeHint.cols > 0 && opts.sizeHint.rows > 0 ? opts.sizeHint : { cols: 80, rows: 24 };
    this.mirror = new ScreenMirror({ ...hint, scrollback: opts.scrollback });
    this.typing = new TypingChannel({
      client: this.client,
      terminalId: this.terminalId,
      idleMs: opts.typingIdleMs,
      logger: this.log,
      currentSize: () => this.currentSize(),
    });
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  get isClosed(): boolean {
    return this.state === 'closed';
  }

  /** The grid as the core last announced it (null until known). */
  get size(): Grid | null {
    return this.grid;
  }

  /** Attaches (once); resolves when the stream is open. */
  open(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('stream closed'));
    if (this.state === 'open') return Promise.resolve();
    if (!this.attached) this.attached = this.attach();
    return this.attached;
  }

  /** Adds a viewer: it gets `term.opened` and a snapshot once the stream is open, then live bytes. */
  async add(sub: Subscriber, req: number): Promise<void> {
    this.cancelGrace();
    this.subs.add(sub);
    sub.expectOpen(req);
    sub.onDrained = () => void this.resync(sub, 'behind');
    try {
      await this.open();
    } catch (err) {
      this.subs.delete(sub);
      this.maybeIdle();
      throw err;
    }
    if (!this.subs.has(sub)) return;
    await this.paintSettled();
    if (!this.subs.has(sub)) return;
    await this.sync(sub, (snap) => sub.headFor(snap.cols, snap.rows, 'resync', snap.history));
  }

  /**
   * Right after attaching, the core's first paint (all its history) is still streaming in: a snapshot now would
   * carry half of it and send the rest as live bytes. Waits for a quiet moment (at most PAINT_WAIT_MS).
   */
  private async paintSettled(): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
    for (;;) {
      const now = Date.now();
      if (this.state !== 'open' || now - this.attachedAt >= PAINT_WAIT_MS) return;
      const quiet = this.lastDataAt > 0 ? now - this.lastDataAt : now - this.attachedAt;
      if (quiet >= PAINT_QUIET_MS && (this.lastDataAt > 0 || quiet >= PAINT_FIRST_MS)) return;
      await sleep(PAINT_QUIET_MS / 2);
    }
  }

  remove(sub: Subscriber): void {
    if (!this.subs.delete(sub)) return;
    sub.onDrained = null;
    this.maybeIdle();
  }

  /** Sends `sub` a fresh snapshot (term.reset first). */
  resync(sub: Subscriber, reason: TermReset['reason']): Promise<void> {
    if (!this.subs.has(sub) || this.state !== 'open') return Promise.resolve();
    return this.sync(sub, (snap) => sub.headFor(snap.cols, snap.rows, reason, snap.history));
  }

  /**
   * A full-screen app's own history (`hc read --lines`): herdr-core scrolls the app and back. One read at a time
   * per terminal; `null` when the screen isn't a full-screen app's.
   */
  appHistory(lines: number): Promise<{ lines: string[]; complete: boolean; why?: string } | null> {
    this.appRead ??= this.readApp(lines).finally(() => {
      this.appRead = null;
    });
    return this.appRead;
  }

  private async readApp(lines: number): Promise<{ lines: string[]; complete: boolean; why?: string } | null> {
    if (!(await this.mirror.screenNow()).alt) return null;
    const r = await this.client.call<{ text?: string; complete?: boolean; how?: string; why?: string }>('terminal.read', {
      terminal: this.terminalId,
      lines,
    });
    const text = (r.text ?? '').split('\n');
    if (r.how !== 'stitched') return { lines: [], complete: false, why: r.why ?? 'unreadable' };
    // The read ends with the screen as it was (now put back): what's above it is the history.
    const screen = (await this.mirror.screenNow()).rows.length;
    return { lines: text.slice(0, Math.max(0, text.length - screen)), complete: r.complete === true };
  }

  /** Main-buffer history rows from the mirror (read only); `stale` for a cursor of an earlier epoch. */
  history(cursor: HistoryCursor, dir: 'older' | 'newer', limit: number): Promise<HistoryPage | 'stale'> {
    if (this.state !== 'open') return Promise.resolve('stale');
    return this.mirror.history(cursor, dir, limit);
  }

  /** Key modes after the first paint was parsed (for named keys). */
  async keyModes(): Promise<ScreenMirror['modes']> {
    await this.open();
    await this.painted;
    await this.mirror.flush();
    return this.mirror.modes;
  }

  /**
   * The screen's rows now (down to the last non-blank one), once the first paint is in. With `solid`, faint (dim)
   * text is blanked (same rows, same columns).
   */
  async screen(opts: { solid?: boolean } = {}): Promise<string[]> {
    await this.open();
    await this.painted;
    const now = await this.mirror.screenNow(opts);
    return opts.solid ? (now.solid ?? []) : now.rows;
  }

  /** The core connection came back: attach again; every viewer gets a fresh snapshot. */
  reconnect(): void {
    if (this.state !== 'down') return;
    this.attached = null;
    this.open()
      .then(() => {
        for (const sub of this.subs) void this.resync(sub, 'reconnect');
      })
      .catch((err: Error) => this.end(err.message.includes('finished') ? 'exited' : 'gone'));
  }

  /** Closes everything; viewers get `term.closed` with `reason`. */
  end(reason: string): void {
    if (this.state === 'closed') return;
    const wasOpen = this.channel;
    this.state = 'closed';
    this.cancelGrace();
    this.typing.close();
    if (wasOpen !== null) this.client.closeChannel(wasOpen);
    this.channel = null;
    for (const sub of this.subs) sub.close(reason);
    this.subs.clear();
    this.mirror.dispose();
    this.emit('closed', reason);
  }

  // ---- core side ----

  private async attach(): Promise<void> {
    this.state = 'attaching';
    const hint = this.grid ?? { cols: this.mirror.cols, rows: this.mirror.rows };
    let r: { channel: number; resize_notifications?: boolean };
    try {
      r = await this.client.call('terminal.attach', {
        terminal: this.terminalId,
        cols: hint.cols,
        rows: hint.rows,
        observe: true,
        resize_notifications: true,
        history: this.opts.coreHistory,
      });
    } catch (err) {
      this.attached = null;
      if (this.state === 'attaching') this.state = 'idle';
      throw err;
    }
    // end() may have run while the call was out.
    if ((this.state as string) === 'closed') {
      this.client.closeChannel(r.channel);
      throw new Error('stream closed');
    }
    const ch = r.channel;
    this.channel = ch;
    this.notified = r.resize_notifications === true;
    if (!this.notified)
      this.log.warn({ terminal: this.terminalId }, 'core did not confirm resize notifications; sizes come from core events');
    // A fresh first paint follows: start the mirror over so snapshots never mix two paints.
    this.mirror.reset(hint.cols, hint.rows);
    this.painted = new Promise((resolve) => {
      const t = setTimeout(resolve, 1000);
      t.unref();
      this.firstData = () => {
        clearTimeout(t);
        resolve();
      };
    });
    this.state = 'open';
    this.attachedAt = Date.now();
    this.lastDataAt = 0;
    this.client.openChannel(ch, {
      onFrame: (kind, payload) => this.onFrame(ch, kind, payload),
      onDrop: () => this.onDrop(ch),
    });
  }

  private onFrame(ch: number, kind: number, payload: Buffer): void {
    if (ch !== this.channel) return;
    if (kind === FrameKind.DATA) {
      this.lastDataAt = Date.now();
      // Credit once the mirror has parsed it: the core's window then bounds what piles up here,
      // and a slow mirror makes the core repaint instead of queueing without limit.
      this.mirror.write(payload, () => {
        if (this.channel === ch) this.client.sendFrame(ch, FrameKind.CREDIT, creditPayload(payload.length));
      });
      for (const sub of this.subs) sub.pushBytes(payload);
      this.firstData?.();
      this.firstData = null;
      return;
    }
    if (kind === FrameKind.RESIZE && payload.length >= 4) {
      this.applyGrid({ cols: payload.readUInt16LE(0), rows: payload.readUInt16LE(2) });
      return;
    }
    if (kind === FrameKind.CLOSE) {
      this.client.closeChannel(ch, false);
      this.channel = null;
      let reason = 'closed';
      try {
        const body = JSON.parse(payload.toString('utf8') || '{}') as { reason?: string };
        if (typeof body.reason === 'string') reason = body.reason;
      } catch {}
      this.end(reason);
    }
  }

  /**
   * The terminal's size as core events report it (the world store). Used only when the core
   * didn't confirm RESIZE notifications on this attach: those come in stream order and win.
   */
  coreSize(grid: Grid): void {
    if (this.notified || this.state !== 'open' || grid.cols < 1 || grid.rows < 1) return;
    this.applyGrid(grid);
  }

  private applyGrid(grid: Grid): void {
    const changed = !this.grid || this.grid.cols !== grid.cols || this.grid.rows !== grid.rows;
    this.grid = grid;
    this.mirror.resize(grid.cols, grid.rows);
    this.typing.onGrid(grid);
    if (!changed) return;
    for (const sub of this.subs) sub.pushMessage({ t: 'term.resized', stream: sub.stream, cols: grid.cols, rows: grid.rows });
  }

  private onDrop(ch: number): void {
    if (ch !== this.channel || this.state === 'closed') return;
    this.channel = null;
    this.state = 'down';
    this.attached = null;
    this.typing.onDrop();
  }

  private async sync(
    sub: Subscriber,
    head: (snap: Awaited<ReturnType<ScreenMirror['snapshot']>>) => Parameters<Subscriber['deliverSnapshot']>[0],
  ) {
    sub.beginSync();
    try {
      const snap = await this.mirror.snapshot(sub.history);
      sub.deliverSnapshot(head(snap), snap);
    } catch (err) {
      this.log.debug({ terminal: this.terminalId, err: (err as Error).message }, 'snapshot failed');
    }
  }

  /** Always the core's own record: a RESIZE notification may still be queued behind output. */
  private async currentSize(): Promise<Grid> {
    const t = await this.client.call<{ cols?: number; rows?: number }>('terminal.get', { terminal: this.terminalId });
    return { cols: t.cols ?? 0, rows: t.rows ?? 0 };
  }

  private maybeIdle(): void {
    if (this.subs.size > 0 || this.state === 'closed' || this.grace) return;
    this.grace = setTimeout(() => {
      this.grace = null;
      if (this.subs.size === 0) this.end('idle');
    }, this.opts.graceMs);
    this.grace.unref();
  }

  private cancelGrace(): void {
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
  }

  /** Input counts as use: a stream kept only for typing stays open `graceMs` past the last key. */
  touchIdle(): void {
    if (this.subs.size > 0) return;
    this.cancelGrace();
    this.maybeIdle();
  }
}
