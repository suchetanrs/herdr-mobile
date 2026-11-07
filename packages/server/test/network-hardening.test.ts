// Regression tests for SECURITY_AUDIT.md (task 16): one block per network-facing finding. Black-box where it can
// be (HTTP and WebSocket against a bridge on loopback, plus 127.0.0.2/127.0.0.3 standing in for the Tailscale
// address), so each one fails against the pre-hardening bridge.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { signIn, startBridge, type TestBridge, TOKEN } from './helpers/bridge.js';
import { sleep, until } from './helpers/tmp.js';

let tb: TestBridge | null = null;
afterEach(async () => {
  await tb?.stop();
  tb = null;
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const portOf = (b: TestBridge) => Number(b.base.split(':')[1]);

/** Polls an async check until it's true (false when time runs out). */
async function eventually(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request with exactly these headers (fetch rewrites Host and Sec-Fetch-*). */
function raw(
  host: string,
  port: number,
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: pathname, method: opts.method ?? 'GET', headers: opts.headers ?? {}, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** -1 when the connection is refused or reset. */
async function statusOn(host: string, port: number, pathname = '/api/health', headers: Record<string, string> = {}): Promise<number> {
  try {
    return (await raw(host, port, pathname, { headers: { host: `${host}:${port}`, ...headers } })).status;
  } catch {
    return -1;
  }
}

function wsStatus(url: string, headers: Record<string, string> = {}, localAddress?: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, ...(localAddress ? { localAddress } : {}) });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(-1));
  });
}

/** Opens a TCP connection; resolves with the ms until the server closed it (or `max` when it didn't). */
function heldFor(host: string, port: number, max: number, onOpen?: (s: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      resolve(Date.now() - t0);
    };
    s.on('connect', () => onOpen?.(s));
    s.on('close', end);
    s.on('error', end);
    const timer = setTimeout(() => {
      done = true;
      s.destroy();
      resolve(max);
    }, max);
  });
}

type Ifaces = ReturnType<typeof os.networkInterfaces>;
const iface = (address: string) => [
  { address, family: 'IPv4', internal: false, netmask: '255.255.255.255', mac: '00:00:00:00:00:00', cidr: `${address}/32` },
];

