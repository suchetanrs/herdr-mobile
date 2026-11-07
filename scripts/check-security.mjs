// Replays SECURITY_AUDIT.md's unauthenticated probes against a running bridge and asserts its "Target state".
//
// usage: node scripts/check-security.mjs [--target http://host:port ...] [--refused host:port ...] [--no-auto-refused]
//          [--token-file path]   (or HERDR_MOBILE_TOKEN; default ~/.config/herdr-mobile/token)
//
// Every --target is probed as an unauthenticated client (app shell, health, API, WebSocket, Host names, cross-site,
// source maps, headers, CORS, time and connection limits). With a token it also signs in once (POST /api/session),
// checks the session works for HTTP and the WebSocket, and signs out again; the token itself is never printed.
// Every --refused address must refuse TCP connections; unless --no-auto-refused, so must every IPv4 address of this
// machine that isn't loopback or Tailscale (Wi-Fi, docker bridges) on each target's port.
// Exit code 0 when everything holds.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const many = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const targets = many('--target');
if (targets.length === 0) targets.push('http://127.0.0.1:8787');
const refusedArg = many('--refused');
const autoRefused = !args.includes('--no-auto-refused');
const tokenFile = many('--token-file')[0] ?? path.join(os.homedir(), '.config/herdr-mobile/token');
let token = process.env.HERDR_MOBILE_TOKEN ?? null;
if (!token) {
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    token = null;
  }
}

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(scrub(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`));
};
const scrub = (s) => (token ? String(s).split(token).join('<token>') : String(s));

const MUST_HEADERS = {
  'content-security-policy': (v) => v.includes("default-src 'self'") && v.includes("frame-ancestors 'none'"),
  'x-content-type-options': (v) => v === 'nosniff',
  'x-frame-options': (v) => v === 'DENY',
  'referrer-policy': (v) => v === 'no-referrer',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request with exactly these headers on its own connection. */
function req(base, pathname, { method = 'GET', headers = {}, body, host } = {}) {
  const u = new URL(base);
  return new Promise((resolve) => {
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: pathname,
        method,
        headers: { host: host ?? u.host, ...headers },
        agent: false,
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: -1, headers: {}, body: e.message }));
    r.end(body);
  });
}

/** Raw bytes on a fresh connection: what came back and how long until the server closed it. */
function rawExchange(base, write, { wait = 6000, onOpen } = {}) {
  const u = new URL(base);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host: u.hostname, port: Number(u.port) });
    let data = '';
    let done = false;
    const end = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      resolve({ data, ms: Date.now() - t0, closed });
    };
    s.setEncoding('latin1');
    s.on('data', (d) => {
      data += d;
    });
    s.on('connect', () => {
      if (write) s.write(write);
      onOpen?.(s);
    });
    s.on('close', () => end(true));
    s.on('error', () => end(true));
    const timer = setTimeout(() => end(false), wait);
  });
}

function wsTry(base, pathname, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${u.host}${pathname}`, { headers, handshakeTimeout: 6000 });
    ws.on('open', () => {
      resolve({ status: 101, headers: {} });
      ws.close();
    });
    ws.on('unexpected-response', (_q, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    ws.on('error', (e) => resolve({ status: -1, headers: {}, error: e.message }));
  });
}

function tcpRefused(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve('timeout');
    }, 3000);
    s.on('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve('open');
    });
    s.on('error', (e) => {
      clearTimeout(t);
      resolve(e.code === 'ECONNREFUSED' ? 'refused' : e.code);
    });
  });
}

const isLoopback = (h) => h === 'localhost' || h === '::1' || /^127\./.test(h);
const isTailscale = (h) => {
  const m = /^(\d+)\.(\d+)\./.exec(h);
  return Boolean(m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127);
};

function headersOk(res, label) {
  const bad = Object.entries(MUST_HEADERS)
    .filter(([k, ok]) => !(typeof res.headers[k] === 'string' && ok(res.headers[k])))
    .map(([k]) => k);
  const cors = Object.keys(res.headers).filter((k) => k.startsWith('access-control-'));
  check(bad.length === 0, `${label}: security headers`, bad.length ? `missing ${bad.join(', ')}` : '');
  check(cors.length === 0, `${label}: no CORS headers`, cors.join(', '));
}

