// @vitest-environment jsdom
import type { AttentionAlert } from '@herdr-mobile/protocol';
import { describe, expect, it, vi } from 'vitest';
import { sampleWorld, term } from '../test/fixtures';
import { AppStore, patchWorld } from './store';

const alert = (id: string, at = 5): AttentionAlert => ({
  id,
  kind: 'blocked',
  terminalId: 't4',
  title: 'beta needs you',
  body: 'beta / 1',
  level: 'error',
  turn: 1,
  at,
});

describe('AppStore', () => {
  it('applies a snapshot, then numbered patches as new objects', () => {
    const s = new AppStore();
    const seen = vi.fn();
    s.subscribe(seen);
    s.handle({ t: 'welcome', v: 1, serverId: 'srv', heartbeatMs: 15000 });
    s.handle({ t: 'snapshot', seq: 10, world: sampleWorld(), alerts: [alert('a1', 1)] });
    const before = s.getState().world;
    expect(s.handle({ t: 'patch', seq: 11, ops: [{ op: 'terminal', value: term('t5', { spaceId: 'spC', status: 'working' }) }] })).toBe(
      'ok',
    );
    const after = s.getState().world;
    expect(after).not.toBe(before);
    expect(after.terminals).not.toBe(before.terminals);
    expect(after.spaces).toBe(before.spaces);
    expect(after.terminals.t5?.status).toBe('working');
    expect(s.getState().seq).toBe(11);
    expect(s.getState().conn.everSynced).toBe(true);
    expect(s.resumePoint()).toEqual({ serverId: 'srv', seq: 11 });
    expect(seen).toHaveBeenCalled();
  });

  it('reports a gap when a numbered message is skipped (or a heartbeat is ahead)', () => {
    const s = new AppStore();
    s.handle({ t: 'snapshot', seq: 3, world: sampleWorld(), alerts: [] });
    expect(s.handle({ t: 'patch', seq: 5, ops: [] })).toBe('gap');
    expect(s.handle({ t: 'hb', seq: 4, ts: 0 })).toBe('gap');
    expect(s.handle({ t: 'hb', seq: 3, ts: 0 })).toBe('ok');
  });

  it('announces live alerts once, keeps them newest first, and remembers what was read', () => {
    localStorage.clear();
    const s = new AppStore();
    const heard = vi.fn();
    s.onAlert(heard);
    s.handle({ t: 'snapshot', seq: 1, world: sampleWorld(), alerts: [alert('old', 1)] });
    expect(heard).not.toHaveBeenCalled();
    s.handle({ t: 'alert', seq: 2, alert: alert('new', 9) });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(s.getState().alerts.map((a) => [a.id, a.read])).toEqual([
      ['new', false],
      ['old', false],
    ]);
    s.markAlertsRead(['new']);
    expect(new AppStore().getState().alerts).toEqual([]);
    const again = new AppStore();
    again.handle({ t: 'snapshot', seq: 1, world: sampleWorld(), alerts: [alert('new', 9)] });
    expect(again.getState().alerts[0]?.read).toBe(true);
  });

  it('patchWorld deletes and reorders', () => {
    const w = patchWorld(sampleWorld(), [
      { op: 'delTerminal', id: 't5' },
      { op: 'spaceOrder', value: ['spB'] },
    ]);
    expect(w.terminals.t5).toBeUndefined();
    expect(w.spaceOrder).toEqual(['spB']);
  });
});
