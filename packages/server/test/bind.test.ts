import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolveBind } from '../src/transport/listen.js';
import { startBridge, type TestBridge } from './helpers/bridge.js';

let tb: TestBridge | null = null;
afterEach(async () => {
  await tb?.stop();
  tb = null;
});

function healthOn(host: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => {
      req.destroy();
      resolve(-1);
    });
  });
}

const ifaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4' }],
  wlp2s0: [{ address: '192.0.2.10', family: 'IPv4' }],
  tailscale0: [
    { address: 'fd7a:115c:a1e0::1', family: 'IPv6' },
    { address: '100.64.0.10', family: 'IPv4' },
  ],
} as unknown as Parameters<typeof resolveBind>[1];

describe('HERDR_MOBILE_BIND (REVIEW P1-7)', () => {
  it('resolves loopback, tailscale and literal addresses; reports tailscale missing when it is down', () => {
    const at = (spec: string[], ifs = ifaces) => resolveBind(spec, ifs).addresses.map((a) => a.address);
    expect(at(['loopback', 'tailscale'])).toEqual(['127.0.0.1', '100.64.0.10']);
    expect(resolveBind(['tailscale'], { lo: ifaces?.lo } as typeof ifaces)).toEqual({ addresses: [], missing: ['tailscale'] });
    expect(resolveBind(['192.0.2.10'], ifaces).addresses).toEqual([{ address: '192.0.2.10', kind: 'lan' }]);
  });

  it('config: unset = loopback + Tailscale; bad entries are refused', () => {
    expect(loadConfig({ HOME: '/h' })).toMatchObject({ host: '127.0.0.1', bind: ['loopback', 'tailscale'] });
    expect(loadConfig({ HOME: '/h', HERDR_MOBILE_BIND: 'loopback,tailscale,lan' }).bind).toEqual(['loopback', 'tailscale', 'lan']);
    expect(loadConfig({ HOME: '/h', HERDR_MOBILE_BIND: 'loopback, tailscale' }).bind).toEqual(['loopback', 'tailscale']);
    expect(() => loadConfig({ HOME: '/h', HERDR_MOBILE_BIND: 'wifi' })).toThrow(/HERDR_MOBILE_BIND/);
  });

  it('listens on loopback plus exactly the listed addresses', async () => {
    tb = await startBridge({ bind: ['127.0.0.2'] });
    const port = Number(tb.base.split(':')[1]);
    expect(await healthOn('127.0.0.1', port)).toBe(200);
    expect(await healthOn('127.0.0.2', port)).toBe(200);
    expect(await healthOn('127.0.0.3', port)).toBe(-1);
  });
});
