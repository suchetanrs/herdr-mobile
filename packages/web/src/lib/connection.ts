import { type ClientMessage, decodeOutputFrame, PROTOCOL_VERSION, type ServerMessage } from '@herdr-mobile/protocol';
import type { AppStore } from './store';

/**
 * A ping unanswered this long, with nothing else heard since it went out, means the socket is dead. Any
 * message counts as life: on slow cellular a ping's answer can queue behind a big snapshot.
 */
export const PING_TIMEOUT_MS = 12_000;

/** Waits between attempts: quick at first, then at most 15 s (plus jitter so phones don't stampede). */
export const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000] as const;

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15000;
  return Math.round(base * (1 + 0.25 * random()));
}

export interface ConnectionOptions {
  store: AppStore;
  /** WebSocket URL (re-read on every attempt). */
  url: () => string;
  /** Asked after a connection fails before it was welcomed: is this device signed out? */
  checkAuth: () => Promise<'ok' | 'unauthorized' | 'unreachable'>;
  onBinary?: (stream: number, data: Uint8Array) => void;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  /** How often to measure the round trip while the page is visible. */
  pingEveryMs?: number;
}

type OpenListener = () => void;

/**
 * The page's one WebSocket to the bridge: hello + resume, reconnect with
 * backoff, a heartbeat watchdog, RTT pings, and a quick retry when the page
 * comes back to the front or the network returns. Everything it hears goes to
 * the store; terminal bytes go to `onBinary`.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs = 15000;
  private lastHeard = 0;
  private pingSentAt: number | null = null;
  private lastPing = 0;
  private welcomed = false;
  private stopped = true;
  private readonly openListeners = new Set<OpenListener>();
  private readonly WS: typeof WebSocket;
  private readonly now: () => number;
  private readonly pingEveryMs: number;

  constructor(private readonly opts: ConnectionOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.now = opts.now ?? Date.now;
    this.pingEveryMs = opts.pingEveryMs ?? 10000;
  }

  get isOpen(): boolean {
    return this.welcomed && this.ws?.readyState === 1;
  }

  /** Called after every (re)connection is welcomed: re-open streams, re-send `looking`. */
  onOpen(l: OpenListener): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.tick(), 1000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onWake);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('pageshow', this.onWake);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.retryTimer = null;
    this.watchdog = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onWake);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('pageshow', this.onWake);
    }
    this.drop();
  }

  /** Try now (just signed in, a tap on "retry"). */
  retryNow(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop();
    this.connect();
  }

  send(m: ClientMessage): boolean {
    if (!this.isOpen || !this.ws) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  sendBinary(frame: Uint8Array): boolean {
    if (!this.isOpen || !this.ws) return false;
    this.ws.send(frame as Uint8Array<ArrayBuffer>);
    return true;
  }

  private readonly onOnline = () => {
    this.opts.store.setConn({ offline: false });
    this.onWake();
  };

  /** The device lost its network: the socket is gone even if the browser hasn't closed it yet. */
  private readonly onOffline = () => {
    if (this.stopped) return;
    const { store } = this.opts;
    store.setConn({ offline: true });
    if (store.getState().conn.status === 'unauthorized') return;
    this.lost();
    this.drop();
    this.scheduleRetry();
  };

  /** Remember when what's shown stopped being current. */
  private lost(): void {
    const { store } = this.opts;
    if (store.getState().conn.lostAt === null && store.getState().conn.everSynced) store.setConn({ lostAt: this.now() });
  }

  private readonly onWake = () => {
    if (this.stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const st = this.opts.store.getState().conn.status;
    if (st === 'unauthorized') return;
    // Phones freeze sockets in the background without closing them: check it's alive now.
    if (this.ws && this.ws.readyState === 0) return;
    if (this.isOpen) this.ping();
    else this.retryNow();
  };

  private connect(): void {
    const { store } = this.opts;
    const attempt = store.getState().conn.attempt;
    store.setConn({ status: attempt === 0 && !store.getState().conn.everSynced ? 'connecting' : 'reconnecting', retryAt: null });
    this.welcomed = false;
    let ws: WebSocket;
    try {
      ws = new this.WS(this.opts.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.lastHeard = this.now();
    ws.onopen = () => {
      this.lastHeard = this.now();
      const resume = store.resumePoint();
      ws.send(JSON.stringify(resume ? { t: 'hello', v: PROTOCOL_VERSION, resume } : { t: 'hello', v: PROTOCOL_VERSION }));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (ws !== this.ws) return;
      this.lastHeard = this.now();
      if (typeof ev.data !== 'string') {
        const f = decodeOutputFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (f) this.opts.onBinary?.(f.stream, f.data);
        return;
      }
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = (ev?: CloseEvent) => {
      if (ws !== this.ws) return;
      this.ws = null;
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      if (this.stopped) return;
      this.lost();
      // 4401: this device was signed out (Settings > Devices): straight to the sign-in screen.
      if (!wasWelcomed || ev?.code === 4401) void this.afterFailure();
      else {
        store.setConn({ attempt: 0 });
        this.scheduleRetry();
      }
    };
    ws.onerror = () => {
      // onclose follows.
    };
  }

  private onMessage(m: ServerMessage): void {
    const { store } = this.opts;
    if (m.t === 'welcome') {
      this.heartbeatMs = m.heartbeatMs;
      this.welcomed = true;
      store.handle(m);
      store.setConn({ status: 'open', attempt: 0, retryAt: null, lostAt: null, offline: false });
      for (const l of this.openListeners) l();
      this.ping();
      return;
    }
    if (m.t === 'hb' && this.pingSentAt !== null) {
      store.setConn({ rttMs: this.now() - this.pingSentAt });
      this.pingSentAt = null;
    }
    if (m.t === 'error' && m.code === 'version') {
      // An older/newer bridge: a reload fetches the matching page.
      store.dropResume();
    }
    if (store.handle(m) === 'gap') {
      store.dropResume();
      this.retryNow();
    }
  }

  private async afterFailure(): Promise<void> {
    const { store } = this.opts;
    const verdict = await this.opts.checkAuth();
    if (this.stopped) return;
    if (verdict === 'unauthorized') {
      store.setConn({ status: 'unauthorized', retryAt: null });
      return;
    }
    store.setConn({ attempt: store.getState().conn.attempt + 1 });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const { store } = this.opts;
    const delay = backoffDelay(store.getState().conn.attempt);
    store.setConn({
      status: store.getState().conn.everSynced || store.getState().conn.attempt > 0 ? 'reconnecting' : 'connecting',
      retryAt: this.now() + delay,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private ping(): void {
    if (!this.isOpen) return;
    this.pingSentAt = this.now();
    this.lastPing = this.pingSentAt;
    this.send({ t: 'ping' });
  }

  private tick(): void {
    if (!this.ws) return;
    const now = this.now();
    const silentFor = now - this.lastHeard;
    // Nothing for 2.5 heartbeats, or a ping unanswered with nothing at all heard since: the socket is dead
    // even if the OS hasn't noticed.
    const pingLost = this.pingSentAt !== null && now - this.pingSentAt > PING_TIMEOUT_MS && this.lastHeard <= this.pingSentAt;
    if (silentFor > this.heartbeatMs * 2.5 || (this.welcomed && pingLost) || (!this.welcomed && silentFor > 10000)) {
      this.pingSentAt = null;
      this.lost();
      const ws = this.ws;
      this.ws = null;
      this.welcomed = false;
      try {
        ws.close();
      } catch {
        // already closing
      }
      this.scheduleRetry();
      return;
    }
    // Heard from since, but that ping's answer never came: forget it so pings (and the RTT) carry on.
    if (this.pingSentAt !== null && now - this.pingSentAt > PING_TIMEOUT_MS) this.pingSentAt = null;
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (visible && this.welcomed && this.pingSentAt === null && now - this.lastPing > this.pingEveryMs) this.ping();
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }
}
