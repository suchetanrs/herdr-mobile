import { describe, expect, it } from 'vitest';
import { StreamLog } from '../src/transport/log.js';

describe('StreamLog', () => {
  it('replays what a client missed, or asks for a snapshot', () => {
    const log = new StreamLog(3);
    for (let i = 0; i < 5; i++) log.patch([{ op: 'spaceOrder', value: [String(i)] }]);
    expect(log.seq).toBe(5);
    expect(log.since(5)).toEqual([]);
    expect(log.since(3)?.map((m) => m.seq)).toEqual([4, 5]);
    expect(log.since(2)?.map((m) => m.seq)).toEqual([3, 4, 5]);
    expect(log.since(1)).toBeNull();
    expect(log.since(9)).toBeNull();
  });
});
