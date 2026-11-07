import fs from 'node:fs';
import net from 'node:net';
import { encodeFrame, FrameDecoder, FrameKind } from '../../src/core/frames.js';
import type { CoreTerminal } from '../../src/core/types.js';

export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

interface Conn {
  sock: net.Socket;
  framed: boolean;
  eventChannel: number | null;
  credit: number;
  nextChannel: number;
}

/** An attach stream, with herdr-core's size rule (viewers.rs `apply_size`). */
export interface FakeViewer {
  conn: Conn;
  channel: number;
  terminal: string;
  observe: boolean;
  notify: boolean;
  size: [number, number];
  /** null: attached `resumed` and not active since. */
  activeAt: number | null;
}

/** Every input that reached a program. */
export interface FakeInput {
  terminal: string;
  bytes: string;
  via: 'attach' | 'send';
}

/**
 * A herdr-core stand-in on a unix socket: plain hello, then framed JSON-RPC,
 * `events.subscribe` with a snapshot and an event channel of newline-delimited
 * JSON, `doc.get`, `machine.list`. Shapes copied from real captures
 * (SCOPING.md 2.x, data/events_sample.txt).
 */
export class FakeCore {
  readonly calls: RecordedCall[] = [];
  terminals = new Map<string, CoreTerminal>();
  docs = new Map<string, { value: unknown; version: number }>();
  /** What `machine.list` answers (names). */
  machines: string[] = [];
  seq = 100;
  /** Delay replies to these methods (ms), to test out-of-order correlation. */
  delays: Record<string, number> = {};
  readonly viewers: FakeViewer[] = [];
  readonly inputs: FakeInput[] = [];
  /** Every grid a terminal was set to, in order. */
  readonly sizeLog: Array<{ terminal: string; cols: number; rows: number }> = [];
  /** What each terminal's screen shows (the fake's "paint"). */
  readonly screens = new Map<string, string>();
  /** Programs echo their input (like a shell's line editor). */
  echo = true;
  /** Fail the next N calls of a method (core error `internal`). */
  failNext: Record<string, number> = {};
  /** Attach replies confirm `automatic_input` (herdr-core >= 0.1.18 does). */
  automaticInput = true;
  /** Observers asking for resize notifications get them (off: an older core, or one that lags). */
  resizeNotify = true;
  /** Answer these methods at once but put the reply on the wire after the next delay in the list (out-of-order replies). */
  replyDelays: Record<string, number[]> = {};
  /** machine.exec of `git -C <cwd> rev-parse ...`: stdout by cwd (else git's "not a git repository"). */
  execResults: Record<string, string> = {};
  /** `terminal.read` replies by terminal (herdr-core stitches a full-screen app's history); calls are logged. */
  reads: Record<string, { text: string; complete: boolean; how: string; why?: string }> = {};
  readonly readLog: Array<Record<string, unknown>> = [];
  /** What `templates.list` answers. */
  templates: Array<{ name: string; description: string; command: string; error?: string | null }> = [];
  /** Called after `terminal.run` made a terminal (a test plays the Herdr window adopting it). */
  onRun: ((t: CoreTerminal) => void) | null = null;
  private nextAddress = 100;
  /** Never answer `hello` (a hung core). */
  silentHello = false;
  /** Every `automatic` (kind 6) input, which never makes its viewer the size leader. */
  readonly automatic: FakeInput[] = [];
  private activity = 0;
  private server: net.Server | null = null;
  private conns = new Set<Conn>();

  constructor(readonly socketPath: string) {}