describe('N1: listens on loopback + Tailscale only, follows Tailscale coming and going', () => {
  it('default bind is loopback + Tailscale; the HTTP server itself is loopback', () => {
    const c = loadConfig({ HOME: '/h' });
    expect(c.bind).toEqual(['loopback', 'tailscale']);
    expect(c.host).toBe('127.0.0.1');
  });

  it('a Tailscale address is bound when it appears, moved when it changes, dropped when it goes', async () => {
    const now: { ifaces: Ifaces } = { ifaces: { lo: iface('127.0.0.1') } as unknown as Ifaces };
    tb = await startBridge({ bind: ['loopback', 'tailscale'], bindPollMs: 50, ifaces: () => now.ifaces });
    const port = portOf(tb);
    expect(await statusOn('127.0.0.1', port)).toBe(200);
    expect(await statusOn('127.0.0.2', port)).toBe(-1);
    now.ifaces = { lo: iface('127.0.0.1'), tailscale0: iface('127.0.0.2') } as unknown as Ifaces;
    expect(await eventually(async () => (await statusOn('127.0.0.2', port)) === 200, 3000)).toBeTruthy();
    now.ifaces = { lo: iface('127.0.0.1'), tailscale0: iface('127.0.0.3') } as unknown as Ifaces;
    expect(await eventually(async () => (await statusOn('127.0.0.3', port)) === 200, 3000)).toBeTruthy();
    expect(await statusOn('127.0.0.2', port)).toBe(-1);
    now.ifaces = { lo: iface('127.0.0.1') } as unknown as Ifaces;
    expect(await eventually(async () => (await statusOn('127.0.0.3', port)) === -1, 3000)).toBeTruthy();
    expect(await statusOn('127.0.0.1', port)).toBe(200);
  });

  it('LAN interfaces are not bound by default; `lan`/`all` are an explicit opt-in', async () => {
    const { resolveBind } = await import('../src/transport/listen.js');
    const ifs = {
      lo: iface('127.0.0.1'),
      wlp2s0: iface('192.0.2.10'),
      docker0: iface('198.51.100.1'),
      tailscale0: iface('100.64.0.10'),
    } as unknown as Ifaces;
    expect(resolveBind(['loopback', 'tailscale'], ifs).addresses.map((a) => a.address)).toEqual(['127.0.0.1', '100.64.0.10']);
    expect(resolveBind(['lan'], ifs).addresses.map((a) => a.address)).toEqual(['192.0.2.10']);
    expect(resolveBind(['all'], ifs).addresses.map((a) => a.address)).toEqual(['192.0.2.10', '198.51.100.1', '100.64.0.10']);
  });

  it('on the Tailscale address only tailnet peers (or this machine) get in: not a LAN packet sent to that IP', async () => {
    const { ConnectionGate } = await import('../src/transport/listen.js');
    const gate = new ConnectionGate();
    const sock = (remoteAddress: string) => {
      const s = new PassThrough() as unknown as net.Socket & { destroyed: boolean };
      Object.defineProperty(s, 'remoteAddress', { value: remoteAddress });
      return s;
    };
    const lan = sock('192.0.2.50');
    expect(gate.admit(lan, 'tailscale')).toBe(false);
    expect(lan.destroyed).toBe(true);
    expect(gate.admit(sock('100.101.102.103'), 'tailscale')).toBe(true);
    expect(gate.admit(sock('127.0.0.1'), 'tailscale')).toBe(true);
  });

  it('a year-long immutable cache only where assets cannot be rewritten in transit', async () => {
    const { cacheControl } = await import('../src/transport/static.js');
    expect(cacheControl('/assets/a.js', '.js', 'tailscale', false)).toContain('immutable');
    expect(cacheControl('/assets/a.js', '.js', 'loopback', false)).toContain('immutable');
    expect(cacheControl('/assets/a.js', '.js', 'lan', false)).toBe('no-store');
    expect(cacheControl('/', '.html', 'lan', false)).toBe('no-store');
  });
});

