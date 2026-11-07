import {
  BinaryInputKind,
  decodeInputFrame,
  TERMINAL_HISTORY_VERSION,
  TERMINAL_LIMITS,
  type TermError,
  type TermErrorCode,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';
import { asInputError, type TerminalHub } from '../terminal/hub.js';
import { DEFAULT_INPUT_LIMITS, InputLimiter, type InputLimits } from '../terminal/ratelimit.js';
import { type Backpressure, DEFAULT_BACKPRESSURE, type StreamSink, Subscriber } from '../terminal/subscriber.js';

const MAX_STREAMS = 16;
const DEFAULT_HISTORY = 1000;
const DEFAULT_HISTORY_PAGE = 300;
/** History pages one client may have in flight (they're reads, but each walks up to 1000 rows). */
const MAX_HISTORY_IN_FLIGHT = 4;
/** `t7`, `rohan/t7`, or a terminal name. */
const TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$/;

export interface TerminalSessionOptions {
  hub: TerminalHub;
  limits?: InputLimits;
  backpressure?: Backpressure;
  logger?: Logger;
}

/**
 * One WebSocket client's terminal side: its open streams (ids are per
 * connection), its input allowance, and the mapping from protocol messages to
 * the hub. Input from one client is applied in the order it was sent.
 */
export class TerminalSession {
  private readonly streams = new Map<number, Subscriber>();
  private readonly limiter: InputLimiter;
  private readonly log: Logger;
  private nextStream = 1;
  private inputChain: Promise<void> = Promise.resolve();
  private historyInFlight = 0;
  private closed = false;

  constructor(
    private readonly opts: TerminalSessionOptions,
    private readonly sink: StreamSink,
  ) {
    this.limiter = new InputLimiter(opts.limits ?? DEFAULT_INPUT_LIMITS);
    this.log = opts.logger ?? silentLogger;
  }

  onMessage(msg: TerminalClientMessage): void {
    if (this.closed) return;
    switch (msg.t) {
      case 'term.open': {
        this.open(msg.req, msg.terminalId, msg.history);
        return;
      }
      case 'term.close': {
        const sub = this.streams.get(msg.stream);
        if (!sub) {
          this.error({ stream: msg.stream }, 'not_found', `no stream ${msg.stream}`);
          return;
        }
        this.streams.delete(msg.stream);
        this.opts.hub.unsubscribe(sub);
        sub.close('closed');
        return;
      }
      case 'term.resync': {
        const sub = this.streams.get(msg.stream);
        if (!sub) {
          this.error({ stream: msg.stream }, 'not_found', `no stream ${msg.stream}`);
          return;
        }
        void this.opts.hub.upstream(sub.terminalId)?.resync(sub, 'resync');
        return;
      }
      case 'term.history': {
        this.history(msg);
        return;
      }
      case 'term.appHistory': {
        this.appHistory(msg);
        return;
      }
      case 'term.keys': {
        if (msg.keys.length === 0 || msg.keys.length > TERMINAL_LIMITS.maxKeys) {
          this.error(msg, 'too_large', `1 to ${TERMINAL_LIMITS.maxKeys} keys`);
          return;
        }
        this.input(msg, msg.keys.join('').length, () =>
          this.opts.hub.once(msg.terminalId, msg.id, () => this.opts.hub.keys(msg.terminalId, msg.keys)),
        );
        return;
      }
      case 'term.answer': {
        if (msg.keys.length === 0 || msg.keys.length > TERMINAL_LIMITS.maxAnswerKeys) {
          this.error(msg, 'too_large', `1 to ${TERMINAL_LIMITS.maxAnswerKeys} keys`);
          return;
        }
        this.input(msg, msg.keys.length, () =>
          this.opts.hub.once(msg.terminalId, msg.id, () => this.opts.hub.answer(msg.terminalId, msg.keys, msg.turn)),
        );
        return;
      }
      case 'term.send': {
        if (msg.text.length > TERMINAL_LIMITS.maxSendChars) {
          this.error(msg, 'too_large', `at most ${TERMINAL_LIMITS.maxSendChars} characters`);
          return;
        }
        this.input(msg, Buffer.byteLength(msg.text), () =>
          this.opts.hub.once(msg.terminalId, msg.id, () =>
            this.opts.hub.send(msg.terminalId, msg.text, msg.force ?? false, msg.enter ?? true),
          ),
        );
        return;
      }
    }
  }

  /** A binary frame: keyboard input for one of this client's streams. */
  onBinary(frame: Buffer): void {
    if (this.closed) return;
    const f = decodeInputFrame(frame);
    if (!f) {
      this.error({}, 'bad_request', 'binary frames are [stream u32 LE][kind u8][bytes]');
      return;
    }
    // The core already answers terminal queries; the client's own replies would reach the program twice.
    if (f.kind === BinaryInputKind.AUTOMATIC) return;
    if (f.kind !== BinaryInputKind.KEYS) {
      this.error({ stream: f.stream }, 'bad_request', `unknown input kind ${f.kind}`);
      return;
    }
    const sub = this.streams.get(f.stream);
    if (!sub) {
      this.error({ stream: f.stream }, 'not_found', `no stream ${f.stream}`);
      return;
    }
    if (f.data.length > TERMINAL_LIMITS.maxInputBytes) {
      this.error({ stream: f.stream }, 'too_large', `at most ${TERMINAL_LIMITS.maxInputBytes} bytes per frame`);
      return;
    }
    const data = Buffer.from(f.data);
    this.input({ stream: f.stream }, data.length, () => this.opts.hub.input(sub.terminalId, data));
  }

  close(): void {
    this.closed = true;
    for (const sub of this.streams.values()) {
      this.opts.hub.unsubscribe(sub);
      sub.close();
    }
    this.streams.clear();
  }

  private open(req: number, terminalId: string, history: number | undefined): void {
    if (!TERMINAL_ID.test(terminalId)) {
      this.error({ req, terminalId }, 'bad_request', 'bad terminal id');
      return;
    }
    if (this.streams.size >= MAX_STREAMS) {
      this.error({ req, terminalId }, 'too_large', `at most ${MAX_STREAMS} open streams`);
      return;
    }
    const lines = Math.min(TERMINAL_LIMITS.maxHistory, history ?? DEFAULT_HISTORY);
    const stream = this.nextStream++;
    const sub = new Subscriber(stream, terminalId, this.sink, lines, this.opts.backpressure ?? DEFAULT_BACKPRESSURE);
    this.streams.set(stream, sub);
    this.opts.hub.subscribe(sub, req).catch((err: unknown) => {
      this.streams.delete(stream);
      sub.close();
      const e = asInputError(err);
      this.error({ req, terminalId }, e.code, e.message);
    });
  }

  /** A page of main-buffer history from the stream's mirror: read only, never touches the terminal. */
  private history(msg: Extract<TerminalClientMessage, { t: 'term.history' }>): void {
    const sub = this.streams.get(msg.stream);
    if (!sub) {
      this.error({ req: msg.req, stream: msg.stream }, 'not_found', `no stream ${msg.stream}`);
      return;
    }
    const up = this.opts.hub.upstream(sub.terminalId);
    if (!up) {
      this.error({ req: msg.req, stream: msg.stream }, 'unavailable', 'the stream is not open');
      return;
    }
    if (this.historyInFlight >= MAX_HISTORY_IN_FLIGHT) {
      this.error({ req: msg.req, stream: msg.stream }, 'rate_limited', 'one page at a time');
      return;
    }
    const limit = Math.max(1, Math.min(TERMINAL_LIMITS.maxHistoryPage, msg.limit ?? DEFAULT_HISTORY_PAGE));
    this.historyInFlight++;
    up.history(msg.cursor, msg.dir, limit)
      .then((page) => {
        if (this.closed || !this.streams.has(msg.stream)) return;
        if (page === 'stale') {
          this.error({ req: msg.req, stream: msg.stream }, 'stale', 'the history was renumbered; start from the latest mark');
          return;
        }
        // In stream order, so it never overtakes the bytes or the reset it belongs after.
        sub.pushMessage({ t: 'term.history.page', req: msg.req, stream: msg.stream, v: TERMINAL_HISTORY_VERSION, ...page });
      })
      .catch((err: Error) => {
        if (!this.closed) this.error({ req: msg.req, stream: msg.stream }, 'unavailable', err.message);
      })
      .finally(() => {
        this.historyInFlight--;
      });
  }

  /** A full-screen app's history, on the person's request (herdr-core scrolls the app to read it). */
  private appHistory(msg: Extract<TerminalClientMessage, { t: 'term.appHistory' }>): void {
    const sub = this.streams.get(msg.stream);
    const up = sub ? this.opts.hub.upstream(sub.terminalId) : undefined;
    if (!sub || !up) {
      this.error({ req: msg.req, stream: msg.stream }, 'not_found', `no stream ${msg.stream}`);
      return;
    }
    if (!this.limiter.allow(1)) {
      this.error({ req: msg.req, stream: msg.stream }, 'rate_limited', 'slow down');
      return;
    }
    const lines = Math.max(1, Math.min(TERMINAL_LIMITS.maxAppHistory, msg.lines ?? TERMINAL_LIMITS.maxAppHistory));
    up.appHistory(lines)
      .then((r) => {
        if (this.closed || !this.streams.has(msg.stream)) return;
        if (!r) {
          this.error({ req: msg.req, stream: msg.stream }, 'bad_request', 'not a full-screen app: its history is above the screen');
          return;
        }
        const m: TerminalServerMessage = {
          t: 'term.appHistory.result',
          req: msg.req,
          stream: msg.stream,
          lines: r.lines,
          complete: r.complete,
        };
        if (r.why) m.why = r.why;
        this.send(m);
      })
      .catch((err: unknown) => {
        if (this.closed) return;
        const e = asInputError(err);
        this.error({ req: msg.req, stream: msg.stream }, e.code, e.message);
      });
  }

  private input(ref: { req?: number; stream?: number; terminalId?: string }, cost: number, run: () => Promise<void>): void {
    if (ref.terminalId !== undefined && !TERMINAL_ID.test(ref.terminalId)) {
      this.error(ref, 'bad_request', 'bad terminal id');
      return;
    }
    if (!this.limiter.allow(cost)) {
      this.error(ref, 'rate_limited', 'slow down');
      return;
    }
    const next = this.inputChain.then(async () => {
      if (this.closed) return;
      try {
        await run();
        if (ref.req !== undefined) this.send({ t: 'term.ack', req: ref.req });
      } catch (err) {
        const e = asInputError(err);
        this.log.debug({ err: e.message, code: e.code }, 'terminal input refused');
        this.error(ref, e.code, e.message);
      }
    });
    this.inputChain = next;
  }

  private error(ref: { req?: number; stream?: number; terminalId?: string }, code: TermErrorCode, message: string): void {
    const m: TermError = { t: 'term.error', code, message };
    if (ref.req !== undefined) m.req = ref.req;
    if (ref.stream !== undefined) m.stream = ref.stream;
    if (ref.terminalId !== undefined) m.terminalId = ref.terminalId;
    this.send(m);
  }

  private send(m: TerminalServerMessage): void {
    if (this.sink.isOpen()) this.sink.sendJson(m);
  }
}
