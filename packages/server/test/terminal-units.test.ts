import {
  BinaryInputKind,
  decodeInputFrame,
  decodeOutputFrame,
  emptyWorld,
  encodeInputFrame,
  parseClientMessage,
  type TerminalServerMessage,
  type TerminalView,
} from '@herdr-mobile/protocol';
import headlessPkg from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { checkCall, PolicyError } from '../src/core/policy.js';
import { SeenSync } from '../src/seen/sync.js';
import { encodeKey, encodeKeys, encodePaste, isAnswerKeys, KeyError } from '../src/terminal/keys.js';
import { ScreenMirror } from '../src/terminal/mirror.js';
import { InputLimiter, TokenBucket } from '../src/terminal/ratelimit.js';
import { type StreamSink, Subscriber } from '../src/terminal/subscriber.js';
import { seenTurnOf } from '../src/world/status.js';
import { terminal } from './helpers/fixtures.js';
import { sleep, until } from './helpers/tmp.js';

const terminalRec = (labels: Record<string, string>) => terminal('t1', { labels });

const { Terminal } = headlessPkg;

describe('named keys', () => {
  const normal = { applicationCursorKeys: false };
  const app = { applicationCursorKeys: true };

  it('encodes keys the way xterm.js types them', () => {
    expect(encodeKeys(['esc', 'enter', 'tab', 'shift+tab', 'backspace'], normal)).toBe('\x1b\r\t\x1b[Z\x7f');
    expect(encodeKey('ctrl+c', normal)).toBe('\x03');
    expect(encodeKey('CTRL+A', normal)).toBe('\x01');
    expect(encodeKeys(['y', 'N', '1', '/', 'space'], normal)).toBe('yN1/ ');
    expect(encodeKey('pageup', normal)).toBe('\x1b[5~');
  });

  it('follows the cursor-key mode for arrows, home and end', () => {
    expect(encodeKeys(['up', 'down', 'right', 'left', 'home', 'end'], normal)).toBe('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F');
    expect(encodeKeys(['up', 'left'], app)).toBe('\x1bOA\x1bOD');
  });

  it('refuses unknown keys', () => {
    expect(() => encodeKey('hyper+q', normal)).toThrow(KeyError);
    expect(() => encodeKey('ctrl+1', normal)).toThrow(KeyError);
    expect(() => encodeKey('\x1b', normal)).toThrow(KeyError);
    expect(() => encodeKey('ab', normal)).toThrow(KeyError);
  });

  it('allows only short answer keys for quick approve', () => {
    expect(isAnswerKeys(['1'])).toBe(true);
    expect(isAnswerKeys(['y', 'enter'])).toBe(true);
    expect(isAnswerKeys(['shift+tab'])).toBe(true);
    expect(isAnswerKeys([])).toBe(false);
    expect(isAnswerKeys(['ctrl+c'])).toBe(false);
    expect(isAnswerKeys(['x'])).toBe(false);
    // A typed answer to an AskUserQuestion clears its "Type something" field first.
    expect(isAnswerKeys(['down', 'down', 'ctrl+u'])).toBe(true);
    expect(encodeKey('ctrl+u', { applicationCursorKeys: false })).toBe('\x15');
  });
});

describe('rate limits', () => {
  it('refills a token bucket over time', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    for (let i = 0; i < 5; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    now = 300;
    expect(b.take(3)).toBe(true);
    expect(b.take()).toBe(false);
  });

  it('limits messages and bytes per client', () => {
    let now = 0;
    const l = new InputLimiter({ messagesPerSecond: 1, messageBurst: 3, bytesPerSecond: 100, byteBurst: 100 }, () => now);
    expect(l.allow(60)).toBe(true);
    expect(l.allow(60)).toBe(false); // bytes
    expect(l.allow(10)).toBe(true);
    expect(l.allow(1)).toBe(false); // messages
    now = 1000;
    expect(l.allow(10)).toBe(true);
  });
});