describe('N2: the token is exchanged once for a per-device session', () => {
  it('?token= never signs in (API, page, WebSocket); an old link is only redirected away', async () => {
    tb = await startBridge();
    const port = portOf(tb);
    expect((await raw('127.0.0.1', port, `/api/world?token=${TOKEN}`)).status).toBe(401);
    const page = await raw('127.0.0.1', port, `/agents?token=${TOKEN}&x=1`);
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/agents?x=1');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(await wsStatus(tb.wsUrl(`?token=${TOKEN}`))).toBe(401);
    expect(await wsStatus(tb.wsUrl(), { authorization: `Bearer ${TOKEN}` })).toBe(401);
  });

  it('POST /api/session sets an HttpOnly, SameSite=Strict session cookie that is not the token; stored hashed, 0600', async () => {
    tb = await startBridge();
    const r = await fetch(`http://${tb.base}/api/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(r.status).toBe(201);
    const set = r.headers.getSetCookie().find((c) => c.startsWith('hm_session=')) ?? '';
    expect(set).toMatch(/^hm_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(set).not.toContain(TOKEN);
    const secret = set.slice('hm_session='.length, set.indexOf(';'));
    const file = path.join(tb.dir, 'cfg', 'sessions.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const stored = fs.readFileSync(file, 'utf8');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain('iPhone · Safari');
    const cookie = set.split(';')[0] as string;
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie } })).status).toBe(200);
    expect(await wsStatus(tb.wsUrl(), { cookie })).toBe(101);
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie: 'hm_session=x'.padEnd(54, 'y') } })).status).toBe(401);
  });

  it('the token as a bearer header works only for tools on this machine, never over the network', async () => {
    tb = await startBridge({ trustProxy: true });
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect((await raw('127.0.0.1', portOf(tb), '/api/world', { headers: bearer })).status).toBe(200);
    // Behind the local HTTPS proxy, a tailnet client's request arrives from loopback with its address forwarded.
    expect((await raw('127.0.0.1', portOf(tb), '/api/world', { headers: { ...bearer, 'x-forwarded-for': '100.5.5.5' } })).status).toBe(401);
  });

  it('devices are listed and revocable; revoking closes their WebSocket; sign out everywhere', async () => {
    tb = await startBridge();
    const other = await signIn(tb.base, TOKEN, {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130.0 Mobile Safari/537.36',
    });
    const list = (await (await fetch(`http://${tb.base}/api/sessions`, { headers: { cookie: tb.cookie } })).json()) as {
      current: string;
      devices: Array<{ id: string; name: string; created: string; lastSeen: string; ip: string }>;
    };
    expect(list.devices).toHaveLength(2);
    expect(list.devices.map((d) => d.ip)).toEqual(['127.0.0.1', '127.0.0.1']);
    const android = list.devices.find((d) => d.name === 'Android · Chrome');
    expect(android).toBeDefined();
    expect(list.current).not.toBe(android?.id);
    const ws = new WebSocket(tb.wsUrl(), { headers: { cookie: other } });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise((r) => ws.on('open', r));
    expect(
      (await fetch(`http://${tb.base}/api/sessions/${android?.id}`, { method: 'DELETE', headers: { cookie: tb.cookie } })).status,
    ).toBe(200);
    expect(await closed).toBe(4401);
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie: other } })).status).toBe(401);
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie: tb.cookie } })).status).toBe(200);
    expect((await fetch(`http://${tb.base}/api/sessions`, { method: 'DELETE', headers: { cookie: tb.cookie } })).status).toBe(200);
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie: tb.cookie } })).status).toBe(401);
  });

  it('a new token (rotation) stops the old one at once; sessions survive', async () => {
    tb = await startBridge({ token: null });
    const file = path.join(tb.dir, 'cfg', 'token');
    const old = fs.readFileSync(file, 'utf8').trim();
    const cookie = await signIn(tb.base, old);
    const next = 'n'.repeat(43);
    fs.writeFileSync(`${file}.tmp`, `${next}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    await expect(signIn(tb.base, old)).rejects.toThrow(/401/);
    await expect(signIn(tb.base, next)).resolves.toMatch(/^hm_session=/);
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie } })).status).toBe(200);
  });

  it('scripts/rotate-token.sh writes a new 0600 token; --all also signs every device out', async () => {
    const { execFileSync } = await import('node:child_process');
    const { tmpDir, rmDir } = await import('./helpers/tmp.js');
    const xdg = tmpDir('rotate');
    const dir = path.join(xdg, 'herdr-mobile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'token'), `${'o'.repeat(43)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"v":1,"sessions":[]}\n', { mode: 0o600 });
    const env = { ...process.env, XDG_CONFIG_HOME: xdg, HERDR_MOBILE_UNIT: 'hm-test-no-such-unit.service' };
    const out = execFileSync('bash', [path.join(REPO, 'scripts/rotate-token.sh')], { env, encoding: 'utf8' });
    const t1 = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t1).not.toBe('o'.repeat(43));
    expect(out).not.toContain(t1);
    expect(fs.statSync(path.join(dir, 'token')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, 'sessions.json'))).toBe(true);
    execFileSync('bash', [path.join(REPO, 'scripts/rotate-token.sh'), '--all'], { env, encoding: 'utf8' });
    expect(fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()).not.toBe(t1);
    expect(fs.existsSync(path.join(dir, 'sessions.json'))).toBe(false);
    rmDir(xdg);
  });
});

