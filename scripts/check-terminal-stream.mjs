// Live end-to-end check of terminal streams, on throwaway terminals only.
// Starts its own bridge (own port, token and config dir), two WS viewers, a
// simulated desktop viewer that owns the size, then measures typing echo and
// watches cols/rows; then opens the web app at phone sizes (WebKit for iPhones
// when its libs are in .test-tmp) and checks the text is readable (>= 11 px)
// by default. Tears everything down, then exits 0 on pass.
// CHECK_BROWSER=0 skips the phones; CHECK_WEB_DIR serves another web build.
// usage: npm run build && node scripts/check-terminal-stream.mjs
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { signIn, signInLink } from './lib/session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.test-tmp');
const PORT = Number(process.env.CHECK_PORT ?? 8797);
const TOKEN = randomBytes(24).toString('hex');
let COOKIE = '';
const SOCK = `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`}/herdr-core/default.sock`;
const tag = randomBytes(3).toString('hex');
const MAIN = `hm-ts-${tag}`;
const SEEN = `hm-seen-${tag}`;
const DESK = { cols: 111, rows: 37 };
const DESK2 = { cols: 113, rows: 38 };
const ROUNDS = Number(process.env.CHECK_ROUNDS ?? 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  log(ok ? 'ok  ' : 'FAIL', what);
};
async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
const hc = (...args) => execFileSync('hc', args, { encoding: 'utf8' });

// ---- a raw herdr-core connection (sizes, labels, the simulated desktop) ----
class Core {
  constructor() {
    this.id = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
  }
  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(SOCK);
      this.s = s;
      let greeted = false;
      s.on('error', reject);
      s.on('connect', () =>
        s.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { generation: 1, framed: true } })}\n`),
      );
      s.on('data', (c) => {
        this.buf = Buffer.concat([this.buf, c]);
        if (!greeted) {
          const nl = this.buf.indexOf(10);
          if (nl < 0) return;
          greeted = true;
          this.buf = this.buf.subarray(nl + 1);
          resolve();
        }
        while (this.buf.length >= 9) {
          const len = this.buf.readUInt32LE(5);
          if (this.buf.length < 9 + len) break;
          const ch = this.buf.readUInt32LE(0);
          const kind = this.buf.readUInt8(4);
          const p = this.buf.subarray(9, 9 + len);
          this.buf = this.buf.subarray(9 + len);
          if (ch === 0) {
            const m = JSON.parse(p.toString());
            const r = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (r) m.error ? r[1](new Error(m.error.message)) : r[0](m.result);
          } else if (kind === 0) {
            const credit = Buffer.alloc(4);
            credit.writeUInt32LE(p.length);
            this.frame(ch, 1, credit);
          }
        }
      });
    });
  }
  frame(ch, kind, payload = Buffer.alloc(0)) {
    const h = Buffer.alloc(9);
    h.writeUInt32LE(ch, 0);
    h.writeUInt8(kind, 4);
    h.writeUInt32LE(payload.length, 5);
    this.s.write(Buffer.concat([h, payload]));
  }
  call(method, params) {
    return new Promise((res, rej) => {
      const id = this.id++;
      this.pending.set(id, [res, rej]);
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      this.frame(0, 0, body);
    });
  }
  async size(t) {
    const r = await this.call('terminal.get', { terminal: t });
    return { cols: r.cols, rows: r.rows };
  }
  resize(ch, { cols, rows }) {
    const b = Buffer.alloc(4);
    b.writeUInt16LE(cols, 0);
    b.writeUInt16LE(rows, 2);
    this.frame(ch, 3, b);
  }
  close() {
    this.s?.destroy();
  }
}

