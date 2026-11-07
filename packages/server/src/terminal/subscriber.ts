import { type HistoryMark, TERMINAL_PROTOCOL_VERSION, type TerminalServerMessage, type TermReset } from '@herdr-mobile/protocol';

/** Where one client's stream goes (its WebSocket). */
export interface StreamSink {
  sendJson(m: TerminalServerMessage): void;
  /** One binary frame: `[stream u32 LE]` + the chunks. */
  sendBinary(stream: number, chunks: readonly Uint8Array[]): void;
  /** Bytes queued on the socket and not yet sent. */
  bufferedAmount(): number;
  isOpen(): boolean;
}

export interface Backpressure {
  /** More than this queued on the socket: drop the backlog and resync later. */
  highWater: number;
  /** Resync once the socket drained below this. */
  lowWater: number;
  /** How often to check a stalled socket. */
  pollMs: number;
  /** Bytes held while a snapshot is made; more means the client is behind anyway. */
  maxHold: number;
}

export const DEFAULT_BACKPRESSURE: Backpressure = {
  highWater: 1024 * 1024,
  lowWater: 64 * 1024,
  pollMs: 50,
  maxHold: 4 * 1024 * 1024,
};

type Item = { bytes: Uint8Array } | { msg: TerminalServerMessage };

export interface Snapshot {
  data: string;
  cols: number;
  rows: number;
}

/**
 * One client's view of one terminal stream. Live bytes are coalesced per
 * event-loop turn into one binary frame. A client whose socket backs up is
 * not fed a growing backlog: its pending bytes are dropped (`behind`) and, once
 * its socket drains, it gets `term.reset` and a fresh snapshot instead.
 *
 * States: `syncing` (a snapshot is being made; later bytes are held so nothing
 * is lost or doubled), `live`, `behind` (dropping until drained), `closed`.
 */
export class Subscriber {
  state: 'syncing' | 'live' | 'behind' | 'closed' = 'syncing';
  private queue: Item[] = [];
  private queuedBytes = 0;
  private flushQueued = false;
  private poll: NodeJS.Timeout | null = null;
  /** Set by the upstream: asked for when this client drained after falling behind. */
  onDrained: (() => void) | null = null;
  /** Times it fell behind (tests, logs). */
  drops = 0;
  /** The `term.open` request still owed its `term.opened` (the first snapshot never went out). */
  private openReq: number | null = null;

  constructor(
    readonly stream: number,
    readonly terminalId: string,
    readonly sink: StreamSink,
    /** Scrollback lines its snapshots carry. */
    readonly history: number,
    private readonly bp: Backpressure = DEFAULT_BACKPRESSURE,
  ) {}

  /** This stream was opened by request `req`: its first snapshot is announced with `term.opened`. */
  expectOpen(req: number): void {
    this.openReq = req;
  }

  /**
   * What announces the next snapshot: `term.opened` while that is still owed (even if the first
   * snapshot was dropped because the client fell behind), else `term.reset`.
   */
  headFor(cols: number, rows: number, reason: TermReset['reason'], history?: HistoryMark): TerminalServerMessage {
    if (this.openReq !== null) {
      return {
        t: 'term.opened',
        req: this.openReq,
        stream: this.stream,
        terminalId: this.terminalId,
        cols,
        rows,
        v: TERMINAL_PROTOCOL_VERSION,
        ...(history ? { history } : {}),
      };
    }
    const m = this.resetMessage(cols, rows, reason);
    return history ? { ...m, history } : m;
  }

  /** A snapshot is on its way: hold what comes meanwhile. */
  beginSync(): void {
    if (this.state === 'closed') return;
    this.stopPoll();
    this.state = 'syncing';
    this.queue = [];
    this.queuedBytes = 0;
  }

  /** The snapshot as of `beginSync`, announced by `head` (term.opened or term.reset); then what was held. */
  deliverSnapshot(head: TerminalServerMessage, snap: Snapshot): void {
    if (this.state !== 'syncing') return;
    const held = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    this.state = 'live';
    if (head.t === 'term.opened') this.openReq = null;
    this.sink.sendJson(head);
    this.sink.sendBinary(this.stream, [Buffer.from(snap.data, 'utf8')]);
    for (const item of held) this.enqueue(item);
    this.scheduleFlush();
  }

  pushBytes(bytes: Uint8Array): void {
    if (this.state === 'behind' || this.state === 'closed') return;
    this.enqueue({ bytes });
    if (this.state === 'syncing') {
      if (this.queuedBytes > this.bp.maxHold) this.fallBehind();
      return;
    }
    this.scheduleFlush();
  }

  /** A control message in stream order (term.resized). Dropped while behind: the reset carries the size. */
  pushMessage(msg: TerminalServerMessage): void {
    if (this.state === 'behind' || this.state === 'closed') return;
    this.enqueue({ msg });
    if (this.state === 'live') this.scheduleFlush();
  }

  /** Sends now, out of band (errors, close). */
  sendNow(msg: TerminalServerMessage): void {
    if (this.state === 'live') this.flush();
    this.sink.sendJson(msg);
  }

  close(reason?: string): void {
    if (this.state === 'closed') return;
    if (this.state === 'live') this.flush();
    this.state = 'closed';
    this.stopPoll();
    this.queue = [];
    if (reason !== undefined && this.sink.isOpen()) this.sink.sendJson({ t: 'term.closed', stream: this.stream, reason });
  }

  resetMessage(cols: number, rows: number, reason: TermReset['reason']): TermReset {
    return { t: 'term.reset', stream: this.stream, cols, rows, reason };
  }

  private enqueue(item: Item): void {
    this.queue.push(item);
    if ('bytes' in item) this.queuedBytes += item.bytes.length;
  }

  private scheduleFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    setImmediate(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.state !== 'live' || this.queue.length === 0) return;
    if (!this.sink.isOpen()) {
      this.queue = [];
      this.queuedBytes = 0;
      return;
    }
    if (this.sink.bufferedAmount() > this.bp.highWater) {
      this.fallBehind();
      return;
    }
    const items = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    let run: Uint8Array[] = [];
    for (const item of items) {
      if ('bytes' in item) {
        run.push(item.bytes);
        continue;
      }
      if (run.length) this.sink.sendBinary(this.stream, run);
      run = [];
      this.sink.sendJson(item.msg);
    }
    if (run.length) this.sink.sendBinary(this.stream, run);
  }

  private fallBehind(): void {
    this.state = 'behind';
    this.drops++;
    this.queue = [];
    this.queuedBytes = 0;
    this.stopPoll();
    this.poll = setInterval(() => {
      if (!this.sink.isOpen()) {
        this.close();
        return;
      }
      if (this.sink.bufferedAmount() > this.bp.lowWater) return;
      this.stopPoll();
      this.onDrained?.();
    }, this.bp.pollMs);
    this.poll.unref();
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
}
