import {
  BinaryInputKind,
  encodeInputFrame,
  type HistoryCursor,
  type HistoryMark,
  TERMINAL_HISTORY_VERSION,
  type TermAppHistoryResult,
  type TermHistoryPage,
  type TerminalServerMessage,
} from '@herdr-mobile/protocol';
import type { Connection } from '../lib/connection';
import type { AppStore } from '../lib/store';

export interface StreamHandlers {
  /** A (re)opened stream: a fresh snapshot follows, so clear the screen first. `history`: where it sits (bridge v2). */
  onOpen(cols: number, rows: number, history?: HistoryMark): void;
  onData(data: Uint8Array): void;
  /** Throw away what's shown; a snapshot follows. */
  onReset(cols: number, rows: number, history?: HistoryMark): void;
  onResize(cols: number, rows: number): void;
  onClosed(reason: string): void;
  onError?(message: string): void;
}

export interface StreamHandle {
  readonly terminalId: string;
  /** Keyboard bytes from the person (raw xterm input). */
  type(data: string | Uint8Array, automatic?: boolean): boolean;
  /**
   * A page of main-buffer history (read only). Rejects with InputError (`stale`: renumbered, `offline`,
   * `reset`: the stream started over before the answer). Answers come in stream order, after the bytes before them.
   */
  history(cursor: HistoryCursor, dir: 'older' | 'newer', limit: number): Promise<TermHistoryPage>;
  /** A full-screen app's own earlier output (herdr-core scrolls the app to read it): only on the person's request. */
  appHistory(): Promise<TermAppHistoryResult>;
  close(): void;
}

interface HistoryWaiter {
  resolve: (p: TermHistoryPage | TermAppHistoryResult) => void;
  reject: (e: Error) => void;
}

interface Entry {
  terminalId: string;
  handlers: StreamHandlers;
  history: number;
  req: number | null;
  stream: number | null;
  closed: boolean;
  /** History pages asked on the current stream, by req. */
  pages: Map<number, HistoryWaiter>;
}

export class InputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InputError';
  }
}

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Sends it again under a new req with the same idempotency id (after a reconnect to the same bridge). */
  resend: (req: number) => boolean;
  /** The bridge it was sent to: ids only dedupe within one bridge run. */
  serverId: string | null;
}

