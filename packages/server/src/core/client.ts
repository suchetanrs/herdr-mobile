import { EventEmitter } from 'node:events';
import net from 'node:net';
import { type Logger, silentLogger } from '../log.js';
import { Backoff } from './backoff.js';
import { creditPayload, encodeFrame, type Frame, FrameDecoder, FrameKind, LineSplitter } from './frames.js';
import { checkCall } from './policy.js';
import { type CoreSnapshot, CoreUnavailableError, GENERATION, type HelloResult, RpcError, type RpcErrorBody } from './types.js';

/** A JSON-RPC notification from the event subscription (`event`, `heartbeat`, `missed`). */
export interface CoreNotification {
  method: string;
  params: Record<string, unknown>;
}

/** Bytes and control frames for one attach channel (used by the terminal proxy). */
export interface ChannelHandler {
  onFrame(kind: number, payload: Buffer): void;
  /** The connection went away; the channel is gone. */
  onDrop(): void;
}

export interface CoreClientOptions {
  socketPath: string;
  logger?: Logger;
  /** Per-call timeout. */
  callTimeoutMs?: number;
  /** No data on the event channel for this long: assume the core hung and reconnect. Heartbeats come every 15 s. */
  watchdogMs?: number;
  backoff?: Backoff;
  /** Bytes of event-channel credit to grant up front (the app uses 1 MiB). */
  eventCredit?: number;
  /** No `hello` reply this long after connecting: drop the socket and retry. */
  helloTimeoutMs?: number;
}

