// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalClient } from '../terminal/streams';
import { FakeWs } from '../test/fakeWs';
import { sampleWorld } from '../test/fixtures';
import { backoffDelay, Connection } from './connection';
import { AppStore } from './store';

function setup(auth: 'ok' | 'unauthorized' | 'unreachable' = 'ok') {
  FakeWs.all = [];
  const store = new AppStore();
  let terminals: TerminalClient | null = null;
  const conn = new Connection({
    store,
    url: () => 'ws://bridge/ws',
    checkAuth: async () => auth,
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    onBinary: (s, d) => terminals?.onBinary(s, d),
  });
  terminals = new TerminalClient(conn, store);
  return { store, conn, terminals };
}

const welcome = (serverId = 'srv') => ({ t: 'welcome', v: 1, serverId, heartbeatMs: 15000 });

describe('Connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => vi.useRealTimers());

  it('says hello, takes the snapshot, and resumes from the last seq after a drop', async () => {
    const { store, conn } = setup();
    conn.start();
    const ws = FakeWs.last();
    ws.open();
    expect(ws.json()[0]).toEqual({ t: 'hello', v: 1 });
    ws.receive(welcome());
    ws.receive({ t: 'snapshot', seq: 7, world: sampleWorld(), alerts: [] });
    expect(store.getState().conn.status).toBe('open');
    ws.receive({ t: 'patch', seq: 8, ops: [] });

    ws.close();
    expect(store.getState().conn.status).toBe('reconnecting');
    // The last world stays while away.
    expect(store.getState().world.spaceOrder).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, () => 1) + 10);
    const ws2 = FakeWs.last();
    expect(ws2).not.toBe(ws);
    ws2.open();
    expect(ws2.json()[0]).toEqual({ t: 'hello', v: 1, resume: { serverId: 'srv', seq: 8 } });
    conn.stop();
  });

  it('backs off between failed attempts and stops on a refused token', async () => {
    const { store, conn } = setup('unauthorized');
    conn.start();
    FakeWs.last().close();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().conn.status).toBe('unauthorized');
    const n = FakeWs.all.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.all.length).toBe(n);
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(50, () => 0)).toBe(15000);
    conn.stop();
  });

  it('reconnects when pings go unanswered, and for a gap in the stream', async () => {
    const { conn } = setup();
    conn.start();
    const ws = FakeWs.last();
    ws.open();
    ws.receive(welcome());
    ws.receive({ t: 'snapshot', seq: 1, world: sampleWorld(), alerts: [] });
    ws.receive({ t: 'hb', seq: 1, ts: 0 });
    // A ping every 10 s; one unanswered for 12 s with nothing else heard means the socket is dead even if the OS hasn't said so.
    await vi.advanceTimersByTimeAsync(23_500);
    expect(ws.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ws.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(400);
    const ws2 = FakeWs.last();
    expect(ws2).not.toBe(ws);
    ws2.open();
    expect(ws2.json()[0]).toMatchObject({ resume: { serverId: 'srv', seq: 1 } });
    ws2.receive(welcome());
    ws2.receive({ t: 'patch', seq: 9, ops: [] });
    // A gap drops the resume point: the next hello asks for a snapshot.
    expect(ws2.readyState).toBe(3);
    const ws3 = FakeWs.last();
    ws3.open();
    expect(ws3.json()[0]).toEqual({ t: 'hello', v: 1 });
    conn.stop();
  });

  it('keeps a slow but working socket: anything heard after a ping counts as life (REVIEW P3-10)', async () => {
    const { store, conn } = setup();
    conn.start();
    const ws = FakeWs.last();
    ws.open();
    ws.receive(welcome());
    ws.receive({ t: 'snapshot', seq: 1, world: sampleWorld(), alerts: [] });
    ws.receive({ t: 'hb', seq: 1, ts: 0 });
    // The next ping's answer queues behind a big terminal snapshot that trickles in for 20 s.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      ws.receiveBinary(1, 'x');
    }
    expect(ws.readyState).toBe(1);
    expect(store.getState().conn.status).toBe('open');
    conn.stop();
  });

  it('notices the device going offline at once, keeps the last world, and says since when (REVIEW P2-15)', async () => {
    const { store, conn } = setup();
    conn.start();
    const ws = FakeWs.last();
    ws.open();
    ws.receive(welcome());
    ws.receive({ t: 'snapshot', seq: 1, world: sampleWorld(), alerts: [] });
    expect(store.getState().conn.lostAt).toBeNull();
    window.dispatchEvent(new Event('offline'));
    expect(ws.readyState).toBe(3);
    expect(store.getState().conn).toMatchObject({ status: 'reconnecting', offline: true });
    expect(store.getState().conn.lostAt).toBeTypeOf('number');
    expect(store.getState().world.spaceOrder).toHaveLength(4);
    // Back online: straight away, not after the backoff.
    window.dispatchEvent(new Event('online'));
    const ws2 = FakeWs.last();
    expect(ws2).not.toBe(ws);
    ws2.open();
    ws2.receive(welcome());
    expect(store.getState().conn).toMatchObject({ status: 'open', offline: false, lostAt: null });
    conn.stop();
  });

  it('re-opens terminal streams after a reconnect and routes their bytes', async () => {
    const { conn, terminals } = setup();
    conn.start();
    const ws = FakeWs.last();
    ws.open();
    ws.receive(welcome());
    ws.receive({ t: 'snapshot', seq: 1, world: sampleWorld(), alerts: [] });
    const events: string[] = [];
    const h = terminals.open('t1', {
      onOpen: (c, r) => events.push(`open ${c}x${r}`),
      onData: (d) => events.push(`data ${new TextDecoder().decode(d)}`),
      onReset: () => events.push('reset'),
      onResize: (c, r) => events.push(`resize ${c}x${r}`),
      onClosed: (why) => events.push(`closed ${why}`),
    });
    const open = ws.json().find((m) => m.t === 'term.open');
    expect(open).toMatchObject({ terminalId: 't1', history: 1000 });
    ws.receive({ t: 'term.opened', req: open?.req, stream: 3, terminalId: 't1', cols: 120, rows: 40, v: 1 });
    ws.receiveBinary(3, 'hello');
    ws.receive({ t: 'term.resized', stream: 3, cols: 100, rows: 30 });
    expect(h.type('ls\r')).toBe(true);
    const frame = ws.sent.at(-1) as Uint8Array;
    expect([...frame.slice(0, 5)]).toEqual([3, 0, 0, 0, 0]);

    const sent = terminals.send('t1', 'hi');
    const req = ws.json().find((m) => m.t === 'term.send')?.req;
    ws.receive({ t: 'term.ack', req });
    await expect(sent).resolves.toBeUndefined();
    const keys = terminals.keys('t1', ['esc']);
    const kreq = ws.json().find((m) => m.t === 'term.keys')?.req;
    ws.receive({ t: 'term.error', req: kreq, code: 'bad_key', message: 'nope' });
    await expect(keys).rejects.toMatchObject({ code: 'bad_key' });

    ws.close();
    await vi.advanceTimersByTimeAsync(400);
    const ws2 = FakeWs.last();
    ws2.open();
    ws2.receive(welcome());
    const reopen = ws2.json().find((m) => m.t === 'term.open');
    expect(reopen).toMatchObject({ terminalId: 't1' });
    ws2.receive({ t: 'term.opened', req: reopen?.req, stream: 1, terminalId: 't1', cols: 100, rows: 30, v: 1 });
    expect(events).toEqual(['open 120x40', 'data hello', 'resize 100x30', 'open 100x30']);
    h.close();
    expect(ws2.json().at(-1)).toEqual({ t: 'term.close', stream: 1 });
    conn.stop();
  });

  it('sends an unconfirmed chat message again with the same id after a reconnect, never as a new one (REVIEW P1-4)', async () => {
    const { conn, terminals } = setup();
    conn.start();
    const ws = FakeWs.last();
    ws.open();
    ws.receive(welcome('srv'));
    const sent = terminals.send('t1', 'deploy it');
    const first = ws.json().find((m) => m.t === 'term.send');
    expect(first).toMatchObject({ text: 'deploy it' });
    expect(typeof first?.id).toBe('string');
    ws.close();
    await vi.advanceTimersByTimeAsync(400);
    const ws2 = FakeWs.last();
    ws2.open();
    ws2.receive(welcome('srv'));
    const again = ws2.json().find((m) => m.t === 'term.send');
    expect(again).toMatchObject({ text: 'deploy it', id: first?.id });
    expect(again?.req).not.toBe(first?.req);
    ws2.receive({ t: 'term.ack', req: again?.req });
    await expect(sent).resolves.toBeUndefined();

    // The bridge restarted (new serverId): it can't know whether it typed it, so the text is handed back.
    const lost = terminals.send('t1', 'second');
    ws2.close();
    await vi.advanceTimersByTimeAsync(400);
    const ws3 = FakeWs.last();
    ws3.open();
    ws3.receive(welcome('srv-2'));
    await expect(lost).rejects.toMatchObject({ code: 'offline' });
    expect(ws3.json().some((m) => m.t === 'term.send')).toBe(false);
    conn.stop();
  });

  it('"type without Enter" is a paste with enter: false (REVIEW P2-2)', () => {
    const { conn, terminals } = setup();
    conn.start();
    const ws = FakeWs.last();
    ws.open();
    ws.receive(welcome());
    void terminals.send('t1', 'two\nlines', false, false);
    expect(ws.json().find((m) => m.t === 'term.send')).toMatchObject({ text: 'two\nlines', enter: false });
    conn.stop();
  });
});