const enc = new TextEncoder();
let idSeq = 0;
/** A per-input idempotency key: the bridge types an input with a given id at most once. */
function inputId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${rnd}-${++idSeq}`;
}
const REQUEST_TIMEOUT_MS = 70_000;

/**
 * Terminal streams and input over the page's connection. Streams survive
 * reconnects: each is re-opened (with a fresh snapshot) once the bridge
 * welcomes the page again, and the old screen stays up meanwhile.
 */
export class TerminalClient {
  private nextReq = 1;
  private readonly entries = new Set<Entry>();
  private readonly byStream = new Map<number, Entry>();
  private readonly byReq = new Map<number, Entry>();
  private readonly pending = new Map<number, Pending>();
  /** History page reqs -> their stream entry. */
  private readonly pageOwner = new Map<number, Entry>();

  constructor(
    private readonly conn: Connection,
    private readonly store: AppStore,
  ) {
    store.onTerminal((m) => this.onMessage(m));
    conn.onOpen(() => this.reopenAll());
  }

  open(terminalId: string, handlers: StreamHandlers, history = 1000): StreamHandle {
    const e: Entry = { terminalId, handlers, history, req: null, stream: null, closed: false, pages: new Map() };
    this.entries.add(e);
    this.sendOpen(e);
    return {
      terminalId,
      type: (data, automatic = false) => {
        if (e.stream === null) return false;
        const bytes = typeof data === 'string' ? enc.encode(data) : data;
        return this.conn.sendBinary(encodeInputFrame(e.stream, bytes, automatic ? BinaryInputKind.AUTOMATIC : BinaryInputKind.KEYS));
      },
      history: (cursor, dir, limit) =>
        this.ask<TermHistoryPage>(e, (req, stream) => ({ t: 'term.history', req, stream, cursor, dir, limit })),
      appHistory: () => this.ask<TermAppHistoryResult>(e, (req, stream) => ({ t: 'term.appHistory', req, stream })),
      close: () => {
        if (e.closed) return;
        e.closed = true;
        this.dropPages(e, 'closed');
        this.entries.delete(e);
        if (e.req !== null) this.byReq.delete(e.req);
        if (e.stream !== null) {
          this.byStream.delete(e.stream);
          this.conn.send({ t: 'term.close', stream: e.stream });
        }
      },
    };
  }

  /** Called with every binary frame from the connection. */
  onBinary(stream: number, data: Uint8Array): void {
    this.byStream.get(stream)?.handlers.onData(data);
  }

  /** Named keys (enter, esc, ctrl+c, up, y, ...), typed at once. */
  keys(terminalId: string, keys: string[]): Promise<void> {
    const id = inputId();
    return this.request((req) => this.conn.send({ t: 'term.keys', req, id, terminalId, keys }));
  }

  /** Paste `text` and press Enter (chat send); `enter: false` pastes only. */
  send(terminalId: string, text: string, force = false, enter = true): Promise<void> {
    const id = inputId();
    return this.request((req) => this.conn.send({ t: 'term.send', req, id, terminalId, text, force, ...(enter ? {} : { enter: false }) }));
  }

  /** Answer a blocked agent's prompt; refused if it isn't blocked (any more) or moved past `turn`. */
  answer(terminalId: string, keys: string[], turn?: number): Promise<void> {
    const id = inputId();
    return this.request((req) =>
      this.conn.send(
        turn === undefined ? { t: 'term.answer', req, id, terminalId, keys } : { t: 'term.answer', req, id, terminalId, keys, turn },
      ),
    );
  }

  resync(handle: StreamHandle): void {
    for (const e of this.entries)
      if (e.terminalId === handle.terminalId && e.stream !== null) this.conn.send({ t: 'term.resync', stream: e.stream });
  }

  private request(send: (req: number) => boolean): Promise<void> {
    const req = this.nextReq++;
    return new Promise<void>((resolve, reject) => {
      if (!send(req)) {
        reject(new InputError('offline', 'Not connected to the bridge'));
        return;
      }
      this.track(req, { resolve, reject, resend: send, serverId: this.store.getState().serverId });
    });
  }

  private track(req: number, p: Omit<Pending, 'timer'>): void {
    const timer = setTimeout(() => {
      this.pending.delete(req);
      p.reject(new InputError('timeout', 'No answer from the bridge'));
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(req, { ...p, timer });
  }

  /** A request answered in the stream's order (history pages); dropped with the stream. */
  private ask<T extends TermHistoryPage | TermAppHistoryResult>(
    e: Entry,
    msg: (req: number, stream: number) => Parameters<Connection['send']>[0],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (e.stream === null) {
        reject(new InputError('offline', 'The stream is not open'));
        return;
      }
      const req = this.nextReq++;
      if (!this.conn.send(msg(req, e.stream))) {
        reject(new InputError('offline', 'Not connected to the bridge'));
        return;
      }
      e.pages.set(req, { resolve: resolve as (p: TermHistoryPage | TermAppHistoryResult) => void, reject });
      this.pageOwner.set(req, e);
    });
  }

  /** Pages asked on a stream that's over (reset, reopened, closed) never come: their askers move on. */
  private dropPages(e: Entry, why: string): void {
    for (const [req, w] of e.pages) {
      this.pageOwner.delete(req);
      w.reject(new InputError('reset', `history request dropped (${why})`));
    }
    e.pages.clear();
  }

  private sendOpen(e: Entry): void {
    this.dropPages(e, 'reopen');
    if (e.req !== null) this.byReq.delete(e.req);
    if (e.stream !== null) this.byStream.delete(e.stream);
    e.stream = null;
    e.req = this.nextReq++;
    this.byReq.set(e.req, e);
    this.conn.send({ t: 'term.open', req: e.req, terminalId: e.terminalId, history: e.history });
  }

  private reopenAll(): void {
    // Stream ids belong to a connection. Inputs in flight may or may not have been typed: send them
    // again with the same idempotency id, and the bridge types each at most once. A restarted bridge
    // forgot the ids, so those are handed back instead (the person checks the terminal first).
    this.byStream.clear();
    this.byReq.clear();
    const serverId = this.store.getState().serverId;
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const p of inFlight) {
      clearTimeout(p.timer);
      const req = this.nextReq++;
      if (p.serverId !== null && p.serverId === serverId && p.resend(req)) this.track(req, p);
      else p.reject(new InputError('offline', 'The bridge restarted before it confirmed this; check the terminal before sending again'));
    }
    for (const e of this.entries) this.sendOpen(e);
  }

  private onMessage(m: TerminalServerMessage): void {
    switch (m.t) {
      case 'term.opened': {
        const e = this.byReq.get(m.req);
        if (!e) {
          // Closed before it opened.
          this.conn.send({ t: 'term.close', stream: m.stream });
          return;
        }
        this.byReq.delete(m.req);
        e.req = null;
        e.stream = m.stream;
        this.byStream.set(m.stream, e);
        e.handlers.onOpen(m.cols, m.rows, (m.v ?? 1) >= 2 ? m.history : undefined);
        return;
      }
      case 'term.reset': {
        const e = this.byStream.get(m.stream);
        if (!e) return;
        this.dropPages(e, 'reset');
        e.handlers.onReset(m.cols, m.rows, m.history);
        return;
      }
      case 'term.appHistory.result':
      case 'term.history.page': {
        const e = this.pageOwner.get(m.req);
        this.pageOwner.delete(m.req);
        const w = e?.pages.get(m.req);
        if (!e || !w) return;
        e.pages.delete(m.req);
        if (m.t === 'term.history.page' && m.v !== TERMINAL_HISTORY_VERSION) w.reject(new InputError('version', `history rows v${m.v}`));
        else w.resolve(m);
        return;
      }
      case 'term.resized':
        this.byStream.get(m.stream)?.handlers.onResize(m.cols, m.rows);
        return;
      case 'term.closed': {
        const e = this.byStream.get(m.stream);
        if (!e) return;
        this.byStream.delete(m.stream);
        e.stream = null;
        this.dropPages(e, 'closed');
        e.handlers.onClosed(m.reason);
        return;
      }
      case 'term.ack': {
        const p = this.pending.get(m.req);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.req);
        p.resolve();
        return;
      }
      case 'term.error': {
        if (m.req !== undefined && this.pageOwner.has(m.req)) {
          const e = this.pageOwner.get(m.req) as Entry;
          this.pageOwner.delete(m.req);
          const w = e.pages.get(m.req);
          e.pages.delete(m.req);
          w?.reject(new InputError(m.code, m.message));
          return;
        }
        if (m.req !== undefined) {
          const p = this.pending.get(m.req);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.req);
            p.reject(new InputError(m.code, m.message));
            return;
          }
          const e = this.byReq.get(m.req);
          if (e) {
            this.byReq.delete(m.req);
            e.req = null;
            e.handlers.onError?.(m.message);
            e.handlers.onClosed(m.code);
            return;
          }
        }
        if (m.stream !== undefined) this.byStream.get(m.stream)?.handlers.onError?.(m.message);
        return;
      }
    }
  }
}
