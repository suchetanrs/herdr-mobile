import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { encodeInputFrame, type ServerMessage } from '@herdr-mobile/protocol';
import headlessPkg from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type Bridge, createBridge } from '../src/app.js';
import type { Config } from '../src/config.js';
import { signIn } from './helpers/bridge.js';
import { FakeCore } from './helpers/fakeCore.js';
import { agent, layoutDoc, standardTerminals } from './helpers/fixtures.js';
import { rmDir, sleep, tmpDir, until } from './helpers/tmp.js';

const { Terminal } = headlessPkg;
const TOKEN = 'test-token-0123456789-abcdefghijklmnop';
let cookie = '';

let dir: string;
let core: FakeCore;
let bridge: Bridge;
let base: string;
const clients: TermClient[] = [];

async function start(over: Partial<Config> = {}): Promise<void> {
  dir = tmpDir('term');
  core = new FakeCore(path.join(dir, 'core.sock'));
  for (const t of standardTerminals()) core.terminals.set(t.address, t);
  core.docs.set('herdr-app', { value: layoutDoc(), version: 7 });
  core.screens.set('t3', 'me@box:~$ ');
  await core.listen();
  bridge = createBridge({
    host: '127.0.0.1',
    port: 0,
    socketPath: core.socketPath,
    configDir: path.join(dir, 'cfg'),
    token: TOKEN,
    doneGraceMs: 100,
    heartbeatMs: 15_000,
    logLevel: 'silent',
    home: '/home/me',
    includeUnplaced: false,
    seenSync: false,
    streamGraceMs: 150,
    webDir: path.join(dir, 'web'),
    herdrAppDir: path.join(dir, 'herdr-app'),
    ...over,
  });
  await bridge.start();
  base = `127.0.0.1:${(bridge.http.server.address() as AddressInfo).port}`;
  cookie = await signIn(base);
  await until(() => bridge.store.world.spaceOrder.length === 2 && bridge.store.world.core.connected);
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await bridge.stop();
  await core.close();
  rmDir(dir);
});