describe('policy', () => {
  it('lets the bridge write only herdr.seen=<turn>', () => {
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: { 'herdr.seen': '12' } })).not.toThrow();
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: { foo: 'bar' } })).toThrow(PolicyError);
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: { 'herdr.seen': '' } })).toThrow(PolicyError);
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: { 'herdr.seen': 'x' } })).toThrow(PolicyError);
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: { 'herdr.seen': '1', other: '2' } })).toThrow(PolicyError);
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: {} })).toThrow(PolicyError);
  });
});

describe('review fixes (task 6b): input and policy', () => {
  it('a paste cannot end itself early, however the terminator is split (REVIEW P2-1)', () => {
    for (const text of ['\x1b[20\x1b[201~1~\rrm -rf ~\r', '\x1b[201\x1b[201~~x', 'a\x9b201~b', 'ok\x1b']) {
      const out = encodePaste(text, true);
      expect(out.startsWith('\x1b[200~')).toBe(true);
      expect(out.endsWith('\x1b[201~')).toBe(true);
      const body = out.slice(6, -6);
      // No escape or C1 control left in the body: nothing in it can close the paste or act as a key.
      expect([...body].some((c) => c === '\x1b' || (c >= '\x80' && c <= '\x9f'))).toBe(false);
    }
    expect(encodePaste('two\nlines\ttab', true)).toBe('\x1b[200~two\nlines\ttab\x1b[201~');
    expect(encodePaste('plain', false)).toBe('plain');
  });

  it('policy is an allowlist: only what the bridge uses reaches the core (REVIEW P2-13)', () => {
    for (const m of [
      'machine.exec',
      'file.write',
      'terminal.run',
      'terminal.kill',
      'terminal.rm',
      'doc.set',
      'server.stop',
      'terminal.keys',
    ]) {
      expect(() => checkCall(m, {})).toThrow(PolicyError);
    }
    for (const m of ['hello', 'events.subscribe', 'doc.get', 'machine.list', 'terminal.get', 'server.status']) {
      expect(() => checkCall(m, {})).not.toThrow();
    }
    expect(() => checkCall('terminal.send', { terminal: 't1', text: 'x' })).not.toThrow();
    // Attaches: observe, or typing that is `resumed` (never takes the size just by attaching).
    expect(() => checkCall('terminal.attach', { terminal: 't1', cols: 80, rows: 24, observe: true })).not.toThrow();
    expect(() => checkCall('terminal.attach', { terminal: 't1', cols: 80, rows: 24, resumed: true })).not.toThrow();
    expect(() => checkCall('terminal.attach', { terminal: 't1', cols: 80, rows: 24 })).toThrow(PolicyError);
    expect(() => checkCall('terminal.attach', { terminal: 't1', cols: 0, rows: 24, resumed: true })).toThrow(PolicyError);
  });

  it('a stream that fell behind before its first snapshot still gets term.opened (REVIEW P2-3)', () => {
    const sent: TerminalServerMessage[] = [];
    const sink: StreamSink = { sendJson: (m) => sent.push(m), sendBinary: () => {}, bufferedAmount: () => 0, isOpen: () => true };
    const sub = new Subscriber(3, 't1', sink, 100, { highWater: 1e6, lowWater: 1e3, pollMs: 5, maxHold: 10 });
    sub.expectOpen(42);
    sub.beginSync();
    sub.pushBytes(new Uint8Array(64)); // more than maxHold during the first snapshot
    sub.deliverSnapshot(sub.headFor(80, 24, 'resync'), { data: 'x', cols: 80, rows: 24 });
    expect(sent).toEqual([]);
    sub.beginSync();
    sub.deliverSnapshot(sub.headFor(100, 30, 'behind'), { data: 'y', cols: 100, rows: 30 });
    expect(sent[0]).toMatchObject({ t: 'term.opened', req: 42, stream: 3, cols: 100, rows: 30 });
    sub.beginSync();
    sub.deliverSnapshot(sub.headFor(100, 30, 'behind'), { data: 'z', cols: 100, rows: 30 });
    expect(sent[1]).toMatchObject({ t: 'term.reset', reason: 'behind' });
  });

  it('herdr.seen parses like Rust u64 (REVIEW P3-12)', () => {
    expect(seenTurnOf(terminalRec({ 'herdr.seen': '0x10' }))).toBeNull();
    expect(seenTurnOf(terminalRec({ 'herdr.seen': '1e3' }))).toBeNull();
    expect(seenTurnOf(terminalRec({ 'herdr.seen': ' 4' }))).toBeNull();
    expect(seenTurnOf(terminalRec({ 'herdr.seen': '12' }))).toBe(12);
  });
});