  async listen(): Promise<void> {
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
    const server = net.createServer((sock) => this.onConnection(sock));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.socketPath, resolve));
  }

  /** Simulates the core going away (and its seq restarting when it comes back). */
  async close(): Promise<void> {
    for (const c of this.conns) c.sock.destroy();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async restart(): Promise<void> {
    await this.close();
    this.seq = 1;
    await this.listen();
  }

  get subscribers(): number {
    return [...this.conns].filter((c) => c.eventChannel !== null).length;
  }

  /** Applies an event to the fake's own state the way core would, then streams it. */
  emit(type: string, terminal: string | undefined, data: unknown, extra: Record<string, unknown> = {}): number {
    const seq = ++this.seq;
    if (terminal) this.applyLocal(type, terminal, data);
    this.broadcast({ jsonrpc: '2.0', method: 'event', params: { seq, terminal, type, data, ...extra } });
    return seq;
  }

  status(terminal: string, state: string | null, app = 'claude-code'): number {
    const status = state === null ? null : { app, state };
    return this.emit('status', terminal, { status, records: status ? { [app]: status } : {}, reported: true });
  }

  turn(terminal: string): number {
    const t = this.terminals.get(terminal);
    const turn = (t?.turn ?? 0) + 1;
    return this.emit('turn', terminal, { turn, state: 'done' });
  }

  labels(terminal: string, labels: Record<string, string>): number {
    return this.emit('labels', terminal, { labels });
  }

  setDoc(name: string, value: unknown, machine?: string): void {
    const key = machine ? `${machine}:${name}` : name;
    const version = (this.docs.get(key)?.version ?? 0) + 1;
    this.docs.set(key, { value, version });
    this.emit('doc', undefined, { name, version }, machine ? { machine } : {});
  }

  /** The core ends the event subscription (CLOSE on the event channel), as it may on overload. */
  closeEvents(): void {
    for (const c of this.conns) {
      if (c.eventChannel === null) continue;
      c.sock.write(encodeFrame(c.eventChannel, FrameKind.CLOSE));
      c.eventChannel = null;
    }
  }

  heartbeat(): void {
    this.broadcast({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: this.seq } });
  }

  private applyLocal(type: string, address: string, data: unknown): void {
    const d = (data ?? {}) as Record<string, unknown>;
    if (type === 'created' || type === 'restarted') {
      this.terminals.set(address, structuredClone(d as CoreTerminal));
      return;
    }
    if (type === 'removed') {
      this.terminals.delete(address);
      return;
    }
    const t = this.terminals.get(address);
    if (!t) return;
    if (type === 'status') Object.assign(t, { status: d.status, records: d.records, reported: d.reported });
    if (type === 'turn') t.turn = d.turn as number;
    if (type === 'labels') t.labels = d.labels as Record<string, string>;
    if (type === 'size') Object.assign(t, { cols: d.cols, rows: d.rows });
    if (type === 'title') t.title = d.title as string;
  }

  /** The program printed `text`: every viewer of the terminal gets it. */
  output(address: string, text: string): void {
    this.screens.set(address, (this.screens.get(address) ?? '') + text);
    for (const v of this.viewers.filter((x) => x.terminal === address)) this.frame(v, FrameKind.DATA, Buffer.from(text));
  }

  /** The program ended: streams close with the reason. */
  exit(address: string): void {
    for (const v of this.viewers.filter((x) => x.terminal === address)) {
      this.frame(v, FrameKind.CLOSE, JSON.stringify({ reason: 'exited', exit_code: 0, signal: null }));
      this.viewers.splice(this.viewers.indexOf(v), 1);
    }
  }

  /** A typing viewer that isn't the bridge (the desktop app): it sets the size when attached. */
  addDesktop(address: string, cols: number, rows: number): FakeViewer {
    const conn = { sock: { destroyed: true } as net.Socket, framed: true, eventChannel: null, credit: 0, nextChannel: 2 };
    const v: FakeViewer = {
      conn,
      channel: 1,
      terminal: address,
      observe: false,
      notify: false,
      size: [cols, rows],
      activeAt: ++this.activity,
    };
    this.viewers.push(v);
    this.applySize(address);
    return v;
  }

  removeViewer(v: FakeViewer): void {
    this.detach(v);
  }

  viewersOf(address: string): FakeViewer[] {
    return this.viewers.filter((v) => v.terminal === address);
  }

  /** A desktop-like viewer on its own connection resizes (makes itself the size leader). */
  resizeViewer(v: FakeViewer, cols: number, rows: number): void {
    v.size = [cols, rows];
    if (!v.observe) v.activeAt = ++this.activity;
    this.applySize(v.terminal);
  }

  private program(address: string, bytes: string, via: FakeInput['via']): void {
    this.inputs.push({ terminal: address, bytes, via });
    if (this.echo) this.output(address, bytes);
  }

  private paint(address: string): Buffer {
    return Buffer.from(`\x18\x1b[H\x1b[2J${this.screens.get(address) ?? ''}`);
  }

  private onViewerFrame(c: Conn, channel: number, kind: number, payload: Buffer): void {
    const v = this.viewers.find((x) => x.conn === c && x.channel === channel);
    if (!v) return;
    if (kind === FrameKind.CLOSE) {
      this.detach(v);
      c.sock.write(encodeFrame(channel, FrameKind.CLOSE));
      return;
    }
    if (kind === FrameKind.AUTOMATIC_INPUT) {
      if (v.observe || !this.automaticInput) return;
      this.automatic.push({ terminal: v.terminal, bytes: payload.toString('utf8'), via: 'attach' });
      this.program(v.terminal, payload.toString('utf8'), 'attach');
      return;
    }
    if (kind === FrameKind.DATA) {
      if (v.observe) return;
      v.activeAt = ++this.activity;
      this.applySize(v.terminal);
      this.program(v.terminal, payload.toString('utf8'), 'attach');
      return;
    }
    if (kind === FrameKind.RESIZE && !v.observe) this.resizeViewer(v, payload.readUInt16LE(0), payload.readUInt16LE(2));
  }

  private detach(v: FakeViewer): void {
    const i = this.viewers.indexOf(v);
    if (i < 0) return;
    this.viewers.splice(i, 1);
    this.applySize(v.terminal, !v.observe);
  }

  /** viewers.rs `apply_size`: the most recently active typing viewer's size, else headless 200x120. */
  private applySize(address: string, leaving = false): void {
    const t = this.terminals.get(address);
    if (!t) return;
    let leader: FakeViewer | null = null;
    for (const v of this.viewersOf(address)) {
      if (v.observe) continue;
      if (!leader || (v.activeAt ?? -1) >= (leader.activeAt ?? -1)) leader = v;
    }
    // Untouched records keep their fixture size until the last typing viewer leaves.
    if (!leader && !leaving) return;
    const [cols, rows] = leader ? leader.size : [200, 120];
    if ((t.cols === cols && t.rows === rows) || cols === 0 || rows === 0) return;
    this.sizeLog.push({ terminal: address, cols, rows });
    for (const v of this.viewersOf(address).filter((x) => x.notify)) {
      this.frame(v, FrameKind.RESIZE, grid(cols, rows));
      this.frame(v, FrameKind.DATA, this.paint(address));
    }
    this.emit('size', address, { cols, rows });
  }

  private frame(v: FakeViewer, kind: number, payload: Buffer | string): void {
    if (!v.conn.sock.destroyed) v.conn.sock.write(encodeFrame(v.channel, kind, payload));
  }

  private broadcast(msg: unknown): void {
    const line = Buffer.from(`${JSON.stringify(msg)}\n`);
    for (const c of this.conns) {
      if (c.eventChannel === null) continue;
      // Split some lines across frames, as a real byte stream may.
      if (line.length > 40) {
        c.sock.write(encodeFrame(c.eventChannel, FrameKind.DATA, line.subarray(0, 20)));
        c.sock.write(encodeFrame(c.eventChannel, FrameKind.DATA, line.subarray(20)));
      } else c.sock.write(encodeFrame(c.eventChannel, FrameKind.DATA, line));
    }
  }

  private onConnection(sock: net.Socket): void {
    const c: Conn = { sock, framed: false, eventChannel: null, credit: 256 * 1024, nextChannel: 2 };
    this.conns.add(c);
    let plain = Buffer.alloc(0);
    const decoder = new FrameDecoder();
    sock.on('close', () => {
      this.conns.delete(c);
      for (const v of this.viewers.filter((x) => x.conn === c)) this.detach(v);
    });
    sock.on('error', () => {});
    sock.on('data', (chunk: Buffer) => {
      if (!c.framed) {
        plain = Buffer.concat([plain, chunk]);
        const nl = plain.indexOf(0x0a);
        if (nl < 0) return;
        const hello = JSON.parse(plain.subarray(0, nl).toString());
        this.calls.push({ method: hello.method, params: hello.params });
        if (this.silentHello) return;
        sock.write(
          `${JSON.stringify({
            id: hello.id,
            jsonrpc: '2.0',
            result: {
              core: { id: 'fake', name: 'fakebox' },
              features: ['framed', 'attach', 'events', 'status'],
              framed: true,
              generation: 1,
              version: '0.1.18',
            },
          })}\n`,
        );
        c.framed = true;
        const rest = plain.subarray(nl + 1);
        if (rest.length) chunk = rest;
        else return;
      }
      for (const f of decoder.push(chunk)) {
        if (f.channel === 0 && f.kind === FrameKind.DATA) this.onRpc(c, JSON.parse(f.payload.toString()));
        else if (f.kind === FrameKind.CREDIT) c.credit += f.payload.readUInt32LE(0);
        else this.onViewerFrame(c, f.channel, f.kind, f.payload);
      }
    });
  }

  private onRpc(c: Conn, msg: { id: number; method: string; params: Record<string, unknown> }): void {
    this.calls.push({ method: msg.method, params: msg.params });
    const later = this.replyDelays[msg.method]?.shift();
    const reply = (result: unknown) => {
      const bytes = encodeFrame(0, FrameKind.DATA, JSON.stringify({ id: msg.id, jsonrpc: '2.0', result }));
      if (later) setTimeout(() => c.sock.write(bytes), later);
      else c.sock.write(bytes);
    };
    const fail = (message: string, kind: string) =>
      c.sock.write(
        encodeFrame(0, FrameKind.DATA, JSON.stringify({ id: msg.id, jsonrpc: '2.0', error: { code: -32000, message, data: { kind } } })),
      );
    const run = () => {
      if ((this.failNext[msg.method] ?? 0) > 0) {
        this.failNext[msg.method] = (this.failNext[msg.method] ?? 0) - 1;
        return fail(`${msg.method} failed`, 'internal');
      }
      switch (msg.method) {
        case 'events.subscribe':
          c.eventChannel = 1;
          reply({ channel: 1, seq: this.seq, terminals: [...this.terminals.values()] });
          return;
        case 'doc.get': {
          const key = msg.params.on ? `${msg.params.on}:${msg.params.name}` : String(msg.params.name);
          const d = this.docs.get(key);
          reply(d ? { value: d.value, version: d.version } : { value: null, version: 0 });
          return;
        }
        case 'machine.exec': {
          const argv = (msg.params.argv as string[]) ?? [];
          const out = this.execResults[argv[2] ?? ''];
          const b64 = (x: string) => Buffer.from(x).toString('base64');
          reply(
            out === undefined
              ? {
                  code: 128,
                  signal: null,
                  stdout: '',
                  stderr: b64('fatal: not a git repository'),
                  truncated: false,
                  timed_out: false,
                  ms: 1,
                }
              : { code: 0, signal: null, stdout: b64(out), stderr: '', truncated: false, timed_out: false, ms: 1 },
          );
          return;
        }
        case 'machine.list':
          reply({ machines: this.machines.map((name) => ({ name })) });
          return;
        case 'server.status':
          reply({ ok: true, echo: msg.params });
          return;
        case 'terminal.get': {
          const t = this.terminals.get(String(msg.params.terminal));
          if (!t) fail(`no terminal ${msg.params.terminal}`, 'not_found');
          else reply(t);
          return;
        }
        case 'terminal.read': {
          this.readLog.push(msg.params);
          const r = this.reads[String(msg.params.terminal)];
          if (!r) fail(`no terminal ${msg.params.terminal}`, 'not_found');
          else reply(r);
          return;
        }
        case 'terminal.attach': {
          const address = String(msg.params.terminal);
          const t = this.terminals.get(address);
          if (!t) return fail(`no terminal ${address}`, 'not_found');
          if (t.state !== 'live') return fail(`${address} has finished`, 'finished');
          const p = msg.params as { cols: number; rows: number; observe?: boolean; resize_notifications?: boolean; resumed?: boolean };
          const v: FakeViewer = {
            conn: c,
            channel: c.nextChannel++,
            terminal: address,
            observe: p.observe === true,
            notify: p.observe === true && p.resize_notifications === true && this.resizeNotify,
            size: [p.cols, p.rows],
            activeAt: p.resumed ? null : ++this.activity,
          };
          this.viewers.push(v);
          this.applySize(address);
          reply({ channel: v.channel, automatic_input: this.automaticInput, resize_notifications: v.notify });
          if (v.notify) this.frame(v, FrameKind.RESIZE, grid(t.cols ?? 0, t.rows ?? 0));
          this.frame(v, FrameKind.DATA, this.paint(address));
          return;
        }
        case 'terminal.send': {
          const address = String(msg.params.terminal);
          const t = this.terminals.get(address);
          if (!t) return fail(`no terminal ${address}`, 'not_found');
          const word = typeof t.status === 'object' && t.status ? t.status.state : null;
          if (word === 'blocked' && msg.params.force !== true) return fail(`${address} is blocked`, 'blocked');
          this.program(address, `${msg.params.text}\r`, 'send');
          reply({ status: word, turn: t.turn ?? 0, started: null });
          return;
        }
        case 'terminal.label': {
          const address = String(msg.params.terminal);
          const t = this.terminals.get(address);
          if (!t) return fail(`no terminal ${address}`, 'not_found');
          const labels = { ...(t.labels ?? {}) };
          for (const [k, val] of Object.entries(msg.params.labels as Record<string, string>)) {
            if (val === '') delete labels[k];
            else labels[k] = val;
          }
          this.emit('labels', address, { labels });
          reply(this.terminals.get(address));
          return;
        }
        case 'templates.list':
          reply({ templates: this.templates });
          return;
        case 'terminal.run': {
          const p = msg.params as {
            argv?: string[];
            cwd?: string;
            labels?: Record<string, string>;
            keep?: boolean;
            size?: { cols: number; rows: number };
          };
          const address = `t${this.nextAddress++}`;
          const t: CoreTerminal = {
            ...(this.terminals.values().next().value as CoreTerminal),
            address,
            argv: p.argv ?? [],
            cwd: p.cwd ?? '/',
            labels: { ...(p.labels ?? {}) },
            keep: p.keep === true,
            cols: p.size?.cols ?? 200,
            rows: p.size?.rows ?? 120,
            name: null,
            parent: null,
            state: 'live',
            status: null,
            reported: false,
            turn: 0,
          };
          this.emit('created', address, t);
          reply({ address });
          this.onRun?.(t);
          return;
        }
        case 'terminal.kill': {
          const address = String(msg.params.terminal);
          const t = this.terminals.get(address);
          if (!t) return fail(`no terminal ${address}`, 'not_found');
          this.emit('finished', address, { reason: 'killed' });
          t.state = 'finished';
          reply(t);
          return;
        }
        case 'terminal.rm': {
          const address = String(msg.params.terminal);
          const t = this.terminals.get(address);
          if (!t) return fail(`no terminal ${address}`, 'not_found');
          if (t.state === 'live') return fail(`${address} is live`, 'live');
          this.emit('removed', address, {});
          reply({ removed: true });
          return;
        }
        default:
          fail(`no method ${msg.method}`, 'not_found');
      }
    };
    const delay = this.delays[msg.method];
    if (delay) setTimeout(run, delay);
    else run();
  }
}

function grid(cols: number, rows: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(cols, 0);
  b.writeUInt16LE(rows, 2);
  return b;
}
