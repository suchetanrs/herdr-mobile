import type { World } from '@herdr-mobile/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../src/core/client.js';
import { SeenSync } from '../src/seen/sync.js';
import { WorldStore } from '../src/world/store.js';
import { startBridge, type TestBridge } from './helpers/bridge.js';
import { sleep, until } from './helpers/tmp.js';
import { Client } from './helpers/wsClient.js';

let tb: TestBridge | null = null;
afterEach(async () => {
  await tb?.stop();
  tb = null;
});

describe('looking is a lease (REVIEW P0-1)', () => {
  it('expires a client that stops renewing, without its socket closing', () => {
    let now = 1000;
    const store = new WorldStore({
      client: new CoreClient({ socketPath: '/nonexistent' }),
      home: '/h',
      lookingTtlMs: 10_000,
      now: () => now,
    });
    let changes = 0;
    store.on('looking', () => changes++);
    store.setLooking('phone', ['t2']);
    expect([...store.lookingIds()]).toEqual(['t2']);
    now += 9_000;
    store.setLooking('phone', ['t2']); // renewal
    now += 9_000;
    expect([...store.lookingIds()]).toEqual(['t2']);
    now += 1_001;
    expect([...store.lookingIds()]).toEqual([]);
    // A renewal of the same set isn't news.
    expect(changes).toBe(1);
    store.stop();
  });

  it('a phone that went quiet (socket still open) no longer swallows the finished alert', async () => {
    tb = await startBridge({ lookingTtlMs: 150 });
    const c = new Client(tb.wsUrl());
    await until(() => c.world);
    c.ws.send(JSON.stringify({ t: 'looking', terminalIds: ['t2'] }));
    await until(() => tb?.bridge.store.lookingIds().has('t2'));
    // The phone locks: no `looking: []`, no close. The lease runs out.
    await sleep(300);
    expect(tb.bridge.store.lookingIds().has('t2')).toBe(false);
    tb.core.status('t2', 'done');
    tb.core.turn('t2');
    await until(() => c.of('alert').length === 1, 2000);
    expect(c.of('alert')[0]?.alert).toMatchObject({ kind: 'done', terminalId: 't2' });
    c.close();
  });

  it('seen sync never marks an agent seen for a phone whose lease ran out, and does while it renews', async () => {
    tb = await startBridge({ lookingTtlMs: 150, seenSync: true });
    const c = new Client(tb.wsUrl());
    await until(() => c.world);
    const labelWrites = () => tb?.core.calls.filter((x) => x.method === 'terminal.label') ?? [];
    c.ws.send(JSON.stringify({ t: 'looking', terminalIds: ['t2'] }));
    await sleep(300);
    tb.core.status('t2', 'done');
    tb.core.turn('t2');
    await until(() => c.world?.terminals.t2?.status === 'done');
    await sleep(500);
    expect(labelWrites()).toEqual([]);

    // Renewing every 50 ms: it is looked at, so the finished turn is written as seen.
    const renew = setInterval(() => c.ws.send(JSON.stringify({ t: 'looking', terminalIds: ['t2'] })), 50);
    try {
      await until(() => labelWrites().length === 1, 2000);
      expect(labelWrites()[0]?.params).toEqual({ terminal: 't2', labels: { 'herdr.seen': String((c.world as World).terminals.t2?.turn) } });
    } finally {
      clearInterval(renew);
      c.close();
    }
  });
});

describe('SeenSync', () => {
  function rig(over: Partial<{ looking: Set<string>; live: boolean; seenTurn: number | null; turn: number; word: string | null }> = {}) {
    const state = { looking: new Set(['t1']), live: true, seenTurn: 1 as number | null, turn: 2, word: 'idle' as string | null, ...over };
    const writes: Array<[string, number]> = [];
    const sync = new SeenSync({
      world: () => ({ terminals: { t1: { word: state.word, turn: state.turn, seenTurn: state.seenTurn } } }) as unknown as World,
      looking: () => state.looking,
      isLive: () => state.live,
      write: async (id, turn) => {
        writes.push([id, turn]);
      },
      debounceMs: 5,
    });
    return { state, writes, sync };
  }

  it('writes the turn once per turn while on screen, only to raise it', async () => {
    const r = rig();
    r.sync.update();
    r.sync.update();
    await sleep(30);
    expect(r.writes).toEqual([['t1', 2]]);
    r.state.seenTurn = 2;
    r.state.turn = 3;
    r.sync.update();
    await sleep(30);
    expect(r.writes).toEqual([
      ['t1', 2],
      ['t1', 3],
    ]);
    r.sync.stop();
  });

  it('skips shells, finished terminals, already-seen turns, and terminals nobody looks at', async () => {
    for (const over of [{ word: null }, { live: false }, { seenTurn: 2 }, { looking: new Set<string>() }]) {
      const r = rig(over);
      r.sync.update();
      await sleep(30);
      expect(r.writes).toEqual([]);
      r.sync.stop();
    }
  });

  it('drops a pending check when the looking lease lapses before it runs', async () => {
    const r = rig();
    r.sync.update();
    r.state.looking = new Set();
    await sleep(30);
    expect(r.writes).toEqual([]);
    r.sync.stop();
  });
});

describe('production config never writes what it must not (REVIEW P2-22)', () => {
  it('with seen sync on and nobody looking, agents finishing write no labels, docs or input', async () => {
    tb = await startBridge({ seenSync: true });
    const c = new Client(tb.wsUrl());
    await until(() => c.world);
    tb.core.status('t1', 'working');
    tb.core.status('t1', 'done');
    tb.core.turn('t1');
    tb.core.status('t4', 'blocked');
    await sleep(900);
    const writes = tb.core.calls.filter((x) =>
      ['doc.set', 'terminal.label', 'terminal.send', 'terminal.keys', 'terminal.attach'].includes(x.method),
    );
    expect(writes).toEqual([]);
    c.close();
  });
});