function rawHeadersOk(raw, label) {
  const head = raw.split('\r\n\r\n')[0].toLowerCase();
  const bad = Object.keys(MUST_HEADERS).filter((k) => !head.includes(`\r\n${k}:`));
  check(bad.length === 0, `${label}: security headers`, bad.length ? `missing ${bad.join(', ')}` : '');
  check(!/fastify|fst_/i.test(raw), `${label}: doesn't name the framework`);
}

async function probe(base) {
  const u = new URL(base);
  const loop = isLoopback(u.hostname);
  const T = (s) => `[${u.host}] ${s}`;
  console.log(`\n== ${u.host} (${loop ? 'loopback' : isTailscale(u.hostname) ? 'Tailscale' : 'network'}) ==`);
  const all = [];
  const get = async (p, o) => {
    const r = await req(base, p, o);
    all.push([p, r]);
    return r;
  };

  // --- reachable, app shell public ---
  const index = await get('/');
  check(index.status === 200 && index.body.includes('<div id="root"'), T('GET / serves the app shell'), `HTTP ${index.status}`);
  if (index.status !== 200) return;
  check((await get('/index.html')).status === 200, T('GET /index.html'));
  const assets = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  check(assets.length > 0, T('index.html names its assets'), assets.join(' '));
  for (const a of assets) {
    const r = await get(a);
    check(r.status === 200, T(`GET ${a}`), `HTTP ${r.status}`);
    const cc = String(r.headers['cache-control'] ?? '');
    check(loop || isTailscale(u.hostname) ? true : !cc.includes('immutable'), T(`${a}: no long cache on a cleartext network`), cc);
  }
  const manifest = await get('/manifest.webmanifest');
  check(manifest.status === 200, T('GET /manifest.webmanifest'));
  for (const icon of (JSON.parse(manifest.body || '{}').icons ?? []).map((i) => i.src)) {
    check((await get(icon)).status === 200, T(`GET ${icon}`));
  }
  check((await get('/sw.js')).status === 200, T('GET /sw.js'));
  check((await get('/app/apple-touch-icon.png')).status === 200, T('GET /app/apple-touch-icon.png'));
  const js = assets.find((a) => a.endsWith('.js'));
  const main = js ? (await req(base, js)).body : '';
  const sound = /\/sounds\/[\w.-]+\.mp3/.exec(main)?.[0];
  if (sound) check((await get(sound)).status === 200, T(`GET ${sound}`));
  const iconRef = /\/icons\/[\w.-]+\.(?:svg|png)/.exec(main)?.[0];
  if (iconRef) check((await get(iconRef)).status === 200, T(`GET ${iconRef}`));

  // --- no source maps by any spelling (N4) ---
  for (const a of assets) {
    for (const p of [
      `${a}.map`,
      `${a}.map/`,
      `${a}.map//`,
      `${a}.map/.`,
      `${a}%2Emap`,
      `${a}.map%2F`,
      `${a}.MAP`,
      `${a.replace('/assets/', '/assets//')}.map`,
      `${a}/`,
    ]) {
      const r = await get(p);
      check(r.status === 404 && !r.body.includes('sourcesContent'), T(`no source map at ${p}`), `HTTP ${r.status}`);
    }
  }

  // --- health (N5) ---
  const health = await get('/api/health');
  check(health.status === 200 && health.body === '{"ok":true}', T('GET /api/health is exactly {"ok":true}'), health.body);

  // --- everything else needs a session (N2) ---
  for (const [p, o] of [
    ['/api/world', {}],
    ['/api/session', {}],
    ['/api/sessions', {}],
    ['/api/new-space', {}],
    ['/api/folders?path=~', {}],
    ['/api/spaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"folder":"~"}' }],
    [`/api/spaces/sp${'0'.repeat(32)}/sessions`, {}],
    [
      `/api/spaces/sp${'0'.repeat(32)}/tabs`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"start":{"kind":"shell"}}' },
    ],
    ['/api/sessions', { method: 'DELETE' }],
    ['/api/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"info":{}}' }],
    ['/api/nope', {}],
  ]) {
    const r = await get(p, o);
    check(r.status === 401, T(`${o.method ?? 'GET'} ${p} without a session: 401`), `HTTP ${r.status}`);
  }
  check((await get('/api/world?token=x')).status === 401, T('?token= on the API never signs in'));
  const old = await get('/?token=x');
  check(
    old.status === 302 && !old.headers['set-cookie'],
    T('an old ?token= link is only redirected away (no cookie)'),
    `HTTP ${old.status}`,
  );
  if (token) {
    check((await get(`/api/world?token=${encodeURIComponent(token)}`)).status === 401, T('the real token in ?token= is refused'));
    const viaBearer = await get('/api/world', { headers: { authorization: `Bearer ${token}` } });
    if (!loop)
      check(viaBearer.status === 401, T('the real token as a bearer header is refused over the network'), `HTTP ${viaBearer.status}`);
    else check(viaBearer.status === 200, T('the token as a bearer header works for local tools on loopback'), `HTTP ${viaBearer.status}`);
    const diagBearer = await get('/api/diag', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{"info":{}}',
    });
    check(
      diagBearer.status === 401,
      T('POST /api/diag takes a device session only (the token as a bearer: 401)'),
      `HTTP ${diagBearer.status}`,
    );
  }
  check((await wsTry(base, '/ws')).status === 401, T('WebSocket without a session: 401 before the upgrade'));
  check((await wsTry(base, '/ws?token=x')).status === 401, T('WebSocket with ?token=: 401'));
  if (token) {
    check((await wsTry(base, `/ws?token=${encodeURIComponent(token)}`)).status === 401, T('WebSocket with the real token in the URL: 401'));
    check(
      (await wsTry(base, '/ws', { authorization: `Bearer ${token}` })).status === 401,
      T('WebSocket with the token as a bearer header: 401'),
    );
  }

  // --- other sites' pages: 403, never counted (N7) ---
  check(
    (await get('/api/world', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })).status === 403,
    T('cross-site API request: 403'),
  );
  for (let i = 0; i < 3; i++) {
    const r = await get('/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
      body: '{"token":"x"}',
    });
    check(r.status === 403, T(`cross-site form POST to /api/session: 403 (${i + 1})`), `HTTP ${r.status}`);
  }
  check((await wsTry(base, '/ws', { origin: 'http://evil.example' })).status === 403, T('cross-site WebSocket: 403'));
  const pre = await get('/api/world', {
    method: 'OPTIONS',
    headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' },
  });
  check(pre.status === 403, T('CORS preflight from another origin: 403'), `HTTP ${pre.status}`);

  // --- Host names (N6) ---
  const hosts = [
    'evil.example',
    'evil.ts.net',
    'attacker.localhost',
    os.hostname(),
    `${os.hostname()}.local`,
    `${u.hostname}:1`,
    '192.0.2.10',
  ];
  if (!loop) hosts.push(`localhost:${u.port}`, `127.0.0.1:${u.port}`);
  for (const h of hosts) {
    const host = h.includes(':') ? h : `${h}:${u.port}`;
    const r = await get('/api/health', { host });
    check(r.status === 421, T(`Host ${host}: 421`), `HTTP ${r.status}`);
  }
  check((await wsTry(base, '/ws', { host: `evil.ts.net:${u.port}` })).status === 421, T('WebSocket with an unknown Host: 421'));

  // --- sign-in: wrong token is a counted failure, right token makes a session (then signed out) ---
  const wrong = await get('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"token":"not-the-token-not-the-token-not-the-tok"}',
  });
  check(wrong.status === 401, T('a wrong token at POST /api/session: 401'), `HTTP ${wrong.status}`);
  check(
    (
      await get('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '5000' },
        body: 'x'.repeat(5000),
      })
    ).status === 413,
    T('an oversized sign-in body: 413'),
  );
  if (token) {
    const ok = await get('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'check-security script' },
      body: JSON.stringify({ token }),
    });
    const set = (ok.headers['set-cookie'] ?? []).find((c) => c.startsWith('hm_session=')) ?? '';
    check(ok.status === 201, T('the token at POST /api/session: 201'), `HTTP ${ok.status}`);
    check(
      /HttpOnly/.test(set) && /SameSite=Strict/.test(set) && !set.includes(token),
      T('session cookie: HttpOnly, SameSite=Strict, not the token'),
    );
    const cookie = set.split(';')[0];
    if (cookie) {
      check((await get('/api/world', { headers: { cookie } })).status === 200, T('with the session: /api/world 200'));
      const full = await get('/api/health', { headers: { cookie } });
      check(full.body.includes('"core"'), T('with the session: full health'));
      check((await wsTry(base, '/ws', { cookie })).status === 101, T('with the session: WebSocket 101'));
      const out = await get('/api/session', { method: 'DELETE', headers: { cookie } });
      check(out.status === 200, T('signed out again'));
      check((await get('/api/world', { headers: { cookie } })).status === 401, T('the signed-out session no longer works'));
    }
  }

  // --- errors carry the headers (Info) ---
  for (const [p, r] of all) headersOk(r, T(`${r.status} ${p}`));
  const bad = await rawExchange(base, `GET /% HTTP/1.1\r\nHost: ${u.host}\r\n\r\n`, { wait: 3000 });
  check(/^HTTP\/1\.1 400/.test(bad.data), T('GET /%: 400'), bad.data.slice(0, 20));
  rawHeadersOk(bad.data, T('GET /%'));
  const garbage = await rawExchange(base, 'GARBAGE\r\n\r\n', { wait: 3000 });
  check(/^HTTP\/1\.1 400/.test(garbage.data), T('malformed request: 400'), garbage.data.slice(0, 20));
  rawHeadersOk(garbage.data, T('malformed request'));
  const wsRaw = await rawExchange(
    base,
    `GET /ws HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    { wait: 4000 },
  );
  check(/^HTTP\/1\.1 401/.test(wsRaw.data) && wsRaw.closed, T('WebSocket refusal is complete and closes'), wsRaw.data.slice(0, 20));
  rawHeadersOk(wsRaw.data, T('WebSocket 401'));

  // --- time limits (N3): silent, dripping and big-body clients ---
  const silent = await rawExchange(base, '', { wait: 20_000 });
  check(silent.closed && silent.ms <= 15_500, T('a silent connection is closed within ~10-15 s'), `${silent.ms} ms`);
  const drip = await rawExchange(base, 'GET / HTTP/1.1\r\n', {
    wait: 25_000,
    onOpen: (s) => {
      const t = setInterval(() => s.writable && s.write('X-Drip: 1\r\n'), 1000);
      s.on('close', () => clearInterval(t));
    },
  });
  check(drip.closed && drip.ms <= 15_500, T('headers dripped slowly: closed within ~10-15 s'), `${drip.ms} ms`);
  const big = await rawExchange(
    base,
    `POST /api/spaces HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/json\r\nContent-Length: 100000000\r\n\r\n`,
    {
      wait: 10_000,
      onOpen: (s) => {
        const t = setInterval(() => s.writable && s.write('x'.repeat(1024)), 100);
        s.on('close', () => clearInterval(t));
      },
    },
  );
  check(
    /^HTTP\/1\.1 413/.test(big.data) && big.closed && big.ms < 3000,
    T('declared 100 MB body without a session: 413 and closed at once'),
    `${big.data.slice(0, 12)} ${big.ms} ms`,
  );

  // --- connection cap per peer (network listeners only; this machine's own loopback isn't limited) ---
  if (!loop) {
    const socks = [];
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const s = net.connect({ host: u.hostname, port: Number(u.port) });
      s.on('error', () => {});
      s.on('close', () => refused++);
      socks.push(s);
    }
    await sleep(1000);
    const held = socks.filter((s) => !s.destroyed && s.readyState === 'open').length;
    for (const s of socks) s.destroy();
    check(held <= 32 && refused >= 8, T('at most 32 connections per peer'), `${held} held, ${refused} closed`);
    await sleep(500);
  }
}

for (const t of targets) await probe(t);

// --- nothing on the Wi-Fi, docker bridges or other networks (N1) ---
const ports = [...new Set(targets.map((t) => Number(new URL(t).port)))];
const refused = refusedArg.map((x) => {
  const i = x.lastIndexOf(':');
  return { host: x.slice(0, i), port: Number(x.slice(i + 1)) };
});
if (autoRefused) {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || isTailscale(a.address)) continue;
      for (const port of ports)
        if (!refused.some((r) => r.host === a.address && r.port === port)) refused.push({ host: a.address, port, name });
    }
  }
}
if (refused.length) console.log('\n== must refuse ==');
for (const r of refused) {
  const v = await tcpRefused(r.host, r.port);
  check(v === 'refused', `${r.host}:${r.port}${r.name ? ` (${r.name})` : ''} refuses connections`, v);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'}: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) for (const f of failed) console.log(`  failed: ${scrub(f.what)}`);
process.exit(failed.length ? 1 : 0);
