import type { AttentionAlert } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionEngine } from '../src/attention/engine.js';
import { alertFor, alertKind, alertText } from '../src/attention/rules.js';
import { NotifierHub } from '../src/notify/notifier.js';
import { WebPushSink } from '../src/notify/webpush.js';
import type { WordTransition } from '../src/world/store.js';

const tr = (over: Partial<WordTransition>): WordTransition => ({
  terminalId: 't1',
  prev: 'working',
  next: 'done',
  turn: 1,
  subAgent: false,
  hasPane: true,
  looking: false,
  name: 'Claude Code',
  place: 'Alpha / 1',
  ...over,
});

describe('alert rule (model.rs alert / alert_for)', () => {
  it('alerts on entering blocked/error, every time', () => {
    expect(alertKind('working', 'blocked', false)).toBe('blocked');
    expect(alertKind('idle', 'error', true)).toBe('blocked');
    expect(alertKind(null, 'blocked', false)).toBe('blocked');
    expect(alertKind('blocked', 'error', false)).toBeNull();
    expect(alertKind('error', 'blocked', false)).toBeNull();
  });

  it('alerts on finishing only when nobody is looking', () => {
    expect(alertKind('working', 'done', false)).toBe('done');
    expect(alertKind('working', 'idle', false)).toBe('done');
    expect(alertKind('blocked', 'idle', false)).toBe('done');
    expect(alertKind('working', 'done', true)).toBeNull();
    expect(alertKind('working', null, false)).toBeNull();
    expect(alertKind('idle', 'done', false)).toBeNull();
    expect(alertKind('working', 'blocked', false)).toBe('blocked');
  });

  it('never rings for sub-agents or paneless terminals', () => {
    expect(alertFor(tr({ subAgent: true, next: 'blocked' }))).toBeNull();
    expect(alertFor(tr({ hasPane: false, next: 'blocked' }))).toBeNull();
    expect(alertFor(tr({}))).toBe('done');
  });

  it('words alerts like the desktop toast', () => {
    expect(alertText('blocked', 'Claude Code')).toEqual({ title: 'Claude Code needs you', level: 'error' });
    expect(alertText('done', null)).toEqual({ title: 'An agent finished', level: 'info' });
  });
});

describe('AttentionEngine', () => {
  let sent: AttentionAlert[];
  let settled: Set<string>;
  let engine: AttentionEngine;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    settled = new Set();
    const hub = new NotifierHub().add({ name: 'test', notify: async (a) => void sent.push(a) });
    engine = new AttentionEngine({ notifier: hub, doneGraceMs: 1000, isSettled: (id) => settled.has(id), now: () => Date.now() });
  });
  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  it('sends blocked at once with the place as body', async () => {
    engine.onTransitions([tr({ prev: 'working', next: 'blocked' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'blocked', title: 'Claude Code needs you', body: 'Alpha / 1', level: 'error', terminalId: 't1' });
  });

  it('holds finished for the grace period and drops it when seen meanwhile', async () => {
    engine.onTransitions([tr({ terminalId: 't1' }), tr({ terminalId: 't2' })]);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(0);
    settled.add('t2');
    await vi.advanceTimersByTimeAsync(600);
    expect(sent.map((a) => [a.terminalId, a.title])).toEqual([['t1', 'Claude Code finished']]);
  });

  it('cancels a pending finished when the agent gets busy again', async () => {
    engine.onTransitions([tr({})]);
    engine.onTransitions([tr({ prev: 'done', next: 'working' })]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(0);
  });

  it('holds finished while background work runs; sends it when that ends, unless busy or seen meanwhile', async () => {
    engine.onTransitions([
      tr({ terminalId: 't1', busy: true }),
      tr({ terminalId: 't2', busy: true }),
      tr({ terminalId: 't3', busy: true }),
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(0);
    // t2 starts a new turn (the background result woke it): its held alert is stale.
    engine.onTransitions([tr({ terminalId: 't2', prev: 'done', next: 'working' })]);
    engine.backgroundEnded(['t1', 't2', 't3', 't4']);
    settled.add('t3');
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent.map((a) => [a.terminalId, a.kind, a.turn])).toEqual([['t1', 'done', 1]]);
    // Held once, sent once.
    engine.backgroundEnded(['t1']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent).toHaveLength(1);
  });

  it('dedupes the same alert and keeps a recent list', async () => {
    engine.onTransitions([tr({ prev: 'idle', next: 'blocked', turn: 4 })]);
    engine.onTransitions([tr({ prev: 'idle', next: 'blocked', turn: 4 })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    engine.onTransitions([tr({ prev: 'working', next: 'blocked', turn: 4 })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(engine.recent).toHaveLength(2);
  });

  it('ignores sub-agents and paneless terminals', async () => {
    engine.onTransitions([tr({ subAgent: true, next: 'blocked' }), tr({ hasPane: false, next: 'blocked' })]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(0);
  });
});

describe('notifiers', () => {
  it('isolates a failing sink', async () => {
    const got: string[] = [];
    const hub = new NotifierHub()
      .add({
        name: 'broken',
        notify: async () => {
          throw new Error('down');
        },
      })
      .add(new WebPushSink({ vapidPublicKey: '', vapidPrivateKey: '', subject: '' }))
      .add({ name: 'ok', notify: async (a) => void got.push(a.id) });
    await hub.notify({ id: 'a1', kind: 'done', terminalId: 't1', title: 'x', body: null, level: 'info', turn: 1, at: 0 });
    expect(got).toEqual(['a1']);
    expect(hub.sinkNames).toEqual(['broken', 'web-push', 'ok']);
  });
});