describe('N3: connection and time limits before authentication', () => {
  it('defaults: headers 10 s, request 15 s, keep-alive 5 s, 512 connections', async () => {
    tb = await startBridge();
    const s = tb.bridge.http.server;
    expect(s.headersTimeout).toBeLessThanOrEqual(10_000);
    expect(s.requestTimeout).toBeLessThanOrEqual(15_000);
    expect(s.keepAliveTimeout).toBeLessThanOrEqual(5_000);
    expect(s.maxConnections).toBe(512);
  });

  it('a connection that sends nothing (or drips headers) is closed after the headers timeout', async () => {
    tb = await startBridge({ limits: { headersTimeoutMs: 500, requestTimeoutMs: 800, checkIntervalMs: 100 } });
    const port = portOf(tb);
    expect(await heldFor('127.0.0.1', port, 4000)).toBeLessThan(2000);
    const drip = await heldFor('127.0.0.1', port, 4000, (s) => {
      s.write('GET / HTTP/1.1\r\n');
      const t = setInterval(() => s.writable && s.write('X-A: b\r\n'), 100);
      s.on('close', () => clearInterval(t));
    });
    expect(drip).toBeLessThan(2000);
  });

  it('an unauthenticated request declaring a big body gets 413 and its connection closed (no draining)', async () => {
    tb = await startBridge();
    const port = portOf(tb);
    let head = '';
    const held = await heldFor('127.0.0.1', port, 5000, (s) => {
      s.setEncoding('utf8');
      s.on('data', (d) => {
        head += d;
      });
      s.write(
        `POST /api/spaces HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100000000\r\n\r\n`,
      );
      const t = setInterval(() => s.writable && s.write('x'.repeat(1024)), 50);
      s.on('close', () => clearInterval(t));
    });
    expect(head).toMatch(/^HTTP\/1\.1 413/);
    expect(held).toBeLessThan(3000);
  });

  it('per-peer connection cap on network listeners; total cap', async () => {
    tb = await startBridge({ bind: ['127.0.0.2'], limits: { maxConnectionsPerPeer: 3 } });
    const port = portOf(tb);
    const socks: net.Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = net.connect({ host: '127.0.0.2', port });
      await new Promise((r) => s.on('connect', r));
      socks.push(s);
    }
    await sleep(50);
    expect(await heldFor('127.0.0.2', port, 1500)).toBeLessThan(500);
    // Loopback (the machine itself) isn't limited.
    expect(await statusOn('127.0.0.1', port)).toBe(200);
    for (const s of socks) s.destroy();
    expect(await eventually(async () => (await statusOn('127.0.0.2', port)) === 200, 2000)).toBeTruthy();
  });

  it('per-peer WebSocket cap on network listeners', async () => {
    tb = await startBridge({ bind: ['127.0.0.2'], limits: { maxWsPerPeer: 2 } });
    const port = portOf(tb);
    const url = `ws://127.0.0.2:${port}/ws`;
    const open: WebSocket[] = [];
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(url, { headers: { cookie: tb.cookie } });
      await new Promise((r) => ws.on('open', r));
      open.push(ws);
    }
    expect(await wsStatus(url, { cookie: tb.cookie })).toBe(429);
    for (const ws of open) ws.close();
  });

  it('an unauthenticated WebSocket upgrade is refused before the upgrade and closed', async () => {
    tb = await startBridge();
    const port = portOf(tb);
    let reply = '';
    const held = await heldFor('127.0.0.1', port, 4000, (s) => {
      s.setEncoding('latin1');
      s.on('data', (d) => {
        reply += d;
      });
      s.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      // A frame sent right away anyway: never parsed.
      s.write(Buffer.from([0x81, 0x85, 1, 2, 3, 4, 0x69, 0x67, 0x6f, 0x68, 0x6e]));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 401/);
    expect(reply).not.toContain('101 Switching');
    expect(held).toBeLessThan(2500);
  });
});