// ---- a bridge WS client ----
class Viewer {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.text = new Map();
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: COOKIE } });
    this.ready = new Promise((r, j) => {
      this.ws.on('open', r);
      this.ws.on('error', j);
    });
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', v: 1 })));
    this.ws.on('message', (d, binary) => {
      if (binary) {
        const s = d.readUInt32LE(0);
        this.text.set(s, (this.text.get(s) ?? '') + d.subarray(4).toString('latin1'));
        return;
      }
      this.msgs.push(JSON.parse(d.toString()));
    });
  }
  of(t) {
    return this.msgs.filter((m) => m.t === t);
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  async open(terminalId, req) {
    await this.ready;
    this.send({ t: 'term.open', req, terminalId, history: 200 });
    return until(
      () => this.of('term.opened').find((m) => m.req === req) || this.of('term.error').find((m) => m.req === req),
      5000,
      'term.opened',
    );
  }
  type(stream, s) {
    const head = Buffer.alloc(5);
    head.writeUInt32LE(stream, 0);
    this.ws.send(Buffer.concat([head, Buffer.from(s)]));
  }
  seen(stream, needle) {
    return (this.text.get(stream) ?? '').includes(needle);
  }
  close() {
    this.ws.close();
  }
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

let bridge = null;
const pidFile = path.join(TMP, 'check-bridge.pid');
const core = new Core();
const viewers = [];
const result = {};

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  // Throwaways: plain bash (no herdr.* labels), and one that carries its own herdr.seen for the seen-sync check.
  hc('run', '--bg', '--no-parent', '--no-notify', '--name', MAIN, '--', 'bash', '--norc', '--noprofile');
  hc('run', '--bg', '--no-parent', '--no-notify', '--name', SEEN, '--label', 'herdr.seen=0', '--', 'bash', '--norc', '--noprofile');
  await core.connect();
  const mainRec = await core.call('terminal.get', { terminal: MAIN });
  const seenRec = await core.call('terminal.get', { terminal: SEEN });
  const mainId = mainRec.address;
  const seenId = seenRec.address;
  log(`throwaways ${MAIN}=${mainId} ${SEEN}=${seenId}`);

  // The "desktop": a typing viewer that owns the size.
  const desk = await core.call('terminal.attach', { terminal: MAIN, cols: DESK.cols, rows: DESK.rows });
  await until(async () => {
    const s = await core.size(MAIN);
    return s.cols === DESK.cols && s.rows === DESK.rows;
  });
  const before = await core.size(MAIN);
  check(before.cols === DESK.cols && before.rows === DESK.rows, `size before = ${before.cols}x${before.rows}`);

  bridge = spawn(process.execPath, [path.join(ROOT, 'packages/server/dist/main.js')], {
    env: {
      ...process.env,
      HERDR_MOBILE_HOST: '127.0.0.1',
      HERDR_MOBILE_BIND: 'loopback',
      HERDR_MOBILE_PORT: String(PORT),
      HERDR_MOBILE_TOKEN: TOKEN,
      HERDR_MOBILE_CONFIG_DIR: path.join(TMP, 'check-cfg'),
      HERDR_MOBILE_INCLUDE_UNPLACED: '1',
      HERDR_MOBILE_LOG_LEVEL: 'warn',
      ...(process.env.CHECK_WEB_DIR ? { HERDR_MOBILE_WEB_DIR: process.env.CHECK_WEB_DIR } : {}),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  fs.writeFileSync(pidFile, String(bridge.pid));
  await until(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok;
      } catch {
        return false;
      }
    },
    10000,
    'bridge',
  );
  log(`bridge pid ${bridge.pid} on :${PORT}`);

  // Sample the size all the time while viewers are attached.
  const sizes = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      sizes.push(await core.size(MAIN));
      await sleep(25);
    }
  })();

  COOKIE = await signIn(`http://127.0.0.1:${PORT}`, TOKEN);
  const a = new Viewer('A');
  const b = new Viewer('B');
  viewers.push(a, b);
  const oa = await a.open(mainId, 1);
  const ob = await b.open(mainId, 1);
  check(oa.t === 'term.opened' && oa.cols === DESK.cols && oa.rows === DESK.rows, `A opened at ${oa.cols}x${oa.rows}`);
  check(ob.t === 'term.opened', 'B (second viewer) opened');
  const sa = oa.stream;
  const sb = ob.stream;
  await until(() => a.seen(sa, '$') && b.seen(sb, '$'), 5000, 'prompt in snapshots');

  // Typing echo, end to end: WS binary frame -> bridge -> core -> bash echo -> core -> bridge -> WS.
  const lat = [];
  for (let i = 0; i < ROUNDS; i++) {
    const tok = `q${i}k${randomBytes(3).toString('hex')}`;
    const t = performance.now();
    a.type(sa, tok);
    await until(() => a.seen(sa, tok), 2000, `echo ${tok}`);
    lat.push(performance.now() - t);
    await until(() => b.seen(sb, tok), 2000, `B sees ${tok}`);
    a.type(sa, '\x15'); // ctrl+u
    await sleep(15);
  }
  result.echoMs = { n: lat.length, p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2), max: +Math.max(...lat).toFixed(2) };
  check(
    result.echoMs.p95 < 100 && result.echoMs.max < 250,
    `echo p50 ${result.echoMs.p50} ms, p95 ${result.echoMs.p95} ms, max ${result.echoMs.max} ms`,
  );

  // Named keys and a typed command through B (the second viewer types too).
  b.send({ t: 'term.keys', req: 2, terminalId: mainId, keys: ['ctrl+u'] });
  await until(() => b.of('term.ack').some((m) => m.req === 2), 3000, 'keys ack');
  b.type(sb, 'echo HM_TYPED_$((6*7))\r');
  await until(() => a.seen(sa, 'HM_TYPED_42'), 3000, 'typed command output');
  check(true, 'B typed a command; A saw its output');

  // The desktop resizes: viewers are told, typing follows, nothing pulls it back.
  core.resize(desk.channel, DESK2);
  await until(() => a.of('term.resized').some((m) => m.cols === DESK2.cols && m.rows === DESK2.rows), 3000, 'term.resized');
  check(true, `viewers told of the desktop resize to ${DESK2.cols}x${DESK2.rows}`);
  a.type(sa, 'echo HM_AFTER_RESIZE\r');
  await until(() => b.seen(sb, 'HM_AFTER_RESIZE\r\n') || b.seen(sb, 'HM_AFTER_RESIZE\n'), 3000, 'typing after resize');
  await sleep(100);
  const afterResize = await core.size(MAIN);
  check(
    afterResize.cols === DESK2.cols && afterResize.rows === DESK2.rows,
    `size after typing post-resize = ${afterResize.cols}x${afterResize.rows}`,
  );
  core.resize(desk.channel, DESK);
  await until(() => a.of('term.resized').some((m) => m.cols === DESK.cols && m.rows === DESK.rows), 3000, 'resize back');

  // Chat send (core's terminal.send waits for ~3 s of quiet after typing).
  const ts = performance.now();
  a.send({ t: 'term.send', req: 3, terminalId: mainId, text: 'echo HM_SEND_$((40+2))' });
  await until(() => a.of('term.ack').some((m) => m.req === 3) || a.of('term.error').some((m) => m.req === 3), 15000, 'send ack');
  await until(() => a.seen(sa, 'HM_SEND_42'), 5000, 'send output');
  result.sendMs = Math.round(performance.now() - ts);
  check(true, `chat send delivered in ${result.sendMs} ms (core quiet rule)`);

  // Phones: readable text by default, the desktop's grid untouched (the size sampler keeps running).
  if (process.env.CHECK_BROWSER !== '0') {
    a.type(sa, `printf '%s HM_WIDE_END\\n' "$(printf 'w%.0s' $(seq 1 ${DESK.cols - 14}))"\r`);
    await until(() => a.seen(sa, 'HM_WIDE_END\r\n'), 3000, 'wide line');
    await browserPhase(mainId, (s) => a.type(sa, s));
  }

  // Answers are refused for a terminal that isn't blocked.
  a.send({ t: 'term.answer', req: 4, terminalId: mainId, keys: ['y'] });
  await until(() => a.of('term.error').some((m) => m.req === 4), 3000, 'answer refusal');
  check(a.of('term.error').find((m) => m.req === 4)?.code === 'not_blocked', 'quick answer refused when not blocked');

  // Close B; A stays. Then A goes too.
  b.send({ t: 'term.close', stream: sb });
  await until(() => b.of('term.closed').length === 1, 3000, 'B closed');
  a.type(sa, 'echo HM_ONE_VIEWER\r');
  await until(() => a.seen(sa, 'HM_ONE_VIEWER\r\n'), 3000, 'typing with one viewer');

  // Seen sync on its own labelled throwaway: drive a turn with OSC 7501, then look at it.
  const os = await a.open(seenId, 5);
  const ss = os.stream;
  await until(() => a.seen(ss, '$'), 5000, 'seen prompt');
  a.type(ss, "printf '\\033]7501;state=working:app=hm-check\\033\\\\'; sleep 0.3; printf '\\033]7501;state=done:app=hm-check\\033\\\\'\r");
  const rec = await until(
    async () => {
      const r = await core.call('terminal.get', { terminal: SEEN });
      return r.turn >= 1 ? r : null;
    },
    5000,
    'turn after OSC 7501',
  );
  check(rec.labels?.['herdr.seen'] === '0', `turn ${rec.turn} reached, herdr.seen still ${rec.labels?.['herdr.seen']}`);
  const tl = performance.now();
  a.send({ t: 'looking', terminalIds: [seenId] });
  const labelled = await until(
    async () => {
      const r = await core.call('terminal.get', { terminal: SEEN });
      return r.labels?.['herdr.seen'] === String(rec.turn) ? r : null;
    },
    5000,
    'herdr.seen written',
  );
  result.seenMs = Math.round(performance.now() - tl);
  check(Boolean(labelled), `herdr.seen=${rec.turn} written ${result.seenMs} ms after looking`);
  a.send({ t: 'looking', terminalIds: [] });
  const mainLabels = (await core.call('terminal.get', { terminal: MAIN })).labels ?? {};
  check(!Object.keys(mainLabels).some((k) => k.startsWith('herdr.')), 'no herdr.* label on the plain throwaway');

  a.send({ t: 'term.close', stream: sa });
  a.send({ t: 'term.close', stream: ss });
  await sleep(300);
  sampling = false;
  await sampler;
  const after = await core.size(MAIN);
  const odd = sizes.filter((s) => !((s.cols === DESK.cols && s.rows === DESK.rows) || (s.cols === DESK2.cols && s.rows === DESK2.rows)));
  result.sizeSamples = sizes.length;
  check(odd.length === 0, `${sizes.length} size samples while viewers were attached, ${odd.length} not the desktop's`);
  check(after.cols === DESK.cols && after.rows === DESK.rows, `size after = ${after.cols}x${after.rows}`);
  core.frame(desk.channel, 2);
}