describe('terminal protocol', () => {
  it('parses terminal messages and rejects malformed ones', () => {
    expect(parseClientMessage('{"t":"term.open","req":1,"terminalId":"t1"}')).toMatchObject({ t: 'term.open' });
    expect(parseClientMessage('{"t":"term.open","terminalId":"t1"}')).toBeNull();
    expect(parseClientMessage('{"t":"term.keys","terminalId":"t1","keys":["esc"]}')).toMatchObject({ t: 'term.keys' });
    expect(parseClientMessage('{"t":"term.keys","terminalId":"t1","keys":[1]}')).toBeNull();
    expect(parseClientMessage('{"t":"term.send","terminalId":"t1","text":"hi","force":"yes"}')).toBeNull();
    expect(parseClientMessage('{"t":"term.answer","terminalId":"t1","keys":["1"],"turn":-1}')).toBeNull();
    expect(parseClientMessage('{"t":"term.resync","stream":3}')).toMatchObject({ stream: 3 });
  });

  it('round-trips binary frames', () => {
    const f = encodeInputFrame(7, new TextEncoder().encode('ls\r'));
    expect(decodeInputFrame(f)).toMatchObject({ stream: 7, kind: BinaryInputKind.KEYS });
    expect(new TextDecoder().decode(decodeInputFrame(f)?.data)).toBe('ls\r');
    expect(decodeInputFrame(new Uint8Array(3))).toBeNull();
    const out = Buffer.concat([Buffer.from([9, 0, 0, 0]), Buffer.from('hey')]);
    expect(decodeOutputFrame(out)?.stream).toBe(9);
  });
});

describe('screen mirror', () => {
  /** What a fresh xterm shows after replaying `data`. */
  async function replay(data: string, cols: number, rows: number): Promise<string[]> {
    const t = new Terminal({ cols, rows, allowProposedApi: true });
    await new Promise<void>((r) => t.write(data, r));
    const lines: string[] = [];
    for (let i = 0; i < t.buffer.active.length; i++) lines.push(t.buffer.active.getLine(i)?.translateToString(true) ?? '');
    t.dispose();
    return lines.filter((l) => l !== '');
  }

  it('snapshots exactly the bytes written before the call', async () => {
    const m = new ScreenMirror({ cols: 40, rows: 5, scrollback: 100 });
    m.write(Buffer.from('one\r\ntwo\r\n'));
    const snap = m.snapshot(100);
    m.write(Buffer.from('three\r\n'));
    const s = await snap;
    expect(await replay(s.data, s.cols, s.rows)).toEqual(['one', 'two']);
    const later = await m.snapshot(100);
    expect(await replay(later.data, later.cols, later.rows)).toEqual(['one', 'two', 'three']);
    m.dispose();
  });

  it('keeps scrollback, colors and modes, and resizes in order', async () => {
    const m = new ScreenMirror({ cols: 20, rows: 3, scrollback: 100 });
    m.write(Buffer.from('a\r\nb\r\nc\r\nd\r\n\x1b[31mred\x1b[0m\x1b[?1h'));
    m.resize(30, 4);
    const s = await m.snapshot(10);
    expect(s).toMatchObject({ cols: 30, rows: 4 });
    expect(s.data).toContain('\x1b[31m');
    expect(await replay(s.data, s.cols, s.rows)).toEqual(['a', 'b', 'c', 'd', 'red']);
    expect(m.modes.applicationCursorKeys).toBe(true);
    m.dispose();
  });
});

class FakeSink implements StreamSink {
  json: TerminalServerMessage[] = [];
  frames: Array<{ stream: number; data: string }> = [];
  order: string[] = [];
  buffered = 0;
  open = true;
  sendJson(m: TerminalServerMessage) {
    this.json.push(m);
    this.order.push(m.t);
  }
  sendBinary(stream: number, chunks: readonly Uint8Array[]) {
    const data = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString();
    this.frames.push({ stream, data });
    this.order.push(`bin:${data}`);
  }
  bufferedAmount() {
    return this.buffered;
  }
  isOpen() {
    return this.open;
  }
}

