// Task 23: on-device diagnostics (POST /api/diag) and the web build id in `welcome`.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIAG_BODY_LIMIT, DIAG_PER_MINUTE, DiagLimiter, DiagLog, sanitize } from '../src/diag/log.js';
import { startBridge, type TestBridge, TOKEN } from './helpers/bridge.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';
import { Client } from './helpers/wsClient.js';

let tb: TestBridge | null = null;
afterEach(async () => {
  await tb?.stop();
  tb = null;
});

const SECRET = 'Sk3cretTokenValue0123456789abcdefXYZ0123';

async function post(base: string, body: string, headers: Record<string, string> = {}) {
  const r = await fetch(`http://${base}/api/diag`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  await r.text();
  return r.status;
}

describe('sanitize / DiagLog / DiagLimiter', () => {
  it('drops secret-looking keys, redacts token-like strings, bounds depth and size', () => {
    const out = sanitize({
      info: { ua: 'iPhone', cookie: 'hm_session=x', token: SECRET, signedIn: true },
      events: [{ k: 'error', msg: `boom ${SECRET}`, value: 'typed', textContent: 'screen' }],
      deep: { a: { b: { c: { d: { e: 1 } } } } },
      long: 'x'.repeat(1000),
    }) as {
      info: unknown;
      events: unknown[];
      deep: { a: { b: { c: { d: unknown } } } };
      long: string;
    };
    expect(out.info).toEqual({ ua: 'iPhone', signedIn: true });
    expect(out.events[0]).toEqual({ k: 'error', msg: 'boom [redacted]' });
    expect(out.deep.a.b.c.d).toBeNull();
    expect(out.long.length).toBeLessThanOrEqual(301);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('writes 0600 lines and rolls the file over at its cap', () => {
    const dir = tmpDir('diag');
    try {
      const file = path.join(dir, 'state', 'diag.jsonl');
      const log = new DiagLog(file, 300);
      for (let i = 0; i < 6; i++) log.append({ i, pad: 'p'.repeat(80) });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).size).toBeLessThanOrEqual(300);
      expect(fs.existsSync(`${file}.1`)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(JSON.parse(lines[lines.length - 1] as string).i).toBe(5);
    } finally {
      rmDir(dir);
    }
  });

  it('per device: DIAG_PER_MINUTE a minute, then again after it', () => {
    let now = 0;
    const lim = new DiagLimiter(() => now);
    for (let i = 0; i < DIAG_PER_MINUTE; i++) expect(lim.allow('a')).toBe(true);
    expect(lim.allow('a')).toBe(false);
    expect(lim.allow('b')).toBe(true);
    now += 61_000;
    expect(lim.allow('a')).toBe(true);
  });
});

describe('POST /api/diag', () => {
  it('401 without a session (also with the token as a loopback bearer); saved with one', async () => {
    const dir = tmpDir('diagb');
    const file = path.join(dir, 'diag.jsonl');
    tb = await startBridge({ diagFile: file });
    expect(await post(tb.base, '{"info":{}}')).toBe(401);
    expect(await post(tb.base, '{"info":{}}', { cookie: 'hm_session=nope' })).toBe(401);
    expect(await post(tb.base, '{"info":{}}', { authorization: `Bearer ${TOKEN}` })).toBe(401);
    expect(fs.existsSync(file)).toBe(false);
    const body = JSON.stringify({ info: { ua: 'iPhone', token: TOKEN }, events: [{ k: 'touchend', tg: 'textarea', msg: TOKEN }] });
    expect(await post(tb.base, body, { cookie: tb.cookie })).toBe(200);
    const text = fs.readFileSync(file, 'utf8');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(tb.cookie.split('=')[1] as string);
    const line = JSON.parse(text.trim()) as { device: string; report: { info: unknown; events: unknown[] } };
    expect(line.report.info).toEqual({ ua: 'iPhone' });
    expect(line.report.events).toEqual([{ k: 'touchend', tg: 'textarea', msg: '[redacted]' }]);
    rmDir(dir);
  });

  it('JSON only, size-limited, rate-limited per device', async () => {
    const dir = tmpDir('diagc');
    tb = await startBridge({ diagFile: path.join(dir, 'diag.jsonl') });
    const cookie = { cookie: tb.cookie };
    expect(await post(tb.base, 'x', { ...cookie, 'content-type': 'text/plain' })).toBe(415);
    expect(await post(tb.base, JSON.stringify({ pad: 'p'.repeat(DIAG_BODY_LIMIT) }), cookie)).toBe(413);
    expect(await post(tb.base, '[1,2]', cookie)).toBe(400);
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < DIAG_PER_MINUTE + 2; i++) {
      const s = await post(tb.base, '{"info":{}}', cookie);
      if (s === 200) ok++;
      if (s === 429) limited++;
    }
    expect(ok).toBe(DIAG_PER_MINUTE);
    expect(limited).toBe(2);
    rmDir(dir);
  });
});

describe('web build id', () => {
  it('welcome carries the served index.html build id, health shows it, and it follows a rebuild', async () => {
    tb = await startBridge();
    const web = path.join(tb.dir, 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<head><meta name="herdr-build" content="abc1234 2026-11-07T16:00Z"></head>');
    const c = new Client(tb.wsUrl());
    await until(() => c.of('welcome').length > 0);
    expect(c.of('welcome')[0]?.build).toBe('abc1234 2026-11-07T16:00Z');
    c.close();
    const h = (await (await fetch(`http://${tb.base}/api/health`, { headers: { cookie: tb.cookie } })).json()) as {
      bridge: { webBuild: string };
    };
    expect(h.bridge.webBuild).toBe('abc1234 2026-11-07T16:00Z');
    fs.writeFileSync(path.join(web, 'index.html'), '<head><meta name="herdr-build" content="def5678 2026-11-07T17:00Z"></head>');
    const later = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(web, 'index.html'), later, later);
    const c2 = new Client(tb.wsUrl());
    await until(() => c2.of('welcome').length > 0);
    expect(c2.of('welcome')[0]?.build).toBe('def5678 2026-11-07T17:00Z');
    c2.close();
  });
});