/** Opens the throwaway's agent screen at phone sizes and measures what a person sees. */
async function browserPhase(mainId, typeIn) {
  const { chromium, webkit } = await import('playwright');
  const libDir = path.join(ROOT, '.test-tmp/webkit-libs/root/usr/lib/x86_64-linux-gnu');
  const libs = ['libyuv.so.0', 'libgav1.so.1', 'libavif.so.16'].map((f) => path.join(libDir, f));
  const haveWebkit = libs.every((f) => fs.existsSync(f));
  if (haveWebkit) process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
  const browsers = {};
  const launch = async (engine) => {
    browsers[engine] ??=
      engine === 'webkit'
        ? await webkit.launch({ env: { ...process.env, LD_PRELOAD: libs.join(':') } })
        : await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    return browsers[engine];
  };
  const phones = [
    { name: 'iPhone SE', engine: 'webkit', width: 375, height: 667, dpr: 2, portrait: true },
    { name: 'iPhone 15', engine: 'webkit', width: 393, height: 852, dpr: 3, portrait: true },
    { name: 'Pixel 7', engine: 'chromium', width: 412, height: 915, dpr: 2.625, portrait: true },
    { name: 'iPhone 15 sideways', engine: 'webkit', width: 852, height: 393, dpr: 3, portrait: false },
  ].map((p) => (p.engine === 'webkit' && !haveWebkit ? { ...p, engine: 'chromium' } : p));
  const measure = () => {
    const rows = document.querySelector('.xterm-rows');
    const host = document.querySelector('.term-host');
    const screen = document.querySelector('.xterm-screen');
    // The prompt (cursor line) is the last line with text: in view, and the view at the line's start.
    const lines = [...document.querySelectorAll('.xterm-rows > div')].filter((d) => d.textContent?.trim());
    const prompt = lines.at(-1);
    const hr = host?.getBoundingClientRect();
    const cr = prompt?.getBoundingClientRect();
    return {
      font: rows ? Number.parseFloat(getComputedStyle(rows).fontSize) : 0,
      gridW: screen?.getBoundingClientRect().width ?? 0,
      hostW: host?.clientWidth ?? 0,
      pans: host ? host.scrollWidth > host.clientWidth + 1 : false,
      cursorInView: Boolean(hr && cr && host && host.scrollLeft === 0 && cr.top >= hr.top - 1 && cr.bottom <= hr.bottom + 1),
      gapAbove: host && screen ? Math.round(screen.getBoundingClientRect().top - host.getBoundingClientRect().top) : -1,
    };
  };
  try {
    for (const p of phones) {
      const b = await launch(p.engine);
      const ctx = await b.newContext({
        viewport: { width: p.width, height: p.height },
        deviceScaleFactor: p.dpr,
        hasTouch: true,
        ...(p.engine === 'chromium' ? { isMobile: true } : {}),
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(signInLink(`http://127.0.0.1:${PORT}`, TOKEN, `#/a/${encodeURIComponent(mainId)}/terminal`));
      await page.waitForSelector('.xterm-rows', { timeout: 15000 });
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('HM_WIDE_END'), null, {
        timeout: 8000,
      });
      await page.waitForTimeout(600);
      const m = await page.evaluate(measure);
      check(m.font >= 11, `${p.name} (${p.engine}): terminal text ${m.font} px by default`);
      check(m.gapAbove >= 0 && m.gapAbove <= 12, `${p.name}: grid at the top (${m.gapAbove} px below the tools)`);
      if (p.portrait)
        check(m.pans && m.cursorInView, `${p.name}: pans sideways (grid ${Math.round(m.gridW)} px in ${m.hostW}), cursor line in view`);
      if (p.portrait) {
        // Typing far to the right (from the other viewer, as if on the desktop): the view follows the cursor.
        const scrollLeft = () => page.evaluate(() => document.querySelector('.term-host')?.scrollLeft ?? -1);
        typeIn(`echo ${'x'.repeat(DESK.cols - 20)}`);
        const right = await until(async () => ((await scrollLeft()) > 100 ? scrollLeft() : null), 4000, 'follow right').catch(() => 0);
        typeIn('\x15');
        const back = await until(async () => ((await scrollLeft()) === 0 ? 'ok' : null), 4000, 'follow back').catch(() => null);
        check(right > 100 && back === 'ok', `${p.name}: follows the cursor sideways (to ${Math.round(right)} px and back)`);
      }
      // Fit from the text size menu: the whole width, smaller; then Auto again.
      await page.locator('.zoom-btn').click();
      await page.locator('.menu-item', { hasText: 'Fit' }).click();
      await page.waitForTimeout(400);
      const fit = await page.evaluate(measure);
      check(fit.gridW <= fit.hostW + 1 && !fit.pans, `${p.name}: Fit shows the whole width at ${fit.font} px`);
      await page.locator('.zoom-btn').click();
      await page.locator('.menu-item', { hasText: 'Auto' }).click();
      await page.waitForTimeout(400);
      check((await page.evaluate(measure)).font >= 11, `${p.name}: back to readable`);
      check(errors.length === 0, `${p.name}: no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
      await ctx.close();
      const s = await core.size(MAIN);
      check(s.cols === DESK.cols && s.rows === DESK.rows, `${p.name}: desktop size still ${s.cols}x${s.rows}`);
    }
  } finally {
    for (const b of Object.values(browsers)) await b.close();
  }
}

async function teardown() {
  for (const v of viewers) v.close();
  if (bridge && bridge.exitCode === null) {
    const exited = new Promise((r) => bridge.once('exit', r));
    process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
    await Promise.race([exited, sleep(3000)]);
  }
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(path.join(TMP, 'check-cfg'), { recursive: true, force: true });
  core.close();
  for (const n of [MAIN, SEEN]) {
    try {
      hc('kill', n);
    } catch {}
    await sleep(200);
    try {
      hc('rm', n);
    } catch {}
  }
  const left = hc('ls', '--all', '--json');
  check(!left.includes(MAIN) && !left.includes(SEEN), 'throwaways killed and removed');
}

let crashed = null;
try {
  await main();
} catch (err) {
  crashed = err;
  failures.push(`crashed: ${err.message}`);
  log('FAIL', err.stack);
}
await teardown();
console.log(JSON.stringify({ pass: failures.length === 0, ...result, failures }));
process.exit(failures.length === 0 && !crashed ? 0 : 1);
