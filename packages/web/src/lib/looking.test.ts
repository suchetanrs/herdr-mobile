// @vitest-environment jsdom
import { LOOKING_RENEW_MS } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from './connection';
import { LookingTracker } from './looking';

function rig() {
  const sent: unknown[] = [];
  const conn = {
    onOpen: () => () => {},
    send: (m: unknown) => {
      sent.push(m);
      return true;
    },
  } as unknown as Connection;
  return { sent, tracker: new LookingTracker(conn) };
}

describe('LookingTracker (REVIEW P0-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => vi.useRealTimers());

  it('renews the lease while an agent stays on screen, and stops once it leaves', async () => {
    const { sent, tracker } = rig();
    const leave = tracker.add('t1');
    await vi.advanceTimersByTimeAsync(60);
    expect(sent).toEqual([{ t: 'looking', terminalIds: ['t1'] }]);
    await vi.advanceTimersByTimeAsync(LOOKING_RENEW_MS * 2 + 10);
    expect(sent.length).toBe(3);
    leave();
    await vi.advanceTimersByTimeAsync(60);
    expect(sent.at(-1)).toEqual({ t: 'looking', terminalIds: [] });
    const n = sent.length;
    await vi.advanceTimersByTimeAsync(LOOKING_RENEW_MS * 3);
    expect(sent.length).toBe(n);
  });

  it('a visible but unfocused desktop window is not looking', async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(pointer: fine)' })) as unknown as typeof window.matchMedia;
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      const { tracker } = rig();
      tracker.add('t1');
      expect(tracker.current()).toEqual([]);
      focus.mockReturnValue(true);
      expect(tracker.current()).toEqual(['t1']);
    } finally {
      focus.mockRestore();
      window.matchMedia = mm;
    }
  });
});