type ClientEvents = {
  /** Connected and greeted; (re)subscribe now. */
  ready: [HelloResult];
  /** A ready connection was lost; a reconnect is scheduled. */
  down: [Error | null];
  /** A connection attempt failed before it was ready; another is scheduled. */
  failed: [Error];
  /** The core ended the event subscription (the socket is fine): subscribe again. */
  eventsClosed: [];
};

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * JSON-RPC over herdr-core's unix socket, in framed mode (needed for attach
 * streams). Reconnects with backoff forever; every reconnect emits `ready`, and
 * callers re-subscribe (the core's `seq` restarts with each core process).
 */
export class CoreClient extends EventEmitter<ClientEvents> {
  private readonly log: Logger;
  private readonly callTimeoutMs: number;
  private readonly watchdogMs: number;
  private readonly backoff: Backoff;
  private readonly eventCredit: number;
  private readonly helloTimeoutMs: number;
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private channels = new Map<number, ChannelHandler>();
  /** Frames that arrived for a channel before its handler was registered (attach reply race). */
  private early = new Map<number, Array<{ kind: number; payload: Buffer }>>();
  /** Channels we closed whose CLOSE echo hasn't come back: their late frames are dropped. */
  private closing = new Set<number>();
  private helloTimer: NodeJS.Timeout | null = null;
  private eventListener: ((n: CoreNotification) => void) | null = null;
  private eventChannel: number | null = null;
  private eventLines = new LineSplitter();
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ready = false;
  private helloInfo: HelloResult | null = null;

  constructor(private readonly opts: CoreClientOptions) {
    super();
    this.log = opts.logger ?? silentLogger;
    this.callTimeoutMs = opts.callTimeoutMs ?? 10_000;
    this.watchdogMs = opts.watchdogMs ?? 45_000;
    this.backoff = opts.backoff ?? new Backoff();
    this.eventCredit = opts.eventCredit ?? 1024 * 1024;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  }

  /** Frames held for channels without a handler (tests: must not grow). */
  get bufferedFrames(): number {
    let n = 0;
    for (const q of this.early.values()) n += q.length;
    return n;
  }

  /** Drops the connection and reconnects (with backoff), e.g. when the subscription failed. */
  reconnect(reason: string): void {
    if (!this.socket) return;
    this.log.warn({ reason }, 'reconnecting to herdr-core');
    this.socket.destroy();
  }

  get connected(): boolean {
    return this.ready;
  }

  get hello(): HelloResult | null {
    return this.helloInfo;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown(new CoreUnavailableError('core client stopped'), false);
  }

  /** Calls a method on channel 0. Rejects with RpcError, CoreUnavailableError or PolicyError. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.callTimeoutMs): Promise<T> {
    try {
      checkCall(method, params);
    } catch (e) {
      return Promise.reject(e);
    }
    const sock = this.socket;
    if (!sock || !this.ready) return Promise.reject(new CoreUnavailableError());
    return this.rawCall<T>(sock, method, params, timeoutMs);
  }

  /**
   * Subscribes to events; `listener` gets every notification until the
   * connection drops. Returns the snapshot to apply them to.
   */
  async subscribe(listener: (n: CoreNotification) => void, params: Record<string, unknown> = {}): Promise<CoreSnapshot> {
    this.eventListener = listener;
    this.eventLines = new LineSplitter();
    const result = await this.call<CoreSnapshot>('events.subscribe', params);
    if (typeof result.channel === 'number') {
      this.eventChannel = result.channel;
      this.sendFrame(result.channel, FrameKind.CREDIT, creditPayload(this.eventCredit));
      for (const f of this.early.get(result.channel) ?? []) this.onEventData(f.kind, f.payload);
      this.early.delete(result.channel);
    }
    this.kickWatchdog();
    return result;
  }

  /** Routes a stream channel's frames to `handler` (frames that came early are replayed). */
  openChannel(channel: number, handler: ChannelHandler): void {
    this.channels.set(channel, handler);
    for (const f of this.early.get(channel) ?? []) handler.onFrame(f.kind, f.payload);
    this.early.delete(channel);
  }

  closeChannel(channel: number, sendClose = true): void {
    this.channels.delete(channel);
    this.early.delete(channel);
    if (sendClose && this.sendFrame(channel, FrameKind.CLOSE)) {
      // Ids are never reused; a core that never echoes must not grow this either.
      if (this.closing.size >= 4096) this.closing.delete(this.closing.values().next().value as number);
      this.closing.add(channel);
    }
  }

  sendFrame(channel: number, kind: number, payload?: Buffer | string): boolean {
    const sock = this.socket;
    if (!sock || !this.ready) return false;
    return sock.write(encodeFrame(channel, kind, payload));
  }

  // ---- connection ----

  private connect(): void {
    if (this.stopped) return;
    const sock = net.createConnection(this.opts.socketPath);
    this.socket = sock;
    this.decoder = new FrameDecoder();
    let greeted = false;
    let plain = Buffer.alloc(0);

    this.helloTimer = setTimeout(() => {
      if (this.socket === sock && !greeted) {
        this.log.warn({ ms: this.helloTimeoutMs }, 'herdr-core did not answer hello; retrying');
        sock.destroy();
      }
    }, this.helloTimeoutMs);
    this.helloTimer.unref();
    sock.on('connect', () => {
      // The hello reply is a plain line; frames follow it.
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { generation: GENERATION, framed: true } })}\n`);
    });
    sock.on('data', (chunk: Buffer) => {
      if (this.socket !== sock) return;
      if (!greeted) {
        plain = Buffer.concat([plain, chunk]);
        const nl = plain.indexOf(0x0a);
        if (nl < 0) return;
        greeted = true;
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        const rest = plain.subarray(nl + 1);
        if (!this.onHello(sock, plain.subarray(0, nl).toString('utf8'))) return;
        if (rest.length > 0) this.onBytes(rest);
        return;
      }
      this.onBytes(chunk);
    });
    sock.on('error', (err) => {
      if (this.socket === sock) this.log.debug({ err: err.message }, 'core socket error');
    });
    sock.on('close', () => {
      if (this.socket === sock) this.teardown(new CoreUnavailableError('core connection closed'), true);
    });
  }

  private onHello(sock: net.Socket, line: string): boolean {
    let msg: { result?: HelloResult; error?: RpcErrorBody };
    try {
      msg = JSON.parse(line);
    } catch {
      sock.destroy(new Error('bad hello reply'));
      return false;
    }
    const r = msg.result;
    if (!r || msg.error || r.framed !== true || (r.generation !== undefined && r.generation !== GENERATION)) {
      this.log.error({ reply: line.slice(0, 300) }, 'herdr-core refused framed generation-1 hello');
      sock.destroy();
      return false;
    }
    this.helloInfo = r;
    this.ready = true;
    this.backoff.reset();
    this.log.info({ version: r.version, core: r.core?.name }, 'connected to herdr-core');
    this.emit('ready', r);
    return true;
  }

  private onBytes(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'bad frame from core');
      this.socket?.destroy();
      return;
    }
    for (const f of frames) {
      if (f.channel === 0) {
        if (f.kind === FrameKind.DATA) this.onRpc(f.payload.toString('utf8'));
        continue;
      }
      if (f.channel === this.eventChannel) {
        this.onEventData(f.kind, f.payload);
        continue;
      }
      const h = this.channels.get(f.channel);
      if (h) h.onFrame(f.kind, f.payload);
      else if (this.closing.has(f.channel)) {
        // Late output of a channel we closed; its CLOSE echo ends it.
        if (f.kind === FrameKind.CLOSE) this.closing.delete(f.channel);
      } else {
        let q = this.early.get(f.channel);
        if (!q) {
          // Only attach replies in flight wait here: a few channels at most.
          if (this.early.size >= 64) this.early.delete(this.early.keys().next().value as number);
          q = [];
          this.early.set(f.channel, q);
        }
        if (q.length < 256) q.push({ kind: f.kind, payload: f.payload });
      }
    }
  }

  private onEventData(kind: number, payload: Buffer): void {
    this.kickWatchdog();
    if (kind === FrameKind.CLOSE) {
      // window.rs re-subscribes when its event stream ends.
      this.log.warn('herdr-core closed the event subscription; subscribing again');
      this.eventChannel = null;
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = null;
      this.emit('eventsClosed');
      return;
    }
    if (kind !== FrameKind.DATA) return;
    if (this.eventChannel !== null) this.sendFrame(this.eventChannel, FrameKind.CREDIT, creditPayload(payload.length));
    for (const line of this.eventLines.push(payload)) this.onRpc(line);
  }

  private onRpc(text: string): void {
    let msg: { id?: number; result?: unknown; error?: RpcErrorBody; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      this.log.warn({ text: text.slice(0, 200) }, 'unparseable message from core');
      return;
    }
    if (typeof msg.id === 'number' && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(p.method, msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.kickWatchdog();
      this.eventListener?.({ method: msg.method, params: msg.params ?? {} });
    }
  }

  private rawCall<T>(sock: net.Socket, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CoreUnavailableError(`${method}: no reply from core in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(encodeFrame(0, FrameKind.DATA, JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  }

  private kickWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.eventChannel === null && !this.eventListener) return;
    this.watchdog = setTimeout(() => {
      this.log.warn({ ms: this.watchdogMs }, 'no events or heartbeats from core; reconnecting');
      this.socket?.destroy();
    }, this.watchdogMs);
    this.watchdog.unref();
  }

  private teardown(err: Error, reconnect: boolean): void {
    const wasReady = this.ready;
    this.ready = false;
    const sock = this.socket;
    this.socket = null;
    sock?.removeAllListeners('data');
    sock?.destroy();
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const h of this.channels.values()) h.onDrop();
    this.channels.clear();
    this.early.clear();
    this.closing.clear();
    this.eventChannel = null;
    this.eventListener = null;
    if (wasReady) this.emit('down', err);
    else if (reconnect) this.emit('failed', err);
    if (reconnect && !this.stopped) {
      const delay = this.backoff.next();
      this.log.debug({ delay }, 'reconnecting to herdr-core');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }
  }
}
