import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type AttentionAlert,
  type ClientMessage,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
  type World,
} from '@herdr-mobile/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionStore } from '../auth/sessions.js';
import { sessionCookie } from '../auth/token.js';
import { type Logger, silentLogger } from '../log.js';
import type { StreamSink } from '../terminal/subscriber.js';
import type { ConversationSession } from './conversation.js';
import type { HostCheck } from './guard.js';
import { isNetworkSocket } from './listen.js';
import type { StreamLog } from './log.js';
import { rawRefusal } from './security.js';
import type { TerminalSession } from './terminal.js';

export const WS_PATH = '/ws';
/** A client this far behind is dropped; it resumes or reloads when it reconnects. */
const MAX_BUFFERED = 8 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 3000;
/** Signed out (revoked); the client checks its session and shows the sign-in screen. */
export const CLOSE_SIGNED_OUT = 4401;

export interface WsTransportOptions {
  /** WebSockets authenticate by the device's session cookie only (never a token in the URL). */
  sessions: SessionStore;
  log: StreamLog;
  world: () => World;
  recentAlerts: () => AttentionAlert[];
  /** The person is looking at these terminals, per client (empty: nothing / gone). */
  onLooking?: (clientId: string, terminalIds: string[]) => void;
  /** Creates a client's terminal side (streams and input); none: terminal messages are refused. */
  terminals?: (sink: StreamSink) => TerminalSession;
  /** Creates a client's conversation streams; none: conversation messages are refused. */
  conversations?: (send: (m: ServerMessage) => void) => ConversationSession;
  heartbeatMs?: number;
  logger?: Logger;
  /** Host names to answer to (DNS rebinding guard). */
  hosts?: HostCheck;
  /** The client's address (honours X-Forwarded-For behind a trusted local proxy). */
  addressOf?: (req: http.IncomingMessage) => string;
  /** Open WebSockets per peer address on network listeners (loopback is not limited). */
  maxPerPeer?: number;
}

interface Session {
  id: string;
  /** The signed-in device (auth/sessions.ts) this socket belongs to. */
  device: string;
  /** Peer address for the per-peer cap; '' when not limited (loopback). */
  peer: string;
  ws: WebSocket;
  synced: boolean;
  alive: boolean;
  helloTimer: NodeJS.Timeout | null;
  term: TerminalSession | null;
  conv: ConversationSession | null;
}

/**
 * The WebSocket side: snapshot on connect (or a replay when resuming), then
 * every patch and alert in `seq` order, plus heartbeats.
 */
export class WsTransport {
  readonly serverId = randomUUID();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  private readonly sessions = new Set<Session>();
  private readonly log: Logger;
  private readonly heartbeatMs: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly perPeer = new Map<string, number>();
  /** `device ip day` already logged, so a reconnecting phone logs once a day per address. */
  private readonly seen = new Set<string>();

  constructor(private readonly opts: WsTransportOptions) {
    this.log = opts.logger ?? silentLogger;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  attach(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
    this.heartbeat.unref();
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.sessions) s.ws.terminate();
    this.sessions.clear();
    this.wss.close();
  }

  /** Closes the sockets of devices that were signed out. */
  closeDevices(ids: readonly string[]): void {
    const gone = new Set(ids);
    for (const s of this.sessions) if (gone.has(s.device)) s.ws.close(CLOSE_SIGNED_OUT, 'signed out');
  }