describe('N4: no source maps, by any spelling', () => {
  it('the production build emits none', () => {
    const vite = fs.readFileSync(path.join(REPO, 'packages/web/vite.config.ts'), 'utf8');
    expect(vite).toMatch(/sourcemap:\s*false/);
  });

  it('a .map file in the web folder is never served', async () => {
    tb = await startBridge();
    fs.mkdirSync(path.join(tb.dir, 'web', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tb.dir, 'web', 'index.html'), '<!doctype html><title>Herdr</title>');
    fs.writeFileSync(path.join(tb.dir, 'web', 'assets', 'app-1.js'), 'x');
    fs.writeFileSync(path.join(tb.dir, 'web', 'assets', 'app-1.js.map'), '{"version":3}');
    const port = portOf(tb);
    for (const p of [
      '/assets/app-1.js.map',
      '/assets/app-1.js.map/',
      '/assets/app-1.js.map//',
      '/assets/app-1.js.map/.',
      '/assets/app-1.js%2Emap',
      '/assets/app-1.js.map%2F',
      '/assets//app-1.js.map',
      '/assets/./app-1.js.map',
      '/assets/x/../app-1.js.map',
      '/assets/app-1.js.map?x=1',
      '/assets/app-1.js.MAP',
      '/assets/app-1.js/',
    ]) {
      const r = await raw('127.0.0.1', port, p);
      expect(r.status, p).toBe(404);
      expect(r.body, p).not.toContain('version');
    }
    expect((await raw('127.0.0.1', port, '/assets/app-1.js')).status).toBe(200);
  });
});

describe('N5: public health says nothing', () => {
  it('without a session: exactly { ok: true }, also while the core is down', async () => {
    tb = await startBridge();
    expect(await (await fetch(`http://${tb.base}/api/health`)).json()).toEqual({ ok: true });
    await tb.core.close();
    await until(() => !tb?.bridge.store.world.core.connected);
    expect(await (await fetch(`http://${tb.base}/api/health`)).json()).toEqual({ ok: true });
    const full = (await (await fetch(`http://${tb.base}/api/health`, { headers: { cookie: tb.cookie } })).json()) as { status: string };
    expect(full.status).toBe('degraded');
  });
});

describe('N6: Host allowlist = the bound addresses (+ localhost on loopback)', () => {
  it('refuses wildcard tailnet/localhost names, the machine name, unbound IPs and other ports', async () => {
    tb = await startBridge();
    const port = portOf(tb);
    const get = (host: string) => raw('127.0.0.1', port, '/api/health', { headers: { host } });
    for (const host of [
      `evil.ts.net:${port}`,
      `attacker.localhost:${port}`,
      `${os.hostname()}:${port}`,
      `127.0.0.2:${port}`,
      `100.64.0.10:${port}`,
      '127.0.0.1:1',
      '127.0.0.1',
    ]) {
      expect((await get(host)).status, host).toBe(421);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) expect((await get(host)).status, host).toBe(200);
    expect(await wsStatus(tb.wsUrl(), { host: `evil.ts.net:${port}`, cookie: tb.cookie })).toBe(421);
  });

  it('localhost names only count on a loopback connection; a bound network address is allowed there', async () => {
    tb = await startBridge({ bind: ['127.0.0.2'] });
    const port = portOf(tb);
    expect(await statusOn('127.0.0.2', port, '/api/health')).toBe(200);
    const r = await raw('127.0.0.2', port, '/api/health', { headers: { host: `localhost:${port}` } });
    expect(r.status).toBe(421);
  });
});