/** A WS client with an xterm per stream, like the web UI will have. */
class TermClient {
  readonly msgs: ServerMessage[] = [];
  readonly bytes = new Map<number, string>();
  readonly screens = new Map<number, InstanceType<typeof Terminal>>();
  ws: WebSocket;
  ready: Promise<void>;
  constructor() {
    clients.push(this);
    this.ws = new WebSocket(`ws://${base}/ws`, { headers: { cookie } });
    this.ready = new Promise((r) => this.ws.on('open', () => r()));
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', v: 1 })));
    this.ws.on('message', (d, binary) => {
      const buf = d as Buffer;
      if (binary) {
        const stream = buf.readUInt32LE(0);
        const data = buf.subarray(4).toString();
        this.bytes.set(stream, (this.bytes.get(stream) ?? '') + data);
        this.screens.get(stream)?.write(data);
        return;
      }
      const m = JSON.parse(buf.toString()) as ServerMessage;
      this.msgs.push(m);
      if (m.t === 'term.opened') this.screens.set(m.stream, new Terminal({ cols: m.cols, rows: m.rows, allowProposedApi: true }));
      if (m.t === 'term.reset') {
        this.bytes.set(m.stream, '');
        this.screens.get(m.stream)?.reset();
      }
    });
  }
  of<T extends ServerMessage['t']>(t: T) {
    return this.msgs.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async open(terminalId: string, req = 1): Promise<number> {
    await this.ready;
    this.send({ t: 'term.open', req, terminalId });
    const opened = await until(() => this.of('term.opened').find((m) => m.req === req));
    return opened.stream;
  }
  type(stream: number, text: string) {
    this.ws.send(encodeInputFrame(stream, new TextEncoder().encode(text)));
  }
  text(stream: number): string {
    return this.bytes.get(stream) ?? '';
  }
  async screenLines(stream: number): Promise<string[]> {
    const t = this.screens.get(stream);
    if (!t) return [];
    await new Promise<void>((r) => t.write('', r));
    const out: string[] = [];
    for (let i = 0; i < t.buffer.active.length; i++) out.push(t.buffer.active.getLine(i)?.translateToString(true) ?? '');
    return out.filter((l) => l !== '');
  }
  close() {
    this.ws.close();
    for (const t of this.screens.values()) t.dispose();
  }
}

describe('terminal streams (fake core)', () => {
  it('opens with the current grid and a snapshot, then streams live bytes to every viewer through one core attach', async () => {
    await start();
    const a = new TermClient();
    const sa = await a.open('t3');
    expect(a.of('term.opened')[0]).toMatchObject({ cols: 173, rows: 41, terminalId: 't3', v: 2 });
    await until(() => a.text(sa).includes('me@box:~$'));
    core.output('t3', 'hello\r\n');
    const b = new TermClient();
    const sb = await b.open('t3');
    // b joined late: its snapshot already has the earlier output.
    await until(() => b.text(sb).includes('hello'));
    core.output('t3', 'world\r\n');
    await until(() => a.text(sa).includes('world') && b.text(sb).includes('world'));
    expect(await b.screenLines(sb)).toEqual(['me@box:~$ hello', 'world']);
    expect(await a.screenLines(sa)).toEqual(['me@box:~$ hello', 'world']);
    expect(core.viewersOf('t3').filter((v) => v.observe)).toHaveLength(1);
  });

  it('pages main-buffer history by cursor (read only): older to the first row, newer since a mark, stale epochs refused', async () => {
    await start();
    let out = '';
    for (let i = 1; i <= 500; i++) out += `row ${i}\r\n`;
    core.screens.set('t3', out);
    const a = new TermClient();
    const s = await a.open('t3');
    const opened = a.of('term.opened')[0];
    // 500 rows + the cursor row on a 41-row screen: 460 above it, all held.
    expect(opened?.history).toMatchObject({ end: 460, kept: 460, alt: false });
    const mark = opened?.history;
    if (!mark) throw new Error('no mark');
    const ask = async (req: number, line: number, dir: 'older' | 'newer', limit: number) => {
      a.send({ t: 'term.history', req, stream: s, cursor: { epoch: mark.epoch, line }, dir, limit });
      return until(() => a.msgs.find((m) => (m.t === 'term.history.page' || m.t === 'term.error') && m.req === req));
    };
    const texts: string[] = [];
    let line = mark.end;
    for (let req = 10; line > 0; req++) {
      const p = await ask(req, line, 'older', 200);
      if (p.t !== 'term.history.page') throw new Error(JSON.stringify(p));
      expect(p).toMatchObject({ v: 1, epoch: mark.epoch });
      expect(p.start + p.rows.length).toBe(line);
      texts.unshift(...p.rows.map((r) => r.t));
      line = p.start;
      if (p.older === 0) expect(p.edge).toBe('start');
    }
    expect(texts).toEqual(Array.from({ length: 460 }, (_, i) => `row ${i + 1}`));
    core.output('t3', 'next 1\r\nnext 2\r\n');
    await until(() => a.text(s).includes('next 2'));
    const n = await ask(50, mark.end, 'newer', 1000);
    if (n.t !== 'term.history.page') throw new Error(JSON.stringify(n));
    expect(n.rows.map((r) => r.t)).toEqual(['row 461', 'row 462']);
    expect(await ask(51, 0, 'older', 10)).toMatchObject({ t: 'term.history.page', rows: [] });
    a.send({ t: 'term.history', req: 52, stream: s, cursor: { epoch: mark.epoch + 5, line: 10 }, dir: 'older' });
    expect(await until(() => a.msgs.find((m) => m.t === 'term.error' && m.req === 52))).toMatchObject({ code: 'stale' });
    a.send({ t: 'term.history', req: 53, stream: 999, cursor: { epoch: 1, line: 1 }, dir: 'older' });
    expect(await until(() => a.msgs.find((m) => m.t === 'term.error' && m.req === 53))).toMatchObject({ code: 'not_found' });
    // Read only: nothing was typed and the size never changed.
    expect(core.automatic).toEqual([]);
    expect(core.terminals.get('t3')).toMatchObject({ cols: 173, rows: 41 });
  });

  it("reads a full-screen app's own history only on request and only on the alternate screen (herdr-core's read)", async () => {
    await start();
    core.screens.set('t3', 'shell$ ');
    const a = new TermClient();
    const s = await a.open('t3');
    const ask = async (req: number) => {
      a.send({ t: 'term.appHistory', req, stream: s });
      return until(() => a.msgs.find((m) => (m.t === 'term.appHistory.result' || m.t === 'term.error') && m.req === req));
    };
    // The main screen: its history is paged instead; the core is never asked.
    expect(await ask(1)).toMatchObject({ t: 'term.error', code: 'bad_request' });
    expect(core.readLog).toEqual([]);
    core.output('t3', '\x1b[?1049h\x1b[Hscreen 1\r\nscreen 2');
    await until(() => a.text(s).includes('screen 2'));
    // The read: history lines, then the app's screen (2 non-blank rows) as it was.
    core.reads.t3 = { text: 'old 1\nold 2\nold 3\nscreen 1\nscreen 2', complete: true, how: 'stitched' };
    expect(await ask(2)).toMatchObject({ t: 'term.appHistory.result', lines: ['old 1', 'old 2', 'old 3'], complete: true });
    expect(core.readLog).toEqual([{ terminal: 't3', lines: 1000 }]);
    core.reads.t3 = { text: 'screen 1\nscreen 2', complete: false, how: 'screen', why: 'working' };
    expect(await ask(3)).toMatchObject({ t: 'term.appHistory.result', lines: [], why: 'working' });
    expect(core.automatic).toEqual([]);
  });

  it('types without ever changing the size, also with a second viewer and a desktop attached', async () => {
    await start();
    const desk = core.addDesktop('t3', 120, 40);
    expect(core.sizeLog).toEqual([{ terminal: 't3', cols: 120, rows: 40 }]);
    core.sizeLog.length = 0;
    const a = new TermClient();
    const b = new TermClient();
    const sa = await a.open('t3');
    const sb = await b.open('t3');
    expect(a.of('term.opened')[0]).toMatchObject({ cols: 120, rows: 40 });
    a.type(sa, 'echo hi');
    await until(() => a.text(sa).includes('echo hi') && b.text(sb).includes('echo hi'));
    b.type(sb, '\r');
    await until(() => core.inputs.length === 2);
    expect(core.inputs.map((i) => [i.bytes, i.via])).toEqual([
      ['echo hi', 'attach'],
      ['\r', 'attach'],
    ]);
    // One typing attach, at the terminal's grid, attached `resumed`.
    const typers = core.viewersOf('t3').filter((v) => !v.observe && v !== desk);
    expect(typers.map((v) => v.size)).toEqual([[120, 40]]);
    expect(core.sizeLog).toEqual([]);
    expect(core.terminals.get('t3')).toMatchObject({ cols: 120, rows: 40 });

    // The desktop resizes: clients hear it, and later typing keeps the desktop's size.
    core.resizeViewer(desk, 100, 30);
    await until(() => a.of('term.resized').length === 1 && b.of('term.resized').length === 1);
    expect(a.of('term.resized')[0]).toMatchObject({ cols: 100, rows: 30 });
    a.type(sa, 'x');
    await until(() => core.inputs.length === 3);
    expect(core.sizeLog).toEqual([{ terminal: 't3', cols: 100, rows: 30 }]);
    expect(
      core
        .viewersOf('t3')
        .filter((v) => !v.observe && v !== desk)
        .map((v) => v.size),
    ).toEqual([[100, 30]]);
    // The desktop leaves: the bridge doesn't hold the size either once its typing attach idles out.
    expect(core.terminals.get('t3')).toMatchObject({ cols: 100, rows: 30 });
  });

  it('presses named keys for the current cursor mode, sends chat text, and checks answers', async () => {
    await start();
    core.echo = false;
    const a = new TermClient();
    const s = await a.open('t3');
    a.send({ t: 'term.keys', req: 10, terminalId: 't3', keys: ['up', 'ctrl+c'] });
    await until(() => a.of('term.ack').some((m) => m.req === 10));
    core.output('t3', '\x1b[?1h');
    await sleep(20);
    a.send({ t: 'term.keys', req: 11, terminalId: 't3', keys: ['up'] });
    await until(() => a.of('term.ack').some((m) => m.req === 11));
    a.send({ t: 'term.send', req: 12, terminalId: 't3', text: 'run the tests' });
    await until(() => a.of('term.ack').some((m) => m.req === 12));
    // Chat send types through the attach like herdr-core's send: the paste, a pause, then Enter.
    expect(core.inputs.map((i) => i.bytes)).toEqual(['\x1b[A\x03', '\x1bOA', 'run the tests', '\r']);
    expect(core.inputs.slice(2).map((i) => i.via)).toEqual(['attach', 'attach']);
    // Bracketed when the program asked for it (DEC 2004), and a paste can't end itself early.
    core.output('t3', '\x1b[?2004h');
    await sleep(20);
    a.send({ t: 'term.send', req: 14, terminalId: 't3', text: 'two\nlines\x1b[201~' });
    await until(() => a.of('term.ack').some((m) => m.req === 14));
    expect(core.inputs.slice(4).map((i) => i.bytes)).toEqual(['\x1b[200~two\nlines\x1b[201~', '\r']);
    expect(core.calls.some((c) => c.method === 'terminal.send')).toBe(false);
    // A blocked agent's prompt is answered with term.answer (or a forced send), never by a stray chat message.
    a.send({ t: 'term.send', req: 15, terminalId: 't5', text: 'hello' });
    await until(() => a.of('term.error').some((m) => m.req === 15));
    expect(a.of('term.error').find((m) => m.req === 15)?.code).toBe('unavailable');

    a.send({ t: 'term.keys', req: 13, terminalId: 't3', keys: ['hyper+x'] });
    await until(() => a.of('term.error').some((m) => m.req === 13));
    expect(a.of('term.error').find((m) => m.req === 13)?.code).toBe('bad_key');

    // t5 is blocked on turn 1; t1 is done.
    a.send({ t: 'term.answer', req: 20, terminalId: 't1', keys: ['1'] });
    a.send({ t: 'term.answer', req: 21, terminalId: 't5', keys: ['1'], turn: 0 });
    a.send({ t: 'term.answer', req: 22, terminalId: 't5', keys: ['ctrl+c'] });
    a.send({ t: 'term.answer', req: 23, terminalId: 't5', keys: ['2', 'enter'], turn: 1 });
    await until(() => a.of('term.ack').some((m) => m.req === 23));
    const codes = Object.fromEntries(a.of('term.error').map((m) => [m.req, m.code]));
    expect(codes).toMatchObject({ 20: 'not_blocked', 21: 'stale', 22: 'bad_key' });
    expect(core.inputs.at(-1)).toMatchObject({ terminal: 't5', bytes: '2\r', via: 'attach' });
    expect(s).toBeGreaterThan(0);
  });

  it('refuses oversized input, unknown streams and floods', async () => {
    await start();
    const a = new TermClient();
    const s = await a.open('t3');
    a.type(s, 'x'.repeat(70 * 1024));
    a.type(99, 'x');
    a.send({ t: 'term.send', req: 5, terminalId: 't3', text: 'y'.repeat(70 * 1024) });
    a.send({ t: 'term.open', req: 6, terminalId: '../etc' });
    await until(() => a.of('term.error').length >= 4);
    expect(a.of('term.error').map((e) => e.code)).toEqual(['too_large', 'not_found', 'too_large', 'bad_request']);
    for (let i = 0; i < 300; i++) a.type(s, 'z');
    await until(() => a.of('term.error').some((e) => e.code === 'rate_limited'));
    // Automatic replies (DA, DSR) from the client's emulator never reach the program.
    a.ws.send(encodeInputFrame(s, new TextEncoder().encode('\x1b[?1;2c'), 1));
    await sleep(30);
    expect(core.inputs.some((i) => i.bytes.includes('\x1b[?1;2c'))).toBe(false);
  });

  it('closes the core attach a grace period after the last viewer, and reports exits', async () => {
    await start();
    const a = new TermClient();
    const s = await a.open('t3');
    a.send({ t: 'term.close', stream: s });
    await until(() => a.of('term.closed').length === 1);
    expect(bridge.hub.streams).toBe(1);
    await until(() => bridge.hub.streams === 0 && core.viewersOf('t3').length === 0, 2000);

    const s2 = await a.open('t3', 2);
    core.exit('t3');
    await until(() => a.of('term.closed').some((m) => m.stream === s2 && m.reason === 'exited'));
    a.send({ t: 'term.open', req: 3, terminalId: 'nope' });
    await until(() => a.of('term.error').some((m) => m.req === 3));
    expect(a.of('term.error').find((m) => m.req === 3)?.code).toBe('not_found');
  });

  it('re-attaches after the core comes back and resets viewers with a fresh snapshot', async () => {
    await start();
    const a = new TermClient();
    const s = await a.open('t3');
    await until(() => a.text(s).includes('me@box'));
    await core.restart();
    await until(() => a.of('term.reset').length === 1, 5000);
    expect(a.of('term.reset')[0]).toMatchObject({ stream: s, reason: 'reconnect' });
    await until(() => a.text(s).includes('me@box'));
    core.output('t3', 'back\r\n');
    await until(() => a.text(s).includes('back'));
  });

  it('marks what a client looks at as seen, like the desktop', async () => {
    await start({ seenSync: true });
    const a = new TermClient();
    await a.ready;
    // t1: done on turn 3, seen 2. t3: plain shell. t4: already seen.
    a.send({ t: 'looking', terminalIds: ['t1', 't3', 't4'] });
    await until(() => core.calls.some((c) => c.method === 'terminal.label'), 3000);
    await sleep(400);
    const labels = core.calls.filter((c) => c.method === 'terminal.label');
    expect(labels.map((c) => c.params)).toEqual([{ terminal: 't1', labels: { 'herdr.seen': '3' } }]);
    await until(() => bridge.store.world.terminals.t1?.status === 'idle');
    // A new turn while still on screen raises it again.
    core.terminals.set('t1', { ...(core.terminals.get('t1') ?? agent('t1', 'done', 3, 3)) });
    core.status('t1', 'working');
    core.status('t1', 'done');
    core.turn('t1');
    await until(() => core.calls.filter((c) => c.method === 'terminal.label').length === 2, 3000);
    expect(core.calls.filter((c) => c.method === 'terminal.label')[1]?.params).toEqual({ terminal: 't1', labels: { 'herdr.seen': '4' } });
  });

  it('marks an agent unread (herdr.seen = turn - 1), and an agent left on screen is not marked seen again', async () => {
    await start({ seenSync: true });
    const a = new TermClient();
    await a.ready;
    const labels = () => core.calls.filter((c) => c.method === 'terminal.label').map((c) => c.params);
    // On screen: seen sync raises t1 to its turn (3).
    a.send({ t: 'looking', terminalIds: ['t1'] });
    await until(() => bridge.store.world.terminals.t1?.status === 'idle', 3000);
    // Another client marks it unread.
    const b = new TermClient();
    await b.ready;
    b.send({ t: 'unread', terminalId: 't1' });
    await until(() => bridge.store.world.terminals.t1?.status === 'done', 3000);
    expect(bridge.store.world.terminals.t1?.seenTurn).toBe(2);
    // Still on screen and still looking: no write raises it back (once per turn, like the desktop).
    a.send({ t: 'looking', terminalIds: ['t1'] });
    await sleep(700);
    expect(labels()).toEqual([
      { terminal: 't1', labels: { 'herdr.seen': '3' } },
      { terminal: 't1', labels: { 'herdr.seen': '2' } },
    ]);
    expect(bridge.store.world.terminals.t1?.status).toBe('done');
    // Refused: already unread (t1), a shell (t3), working (t2), a sub-agent (t5), turn 0 (t6), unknown.
    for (const id of ['t1', 't3', 't2', 't5', 't6', 'nope']) b.send({ t: 'unread', terminalId: id });
    await until(() => b.of('error').length === 6, 3000);
    expect(labels()).toHaveLength(2);
    // t4 (idle, turn 7, seen 7) can be.
    b.send({ t: 'unread', terminalId: 't4' });
    await until(() => bridge.store.world.terminals.t4?.status === 'done', 3000);
    expect(labels().at(-1)).toEqual({ terminal: 't4', labels: { 'herdr.seen': '6' } });
  });
});

describe('review fixes (task 6b)', () => {
  it('typing after a desktop resize the bridge has not heard of never takes the size (REVIEW P1-2)', async () => {
    await start();
    core.resizeNotify = false; // the RESIZE is still queued behind output, or the core never confirms them
    const desk = core.addDesktop('t3', 120, 40);
    const a = new TermClient();
    const s = await a.open('t3');
    a.type(s, 'a');
    await until(() => core.inputs.length === 1);
    core.sizeLog.length = 0;
    core.resizeViewer(desk, 100, 30);
    a.type(s, 'b');
    await until(() => core.inputs.length === 2);
    await sleep(30);
    expect(core.sizeLog).toEqual([{ terminal: 't3', cols: 100, rows: 30 }]);
    expect(core.terminals.get('t3')).toMatchObject({ cols: 100, rows: 30 });
    // Typed as automatic input: the core never makes the bridge's attach the size leader.
    expect(core.automatic.map((i) => i.bytes)).toEqual(['a', 'b']);
  });

  it('on a core without automatic input, checks the size before each write and re-attaches (REVIEW P1-2)', async () => {
    await start();
    core.resizeNotify = false;
    core.automaticInput = false;
    const desk = core.addDesktop('t3', 120, 40);
    const a = new TermClient();
    const s = await a.open('t3');
    a.type(s, 'a');
    await until(() => core.inputs.length === 1);
    core.sizeLog.length = 0;
    core.resizeViewer(desk, 100, 30);
    a.type(s, 'b');
    await until(() => core.inputs.length === 2);
    await sleep(30);
    expect(core.sizeLog).toEqual([{ terminal: 't3', cols: 100, rows: 30 }]);
    expect(core.terminals.get('t3')).toMatchObject({ cols: 100, rows: 30 });
  });

  it("another client's keys never land between a chat paste and its Enter (REVIEW P3-5)", async () => {
    await start();
    core.echo = false;
    const a = new TermClient();
    const b = new TermClient();
    await a.open('t3');
    const sb = await b.open('t3');
    a.send({ t: 'term.send', req: 1, terminalId: 't3', text: 'hello' });
    await until(() => core.inputs.length === 1);
    b.type(sb, 'X');
    await until(() => a.of('term.ack').length === 1);
    await until(() => core.inputs.length === 3);
    expect(core.inputs.map((i) => i.bytes)).toEqual(['hello', '\r', 'X']);
  });

  it('a send retried with the same id after a reconnect is typed once (REVIEW P1-4)', async () => {
    await start();
    core.echo = false;
    const a = new TermClient();
    await a.ready;
    a.send({ t: 'term.send', req: 1, id: 'send-1', terminalId: 't3', text: 'deploy it' });
    await until(() => core.inputs.length === 1);
    // The phone drops off mid-send (paste out, Enter pending) and sends again from a new socket.
    a.close();
    const b = new TermClient();
    await b.ready;
    b.send({ t: 'term.send', req: 7, id: 'send-1', terminalId: 't3', text: 'deploy it' });
    await until(() => b.of('term.ack').some((m) => m.req === 7));
    await sleep(300);
    expect(core.inputs.map((i) => i.bytes)).toEqual(['deploy it', '\r']);
    // Done: the same id again is acknowledged without typing anything.
    b.send({ t: 'term.send', req: 8, id: 'send-1', terminalId: 't3', text: 'deploy it' });
    await until(() => b.of('term.ack').some((m) => m.req === 8));
    expect(core.inputs).toHaveLength(2);
    // A new id is a new message.
    b.send({ t: 'term.send', req: 9, id: 'send-2', terminalId: 't3', text: 'again' });
    await until(() => b.of('term.ack').some((m) => m.req === 9));
    expect(core.inputs.map((i) => i.bytes)).toEqual(['deploy it', '\r', 'again', '\r']);
  });

  it('"type without Enter" pastes (bracketed when asked) and presses nothing (REVIEW P2-2)', async () => {
    await start();
    core.echo = false;
    const a = new TermClient();
    await a.open('t3');
    core.output('t3', '\x1b[?2004h');
    await sleep(20);
    a.send({ t: 'term.send', req: 1, terminalId: 't3', text: 'rm -rf build\nls', enter: false });
    await until(() => a.of('term.ack').length === 1);
    expect(core.inputs.map((i) => i.bytes)).toEqual(['\x1b[200~rm -rf build\nls\x1b[201~']);
  });
});