  /** Sends a numbered message (already in the log) to every synced client. */
  publish(m: ServerMessage): void {
    const text = JSON.stringify(m);
    for (const s of this.sessions) if (s.synced) this.sendText(s, text);
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    // Every refusal happens before the upgrade: an unauthenticated client never gets a single frame parsed.
    const refuse = (status: number) => {
      socket.end(rawRefusal(status));
      setTimeout(() => socket.destroy(), 1000).unref();
    };
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      refuse(404);
      return;
    }
    if (this.opts.hosts && !this.opts.hosts.allows(req.headers.host, !isNetworkSocket(req.socket))) {
      refuse(421);
      return;
    }
    // Browsers always send Origin on WebSockets: refuse other sites' pages (cross-site WebSocket hijacking).
    if (!sameOrigin(req)) {
      refuse(403);
      return;
    }
    const addr = this.opts.addressOf?.(req) ?? req.socket.remoteAddress ?? '';
    const found = this.opts.sessions.verify(sessionCookie(req.headers), addr);
    if (!found) {
      refuse(401);
      return;
    }
    const peer = isNetworkSocket(req.socket) ? (req.socket.remoteAddress ?? '') : '';
    if (peer && (this.perPeer.get(peer) ?? 0) >= (this.opts.maxPerPeer ?? 8)) {
      this.log.warn({ ip: peer }, 'too many WebSockets from this address');
      refuse(429);
      return;
    }
    const device = found.session;
    const day = new Date().toISOString().slice(0, 10);
    const key = `${device.id} ${addr} ${day}`;
    if (!this.seen.has(key)) {
      if (this.seen.size > 10_000) this.seen.clear();
      this.seen.add(key);
      this.log.info({ ip: addr, device: device.id, name: device.name }, 'device connected');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, device.id, peer));
  }

  private onConnection(ws: WebSocket, device: string, peer: string): void {
    const s: Session = { id: randomUUID(), device, peer, ws, synced: false, alive: true, helloTimer: null, term: null, conv: null };
    if (peer) this.perPeer.set(peer, (this.perPeer.get(peer) ?? 0) + 1);
    s.term =
      this.opts.terminals?.({
        sendJson: (m) => this.send(s, m),
        sendBinary: (stream, chunks) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const head = Buffer.allocUnsafe(4);
          head.writeUInt32LE(stream, 0);
          ws.send(Buffer.concat([head, ...chunks]), { binary: true });
        },
        bufferedAmount: () => ws.bufferedAmount,
        isOpen: () => ws.readyState === WebSocket.OPEN,
      }) ?? null;
    s.conv = this.opts.conversations?.((m) => this.send(s, m)) ?? null;
    this.sessions.add(s);
    this.send(s, { t: 'welcome', v: PROTOCOL_VERSION, serverId: this.serverId, heartbeatMs: this.heartbeatMs });
    // Old or minimal clients that never say hello still get a snapshot.
    s.helloTimer = setTimeout(() => this.sync(s, undefined), HELLO_TIMEOUT_MS);
    ws.on('pong', () => {
      s.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (s.term) s.term.onBinary(buf);
        else this.send(s, { t: 'error', code: 'unavailable', message: 'terminal streams are not available' });
        return;
      }
      const msg = parseClientMessage(data.toString());
      if (!msg) {
        this.send(s, { t: 'error', code: 'bad_message', message: 'unknown or malformed message' });
        return;
      }
      this.onMessage(s, msg);
    });
    ws.on('close', () => {
      if (s.helloTimer) clearTimeout(s.helloTimer);
      s.term?.close();
      s.conv?.close();
      this.sessions.delete(s);
      if (s.peer) {
        const n = (this.perPeer.get(s.peer) ?? 1) - 1;
        if (n <= 0) this.perPeer.delete(s.peer);
        else this.perPeer.set(s.peer, n);
      }
      this.opts.onLooking?.(s.id, []);
    });
    ws.on('error', (err) => this.log.debug({ err: err.message }, 'ws client error'));
  }

  private onMessage(s: Session, msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello':
        if (msg.v !== PROTOCOL_VERSION) {
          this.send(s, { t: 'error', code: 'version', message: `server speaks protocol ${PROTOCOL_VERSION}, client ${msg.v}` });
          s.ws.close(4000, 'protocol version');
          return;
        }
        this.sync(s, msg.resume);
        return;
      case 'ping':
        this.send(s, { t: 'hb', seq: this.opts.log.seq, ts: Date.now() });
        return;
      case 'looking':
        this.opts.onLooking?.(s.id, msg.terminalIds);
        return;
      case 'conv.open':
      case 'conv.more':
      case 'conv.close':
        if (s.conv) s.conv.onMessage(msg);
        else this.send(s, { t: 'error', code: 'unavailable', message: `${msg.t} is not available in this bridge version` });
        return;
      default:
        if (s.term) s.term.onMessage(msg);
        else this.send(s, { t: 'error', code: 'unavailable', message: `${msg.t} is not available in this bridge version` });
    }
  }

  private sync(s: Session, resume: { serverId: string; seq: number } | undefined): void {
    if (s.helloTimer) clearTimeout(s.helloTimer);
    s.helloTimer = null;
    if (s.synced) return;
    const missed = resume && resume.serverId === this.serverId ? this.opts.log.since(resume.seq) : null;
    if (missed) {
      for (const m of missed) this.send(s, m);
    } else {
      this.send(s, { t: 'snapshot', seq: this.opts.log.seq, world: this.opts.world(), alerts: this.opts.recentAlerts() });
    }
    s.synced = true;
  }

  private beat(): void {
    const hb = JSON.stringify({ t: 'hb', seq: this.opts.log.seq, ts: Date.now() } satisfies ServerMessage);
    for (const s of this.sessions) {
      if (!s.alive) {
        s.ws.terminate();
        continue;
      }
      s.alive = false;
      s.ws.ping();
      if (s.synced) this.sendText(s, hb);
    }
  }

  private send(s: Session, m: ServerMessage): void {
    this.sendText(s, JSON.stringify(m));
  }

  private sendText(s: Session, text: string): void {
    if (s.ws.readyState !== WebSocket.OPEN) return;
    if (s.ws.bufferedAmount > MAX_BUFFERED) {
      this.log.warn({ client: s.id }, 'client too far behind; dropping it');
      s.ws.terminate();
      return;
    }
    s.ws.send(text);
  }
}

/** No Origin (not a browser) or an Origin whose host:port is the one the request was sent to. */
export function sameOrigin(req: Pick<http.IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}
