import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { clientAddress } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startBridge, type TestBridge, TOKEN } from './helpers/bridge.js';

let tb: TestBridge | null = null;
afterEach(async () => {
  await tb?.stop();
  tb = null;
});

const bearer = { authorization: `Bearer ${TOKEN}` };
/** What a browser sends for `<img src="http://bridge/api/x">` on another site. */
const crossSiteImg = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' };

/** A GET with exactly these headers (fetch rewrites Host and Sec-Fetch-*). */
function rawGet(
  base: string,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port: Number(port), path: pathname, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on('error', reject);
  });
}

function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(-1));
  });
}

describe('sign-in rate limit never locks out the owner (REVIEW P1-9)', () => {
  const attempt = (base: string, token: string) =>
    fetch(`http://${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

  it('a signed-in device gets in while its address is blocked; failures still get 429', async () => {
    tb = await startBridge({ authMaxFailures: 5 });
    for (let i = 0; i < 5; i++) expect((await attempt(tb.base, 'nope')).status).toBe(401);
    expect((await attempt(tb.base, 'nope')).status).toBe(429);
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie: tb.cookie } })).status).toBe(200);
    expect((await fetch(`http://${tb.base}/api/world`, { headers: bearer })).status).toBe(200);
    expect(await wsStatus(tb.wsUrl(), { cookie: tb.cookie })).toBe(101);
  });

  it("another site's page can't burn attempts: cross-site requests are refused and not counted", async () => {
    tb = await startBridge({ authMaxFailures: 5 });
    for (let i = 0; i < 20; i++) expect((await fetch(`http://${tb.base}/api/world`, { headers: crossSiteImg })).status).toBe(403);
    // An old link with a bad token from another site counts as nothing either.
    expect((await fetch(`http://${tb.base}/?token=nope`, { headers: crossSiteImg, redirect: 'manual' })).status).toBe(302);
    // A cross-site WebSocket is refused before auth (and not counted).
    for (let i = 0; i < 8; i++) expect(await wsStatus(tb.wsUrl(), { origin: 'http://evil.example' })).toBe(403);
    expect(await wsStatus(tb.wsUrl())).toBe(401);
    // The first sign-in from this address still works.
    expect((await attempt(tb.base, TOKEN)).status).toBe(201);
  });

  it('refuses unknown Host names (DNS rebinding), keeps IPs and localhost', async () => {
    tb = await startBridge();
    const port = tb.base.split(':')[1];
    const get = (host: string) => rawGet(tb?.base ?? '', '/api/health', { host });
    expect((await get(`evil.example:${port}`)).status).toBe(421);
    expect((await get(`127.0.0.1:${port}`)).status).toBe(200);
    expect((await get(`localhost:${port}`)).status).toBe(200);
    expect((await get(`[::1]:${port}`)).status).toBe(200);
    expect(await wsStatus(tb.wsUrl(), { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(421);
  });
});

describe('public surface (REVIEW P3-6, P3-7, P3-8, P2-14)', () => {
  it('health without a session says only that it is up; details need a session', async () => {
    tb = await startBridge();
    const pub = (await (await fetch(`http://${tb.base}/api/health`)).json()) as Record<string, unknown>;
    expect(pub).toEqual({ ok: true });
    const full = (await (await fetch(`http://${tb.base}/api/health`, { headers: bearer })).json()) as {
      bridge: { clients: number };
      core: { version: string };
    };
    expect(full.core.version).toBe('0.1.18');
    expect(typeof full.bridge.clients).toBe('number');
  });

  it('does not serve source maps unless asked to', async () => {
    tb = await startBridge();
    fs.mkdirSync(path.join(tb.dir, 'web', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tb.dir, 'web', 'index.html'), '<!doctype html><title>Herdr</title>');
    fs.writeFileSync(path.join(tb.dir, 'web', 'assets', 'app-1.js.map'), '{"version":3}');
    expect((await fetch(`http://${tb.base}/assets/app-1.js.map`)).status).toBe(404);
  });

  it('refuses a short HERDR_MOBILE_TOKEN', () => {
    expect(() => loadConfig({ HOME: '/h', HERDR_MOBILE_TOKEN: 'short' })).toThrow(/at least 32/);
    expect(loadConfig({ HOME: '/h', HERDR_MOBILE_TOKEN: 'x'.repeat(32) }).token).toBe('x'.repeat(32));
  });

  it('takes the rightmost untrusted X-Forwarded-For entry (the one the local proxy added)', () => {
    expect(clientAddress('127.0.0.1', '6.6.6.6, 100.5.5.5', true)).toBe('100.5.5.5');
    expect(clientAddress('127.0.0.1', ['6.6.6.6', '100.5.5.5, 127.0.0.1'], true)).toBe('100.5.5.5');
    expect(clientAddress('127.0.0.1', '100.5.5.5', true)).toBe('100.5.5.5');
  });
});
