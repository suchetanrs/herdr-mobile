import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrying, wakeChunkRetries } from './chunks';

afterEach(() => vi.useRealTimers());

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('lazy chunk retries', () => {
  it('tries again while the bridge is away, and at once when the connection is back', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('Failed to fetch dynamically imported module');
      return 'chunk';
    });
    const reload = vi.fn(() => true);
    const p = retrying(load, { bridgeUp: async () => false, reload, delay: () => 60_000 })();
    let done: unknown = null;
    void p.then((v) => {
      done = v;
    });
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);
    // The connection opens long before the next timer.
    wakeChunkRetries();
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(done).toBe('chunk');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads a stale page (the bridge answers, the chunk keeps failing), and fails if it just did', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {
      throw new Error('404');
    });
    const reload = vi.fn(() => true);
    void retrying(load, { bridgeUp: async () => true, reload, delay: () => 10 })();
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(1);

    const again = retrying(load, { bridgeUp: async () => true, reload: () => false, delay: () => 10 })();
    const err = again.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(100);
    expect(await err).toBe('404');
  });
});