describe('subscriber', () => {
  const bp = { highWater: 100, lowWater: 10, pollMs: 5, maxHold: 1000 };

  it('sends the snapshot, then what was held, then coalesced live bytes', async () => {
    const sink = new FakeSink();
    const s = new Subscriber(1, 't1', sink, 10, bp);
    s.beginSync();
    s.pushBytes(Buffer.from('held'));
    s.pushMessage({ t: 'term.resized', stream: 1, cols: 10, rows: 5 });
    s.deliverSnapshot({ t: 'term.reset', stream: 1, cols: 9, rows: 4, reason: 'resync' }, { data: 'SNAP', cols: 9, rows: 4 });
    s.pushBytes(Buffer.from('a'));
    s.pushBytes(Buffer.from('b'));
    await sleep(5);
    expect(sink.order).toEqual(['term.reset', 'bin:SNAP', 'bin:held', 'term.resized', 'bin:ab']);
  });

  it('drops the backlog of a slow client and asks for a resync once it drained', async () => {
    const sink = new FakeSink();
    const s = new Subscriber(1, 't1', sink, 10, bp);
    let drained = 0;
    s.onDrained = () => drained++;
    s.deliverSnapshot({ t: 'term.reset', stream: 1, cols: 9, rows: 4, reason: 'resync' }, { data: '', cols: 9, rows: 4 });
    s.beginSync();
    s.deliverSnapshot({ t: 'term.reset', stream: 1, cols: 9, rows: 4, reason: 'resync' }, { data: '', cols: 9, rows: 4 });
    sink.buffered = 500;
    s.pushBytes(Buffer.from('lost'));
    await sleep(5);
    expect(s.state).toBe('behind');
    expect(s.drops).toBe(1);
    s.pushBytes(Buffer.from('also lost'));
    await sleep(20);
    expect(drained).toBe(0);
    sink.buffered = 0;
    await until(() => drained === 1);
    expect(sink.frames.map((f) => f.data)).not.toContain('lost');
  });

  it('falls behind when too much piles up during a snapshot', () => {
    const sink = new FakeSink();
    const s = new Subscriber(1, 't1', sink, 10, bp);
    s.beginSync();
    s.pushBytes(Buffer.alloc(2000));
    expect(s.state).toBe('behind');
    s.close();
  });
});

describe('seen sync', () => {
  function view(id: string, over: Partial<TerminalView>): TerminalView {
    return {
      id,
      machine: null,
      spaceId: 's',
      tabId: 'tb',
      paneId: 'p',
      parent: null,
      children: [],
      name: null,
      label: id,
      app: 'claude-code',
      program: 'claude',
      title: '',
      status: 'done',
      word: 'done',
      turn: 3,
      seenTurn: 2,
      pinned: false,
      cwd: null,
      cols: 80,
      rows: 24,
      statusMs: null,
      transcript: null,
      ...over,
    };
  }

  function setup(terminals: TerminalView[]) {
    const world = emptyWorld();
    for (const t of terminals) world.terminals[t.id] = t;
    const looking = new Set<string>();
    const writes: Array<[string, number]> = [];
    let fail = false;
    const sync = new SeenSync({
      world: () => world,
      looking: () => looking,
      isLive: (id) => id !== 'gone',
      write: async (id, turn) => {
        if (fail) throw new Error('core said no');
        writes.push([id, turn]);
        const t = world.terminals[id];
        if (t) t.seenTurn = turn;
      },
      debounceMs: 5,
    });
    return { world, looking, writes, sync, setFail: (v: boolean) => (fail = v) };
  }

  it('writes the turn once for an agent on screen, only to raise it', async () => {
    const { looking, writes, sync, world } = setup([
      view('t1', {}),
      view('t2', { turn: 4, seenTurn: 4, status: 'idle', word: 'idle' }),
      view('t3', { word: null, status: null, seenTurn: null }),
      view('t4', { turn: 0, seenTurn: null }),
      view('gone', {}),
    ]);
    for (const id of ['t1', 't2', 't3', 't4', 'gone']) looking.add(id);
    sync.update();
    await sleep(20);
    expect(writes.sort()).toEqual([
      ['t1', 3],
      ['t4', 0],
    ]);
    // Updates while it stays on screen on the same turn write nothing.
    sync.update();
    await sleep(20);
    expect(writes).toHaveLength(2);
    // A new turn on screen raises it.
    const t1 = world.terminals.t1 as TerminalView;
    t1.turn = 4;
    sync.update();
    await sleep(20);
    expect(writes).toContainEqual(['t1', 4]);
    sync.stop();
  });

  it("doesn't overrule a mark-unread while it stays on screen, but does after looking again", async () => {
    const { looking, writes, sync, world } = setup([view('t1', {})]);
    looking.add('t1');
    sync.update();
    await until(() => writes.length === 1);
    (world.terminals.t1 as TerminalView).seenTurn = 2; // another client marked it unread
    sync.update();
    await sleep(20);
    expect(writes).toHaveLength(1);
    looking.delete('t1');
    sync.update();
    looking.add('t1');
    sync.update();
    await until(() => writes.length === 2);
    sync.stop();
  });

  it('nothing for agents nobody looks at, and retries after a failed write', async () => {
    const { looking, writes, sync, setFail } = setup([view('t1', {})]);
    sync.update();
    await sleep(20);
    expect(writes).toHaveLength(0);
    setFail(true);
    looking.add('t1');
    sync.update();
    await sleep(20);
    expect(writes).toHaveLength(0);
    setFail(false);
    sync.update();
    await until(() => writes.length === 1);
    sync.stop();
  });
});

