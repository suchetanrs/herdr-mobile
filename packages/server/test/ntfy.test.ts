import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AttentionAlert } from '@herdr-mobile/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { NtfySink, ntfyConfigFrom } from '../src/notify/ntfy.js';
import { startBridge, type TestBridge } from './helpers/bridge.js';
import { until } from './helpers/tmp.js';

/** A stand-in ntfy server on loopback (tests never talk to ntfy.sh). */
async function fakeNtfy(status = 200) {
  const got: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      got.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { got, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const alert = (over: Partial<AttentionAlert> = {}): AttentionAlert => ({
  id: 'a1',
  kind: 'blocked',
  terminalId: 't4',
  title: 'reviewer needs you',
  body: 'sub / review',
  level: 'error',
  turn: 7,
  at: 1,
  ...over,
});

let srv: Awaited<ReturnType<typeof fakeNtfy>> | null = null;
let tb: TestBridge | null = null;
afterEach(async () => {
  await tb?.stop();
  tb = null;
  await srv?.close();
  srv = null;
});

describe('ntfy sink (REVIEW P1-1)', () => {
  it('is off unless a topic is set; the server defaults to ntfy.sh, and bad values are refused', () => {
    expect(loadConfig({ HOME: '/h' }).ntfy).toBeNull();
    expect(ntfyConfigFrom({ HERDR_MOBILE_NTFY_TOPIC: 'herdr-abc_123' })).toEqual({ server: 'https://ntfy.sh', topic: 'herdr-abc_123' });
    expect(() => ntfyConfigFrom({ HERDR_MOBILE_NTFY_TOPIC: 'a/b' })).toThrow();
    expect(() => ntfyConfigFrom({ HERDR_MOBILE_NTFY_TOPIC: 'x', HERDR_MOBILE_NTFY_SERVER: 'file:///etc' })).toThrow();
    expect(
      ntfyConfigFrom({
        HERDR_MOBILE_NTFY_TOPIC: 'x',
        HERDR_MOBILE_NTFY_SERVER: 'http://127.0.0.1:1',
        HERDR_MOBILE_NTFY_TOKEN: 'tk',
        HERDR_MOBILE_NTFY_CLICK: 'http://100.64.0.10:8787',
        HERDR_MOBILE_NTFY_PRIVATE: '1',
      }),
    ).toEqual({ server: 'http://127.0.0.1:1', topic: 'x', token: 'tk', clickBase: 'http://100.64.0.10:8787', private: true });
  });

  it('posts title, place, priority, tags and the tap link; token as Bearer', async () => {
    srv = await fakeNtfy();
    const sink = new NtfySink({ config: { server: srv.url, topic: 'herdr-t', token: 'tk', clickBase: 'http://100.1.2.3:8787/' } });
    await sink.notify(alert());
    await sink.notify(alert({ kind: 'done', title: 'Claude Code finished', body: null, level: 'info', terminalId: 'rohan/t2' }));
    expect(srv.got[0]?.headers.authorization).toBe('Bearer tk');
    expect(srv.got[0]?.body).toEqual({
      topic: 'herdr-t',
      title: 'reviewer needs you',
      message: 'sub / review',
      priority: 4,
      tags: ['warning'],
      click: 'http://100.1.2.3:8787/#/a/t4',
    });
    expect(srv.got[1]?.body).toMatchObject({
      title: 'Claude Code finished',
      message: 'Claude Code finished',
      priority: 3,
      click: 'http://100.1.2.3:8787/#/a/rohan%2Ft2',
    });
  });

  it('private mode sends no names or places; no link unless configured', async () => {
    srv = await fakeNtfy();
    const sink = new NtfySink({ config: { server: srv.url, topic: 'herdr-t', private: true } });
    await sink.notify(alert());
    expect(srv.got[0]?.body).toEqual({
      topic: 'herdr-t',
      title: 'An agent needs you',
      message: 'Open Herdr to see which.',
      priority: 4,
      tags: ['warning'],
    });
    expect(JSON.stringify(srv.got[0]?.body)).not.toContain('reviewer');
  });

  it('stays quiet for an agent someone is looking at, caps the rate, and reports server errors', async () => {
    srv = await fakeNtfy();
    const looking = new Set(['t4']);
    const sink = new NtfySink({ config: { server: srv.url, topic: 'herdr-t' }, isLooking: (id) => looking.has(id), perMinute: 2 });
    await sink.notify(alert());
    expect(srv.got).toHaveLength(0);
    looking.clear();
    for (let i = 0; i < 4; i++) await sink.notify(alert({ id: `a${i}` }));
    expect(srv.got).toHaveLength(2);
    const bad = await fakeNtfy(403);
    try {
      await expect(new NtfySink({ config: { server: bad.url, topic: 'x' } }).notify(alert())).rejects.toThrow(/403/);
    } finally {
      await bad.close();
    }
  });

  it('end to end: a blocked agent reaches the ntfy server when configured', async () => {
    srv = await fakeNtfy();
    tb = await startBridge({ ntfy: { server: srv.url, topic: 'herdr-e2e' } });
    tb.core.status('t4', 'blocked');
    await until(() => srv?.got.length === 1, 3000);
    expect(srv.got[0]?.body).toMatchObject({ topic: 'herdr-e2e', title: 'reviewer needs you', message: 'sub / review', priority: 4 });
  });
});