describe('N7: a web page cannot block a first sign-in', () => {
  it('cross-site attempts, old ?token= links and stale cookies never count; same-origin wrong tokens do', async () => {
    tb = await startBridge({ authMaxFailures: 5 });
    const port = portOf(tb);
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (let i = 0; i < 12; i++) {
      // Top-level navigations another page can trigger.
      expect((await raw('127.0.0.1', port, '/?token=wrong', { headers: nav })).status).toBe(302);
      expect(
        (
          await raw('127.0.0.1', port, '/api/session', {
            method: 'POST',
            headers: { ...nav, 'content-type': 'text/plain', origin: 'http://evil.example' },
            body: '{"token":"x"}',
          })
        ).status,
      ).toBe(403);
      expect((await raw('127.0.0.1', port, '/api/world', { headers: { cookie: `hm_session=${'z'.repeat(43)}` } })).status).toBe(401);
      expect(
        (await raw('127.0.0.1', port, '/api/session', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"token":"x"}' }))
          .status,
      ).toBe(415);
    }
    await expect(signIn(tb.base)).resolves.toMatch(/^hm_session=/);
    for (let i = 0; i < 5; i++) await expect(signIn(tb.base, 'w'.repeat(43))).rejects.toThrow(/401|429/);
    await expect(signIn(tb.base)).rejects.toThrow(/429/);
    // A signed-in device keeps working while its address is blocked.
    expect((await fetch(`http://${tb.base}/api/world`, { headers: { cookie: tb.cookie } })).status).toBe(200);
  });
});

describe('Info: security headers on every response, errors included; nothing names the framework', () => {
  const must = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];

  it('bad URL, 404, 401, 413, 421, 403 all carry them', async () => {
    tb = await startBridge();
    const port = portOf(tb);
    const cases: Array<[string, Parameters<typeof raw>[3], number]> = [
      ['/%', {}, 400],
      ['/api/nope', { headers: { cookie: tb.cookie } }, 404],
      ['/api/world', {}, 401],
      ['/', { method: 'POST', headers: { 'content-length': '5000' }, body: 'x'.repeat(5000) }, 413],
      ['/', { headers: { host: 'evil.example' } }, 421],
      ['/api/world', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ];
    for (const [p, o, status] of cases) {
      const r = await raw('127.0.0.1', port, p, o);
      expect(r.status, p).toBe(status);
      for (const h of must) expect(r.headers[h], `${p} ${h}`).toBeTruthy();
      expect(r.body, p).not.toMatch(/FST_|fastify/i);
    }
  });

  it('WebSocket refusals and malformed requests carry them too', async () => {
    tb = await startBridge();
    const port = portOf(tb);
    for (const [head, code] of [
      [
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        401,
      ],
      ['GARBAGE\r\n\r\n', 400],
    ] as const) {
      let reply = '';
      await heldFor('127.0.0.1', port, 3000, (s) => {
        s.setEncoding('latin1');
        s.on('data', (d) => {
          reply += d;
        });
        s.write(head);
      });
      expect(reply).toMatch(new RegExp(`^HTTP/1\\.1 ${code}`));
      for (const h of must) expect(reply.toLowerCase(), `${code} ${h}`).toContain(`${h}:`);
      expect(reply).not.toMatch(/FST_|fastify/i);
    }
  });
});

describe('N9 (optional): HERDR_MOBILE_ALLOW_PEERS', () => {
  it('only listed peers get a connection on network listeners', async () => {
    const { ConnectionGate, peerMatcher } = await import('../src/transport/listen.js');
    const gate = new ConnectionGate({ allowPeer: peerMatcher(['100.64.1.2', '100.100.0.0/16']) });
    const sock = (remoteAddress: string) => {
      const s = new PassThrough() as unknown as net.Socket;
      Object.defineProperty(s, 'remoteAddress', { value: remoteAddress });
      return s;
    };
    expect(gate.admit(sock('100.64.1.2'), 'tailscale')).toBe(true);
    expect(gate.admit(sock('100.100.9.9'), 'tailscale')).toBe(true);
    expect(gate.admit(sock('100.64.1.3'), 'tailscale')).toBe(false);
    expect(() => loadConfig({ HOME: '/h', HERDR_MOBILE_ALLOW_PEERS: 'phone' })).toThrow(/ALLOW_PEERS/);
  });
});

describe('N10: sign-ins and new devices are logged, never a secret', () => {
  it('logs sign-in with address and device, WebSocket connect once, failures as warnings', async () => {
    const out = new PassThrough();
    let log = '';
    out.on('data', (d) => {
      log += d;
    });
    tb = await startBridge({ logLevel: 'info', logStream: out });
    const ws = new WebSocket(tb.wsUrl(), { headers: { cookie: tb.cookie } });
    await new Promise((r) => ws.on('open', r));
    ws.close();
    await expect(signIn(tb.base, 'w'.repeat(43))).rejects.toThrow(/401/);
    await until(() => log.includes('device connected') && log.includes('sign-in failed'));
    const lines = log.split('\n').filter(Boolean);
    const signedIn = lines.find((l) => l.includes('signed in: new device'));
    expect(signedIn).toBeDefined();
    expect(JSON.parse(signedIn as string)).toMatchObject({ level: 30, ip: '127.0.0.1' });
    expect(log).toContain('device connected');
    const secret = tb.cookie.split('=')[1] as string;
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(secret);
  });
});
