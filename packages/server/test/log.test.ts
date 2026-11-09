import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { StreamLog } from '../src/transport/log.js';
import { startBridge, TOKEN } from './helpers/bridge.js';

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

describe('request logging', () => {
  const run = async (logLevel: 'info' | 'debug') => {
    const lines: string[] = [];
    const warnings: string[] = [];
    const onWarning = (w: Error & { code?: string }) => warnings.push(String(w.code ?? w.name));
    process.on('warning', onWarning);
    const logStream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const tb = await startBridge({ logLevel, logStream });
    try {
      await fetch(`http://${tb.base}/api/health?token=${TOKEN}`, { headers: { cookie: tb.cookie } });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await tb.stop();
      process.off('warning', onWarning);
    }
    return { requests: lines.filter((l) => l.includes('incoming request')), all: lines.join(''), warnings };
  };

  it('writes per-request lines only at debug, never the token, with no Fastify deprecation warning', async () => {
    const info = await run('info');
    expect(info.requests).toEqual([]);
    const debug = await run('debug');
    expect(debug.requests.some((l) => l.includes('/api/health'))).toBe(true);
    expect(debug.all).not.toContain(TOKEN);
    expect([...info.warnings, ...debug.warnings].filter((c) => c.startsWith('FSTDEP'))).toEqual([]);
  });
});