describe('upstream flow control (REVIEW P2-4, P3-4)', () => {
  function stubClient() {
    const credits: number[] = [];
    let handler: { onFrame(kind: number, payload: Buffer): void } | null = null;
    const client = {
      on() {},
      off() {},
      call: async (method: string) =>
        method === 'terminal.get' ? { cols: 80, rows: 24 } : { channel: 5, resize_notifications: false, automatic_input: true },
      openChannel: (_ch: number, h: typeof handler) => {
        handler = h;
      },
      closeChannel() {},
      sendFrame: (_ch: number, kind: number, payload?: Buffer) => {
        if (kind === 1 && payload) credits.push(payload.readUInt32LE(0));
        return true;
      },
    };
    return { client, credits, frame: (kind: number, p: Buffer) => handler?.onFrame(kind, p) };
  }

  it('returns credit only once the mirror has parsed the bytes', async () => {
    const { TerminalUpstream } = await import('../src/terminal/upstream.js');
    const s = stubClient();
    const up = new TerminalUpstream({
      client: s.client as never,
      terminalId: 't1',
      coreHistory: 0,
      scrollback: 100,
      graceMs: 1000,
      typingIdleMs: 1000,
      sizeHint: { cols: 80, rows: 24 },
    });
    await up.open();
    s.frame(0, Buffer.from('x'.repeat(100_000)));
    expect(s.credits).toEqual([]);
    await up.keyModes();
    expect(s.credits).toEqual([100_000]);
    up.end('test');
  });

  it('follows the size from core events when the core sends no RESIZE notifications', async () => {
    const { TerminalUpstream } = await import('../src/terminal/upstream.js');
    const s = stubClient();
    const up = new TerminalUpstream({
      client: s.client as never,
      terminalId: 't1',
      coreHistory: 0,
      scrollback: 100,
      graceMs: 1000,
      typingIdleMs: 1000,
      sizeHint: { cols: 80, rows: 24 },
    });
    const sent: TerminalServerMessage[] = [];
    const sink: StreamSink = { sendJson: (m) => sent.push(m), sendBinary: () => {}, bufferedAmount: () => 0, isOpen: () => true };
    await up.add(new Subscriber(1, 't1', sink, 10), 1);
    up.coreSize({ cols: 100, rows: 30 });
    await until(() => sent.some((m) => m.t === 'term.resized'));
    expect(sent.find((m) => m.t === 'term.resized')).toMatchObject({ cols: 100, rows: 30 });
    expect(up.size).toEqual({ cols: 100, rows: 30 });
    up.end('test');
  });
});
