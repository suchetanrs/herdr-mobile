// Live check of a space's Files icon against the real Herdr window, on iPhone 15 (WebKit), Pixel 7 and desktop
// Chrome, then a full clean-up. Makes a throwaway git repo under .test-tmp/space-files (a .gitignore, an
// info/exclude entry, a tracked file that matches an ignore pattern), a throwaway space there (shell, POST
// /api/spaces: Herdr adopts it) through a private bridge on 127.0.0.1:8788 (seen sync off), then per device:
// space screen -> folder icon -> Files at the space's folder, ignored entries dimmed and tracked ones not,
// into an ignored folder, back to the space; the device's remembered folder is left alone. Ends the space's
// terminal so Herdr closes the space, removes it, and checks `herdr-app ls` is back to what it was.
// usage: npm run build && node scripts/check-space-files.mjs [iphone,android,desktop]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(REPO, '.test-tmp/space-files');
const SHOTS = process.env.SHOTS ?? path.join(WORK, 'shots');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `sf-check-${'z'.repeat(40)}`;
const which = process.argv[2] ?? 'iphone,android,desktop';
const FOLDER = path.join(WORK, 'repo');

const hc = (...a) => execFileSync('hc', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hcGet = (t) => JSON.parse(hc('get', t, '--json'));
const ls = () => JSON.parse(execFileSync('herdr-app', ['ls'], { encoding: 'utf8' })).spaces;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(150);
  }
};
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` ${detail}` : ''}`);
  return ok;
};
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  return { status: r.status, body: await r.json() };
};

function makeRepo() {
  fs.rmSync(FOLDER, { recursive: true, force: true });
  fs.mkdirSync(path.join(FOLDER, 'build', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(FOLDER, 'src'));
  const git = (...a) => execFileSync('git', ['-C', FOLDER, ...a], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(FOLDER, '.gitignore'), 'build/\n*.log\n');
  fs.appendFileSync(path.join(FOLDER, '.git', 'info', 'exclude'), 'mine.txt\n');
  for (const f of ['build/deep/out.txt', 'debug.log', 'tracked.log', 'mine.txt', 'README.md', 'src/app.ts'])
    fs.writeFileSync(path.join(FOLDER, f), 'x\n');
  git('add', '-f', 'tracked.log', 'README.md');
}

function webkitEnv() {
  const lib = path.join(REPO, '.test-tmp/webkit-libs/root/usr/lib/x86_64-linux-gnu');
  const libs = ['libyuv.so.0', 'libgav1.so.1', 'libavif.so.16'].map((f) => path.join(lib, f));
  if (!libs.every((f) => fs.existsSync(f))) return undefined;
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
  return { ...process.env, LD_PRELOAD: libs.join(':') };
}
const swiftshader = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const DEVICES = {
  iphone: async () => ({
    browser: await webkit.launch({ env: webkitEnv() }),
    ctx: (({ defaultBrowserType, ...d }) => d)(devices['iPhone 15']),
  }),
  android: async () => ({ browser: await chromium.launch({ args: swiftshader }), ctx: devices['Pixel 7'] }),
  desktop: async () => ({ browser: await chromium.launch({ args: swiftshader }), ctx: { viewport: { width: 1440, height: 900 } } }),
};

let bridge = null;
async function startBridge() {
  const log = fs.openSync(path.join(WORK, 'bridge.log'), 'w');
  bridge = spawn(process.execPath, [path.join(REPO, 'packages/server/dist/main.js')], {
    cwd: REPO,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      HERDR_MOBILE_HOST: '127.0.0.1',
      HERDR_MOBILE_BIND: 'loopback',
      HERDR_MOBILE_PORT: String(PORT),
      HERDR_MOBILE_CONFIG_DIR: path.join(WORK, 'cfg'),
      HERDR_MOBILE_TOKEN: TOKEN,
      HERDR_MOBILE_SEEN_SYNC: '0',
    },
  });
  return check(Boolean(await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok)), `bridge up on :${PORT}`);
}
async function stopBridge() {
  if (!bridge) return;
  const b = bridge;
  bridge = null;
  b.kill('SIGTERM');
  await until(() => b.exitCode !== null || b.signalCode !== null, 8000);
}

async function end(t) {
  try {
    hc('kill', t);
  } catch (e) {
    console.log(`kill ${t}: ${e.message.split('\n')[0]}`);
  }
  await until(() => {
    try {
      return hcGet(t).state !== 'live';
    } catch {
      return true;
    }
  }, 8000);
  try {
    hc('rm', t);
  } catch (e) {
    console.log(`rm ${t}: ${e.message.split('\n')[0]}`);
  }
}

const row = (page, name) =>
  page
    .locator('.fs-row')
    .filter({ has: page.locator('.fs-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const dimmed = async (page, name) => ((await row(page, name).getAttribute('class')) ?? '').includes('fs-ignored');

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
makeRepo();
const before = ls();
const beforeIds = before.map((s) => s.id);
console.log(`before: ${before.length} spaces`);
let spaceId = null;
let baseTerminal = null;
let browser;
try {
  await startBridge();
  const made = await api('/api/spaces', { method: 'POST', body: JSON.stringify({ folder: FOLDER, start: { kind: 'shell' } }) });
  check(made.status === 200, 'throwaway space made (POST /api/spaces, shell)', String(made.status));
  if (made.status !== 200) throw new Error('no space');
  spaceId = made.body.spaceId;
  baseTerminal = made.body.terminalId;
  const tilde = `~/${path.relative(process.env.HOME, FOLDER)}`;

  for (const name of which.split(',')) {
    console.log(`--- ${name}`);
    const dev = await DEVICES[name]();
    browser = dev.browser;
    const page = await browser.newPage(dev.ctx);
    const errors = [];
    page.on('pageerror', (e) => {
      if (!/ResizeObserver loop/.test(e.message)) errors.push(e.message);
    });
    await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}&/s/${encodeURIComponent(spaceId)}`);
    await page.waitForURL(new RegExp(`#/s/${spaceId}$`), { timeout: 15000 });
    await page.evaluate(() => localStorage.setItem('hm.files.dir', JSON.stringify('/')));
    const scope = name === 'desktop' ? page.locator('.tabbar') : page.locator('.topbar');
    const icon = scope.getByRole('button', { name: 'Files in this space' });
    await icon.waitFor({ timeout: 15000 });
    const box = await icon.boundingBox();
    if (name !== 'desktop')
      check(box && box.width >= 44 && box.height >= 44, 'file icon is a 44 px target', `${box?.width}x${box?.height}`);
    await icon.click();
    check(Boolean(await until(() => page.url().endsWith(`#/s/${spaceId}/files`), 5000)), 'icon -> #/s/<space>/files');
    await row(page, 'README.md').waitFor({ timeout: 10000 });
    check((await page.getByLabel('Path', { exact: true }).inputValue()) === tilde, 'opened at the space folder', tilde);
    const ign = ['build', 'debug.log', 'mine.txt'];
    const kept = ['src', 'README.md', 'tracked.log'];
    const dims = await Promise.all(ign.map((n) => dimmed(page, n)));
    const notDims = await Promise.all(kept.map((n) => dimmed(page, n)));
    check(dims.every(Boolean), 'ignored entries dimmed (.gitignore dir + pattern, info/exclude)', dims.join(','));
    check(
      notDims.every((d) => !d),
      'tracked / not ignored entries not dimmed (tracked.log matches *.log)',
      notDims.join(','),
    );
    const color = (n) =>
      row(page, n)
        .locator('.fs-name')
        .evaluate((el) => getComputedStyle(el).color);
    const [c1, c2] = [await color('debug.log'), await color('README.md')];
    check(c1 !== c2, 'dimmed colour differs', `${c1} vs ${c2}`);
    await page.screenshot({ path: path.join(SHOTS, `spacefiles-${name}-folder.png`) });
    await row(page, 'build').click();
    await row(page, 'deep').waitFor({ timeout: 10000 });
    check(await dimmed(page, 'deep'), 'inside the ignored folder: dimmed, and it opened');
    await row(page, 'deep').click();
    await row(page, 'out.txt').waitFor({ timeout: 10000 });
    check(await dimmed(page, 'out.txt'), 'two levels in: still dimmed');
    if (name === 'desktop') await page.goBack();
    else await page.getByRole('button', { name: 'Back' }).click();
    check(Boolean(await until(() => page.url().endsWith(`#/s/${spaceId}`), 5000)), 'back returns to the space', page.url().split('#')[1]);
    check(
      (await page.evaluate(() => localStorage.getItem('hm.files.dir'))) === JSON.stringify('/'),
      "device's last folder (Spaces folder icon) untouched",
    );
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await browser.close();
    browser = null;
  }
} catch (e) {
  check(false, 'run', e.stack);
} finally {
  await browser?.close().catch(() => {});
  await stopBridge();
  if (baseTerminal) {
    await end(baseTerminal);
    check(Boolean(await until(() => !ls().some((s) => s.id === spaceId), 15000)), 'Herdr closed the throwaway space', spaceId);
  }
  const afterIds = ls().map((s) => s.id);
  check(JSON.stringify(afterIds) === JSON.stringify(beforeIds), 'herdr-app ls back to before', `${afterIds.length} spaces`);
  if (baseTerminal) {
    let gone = false;
    try {
      hcGet(baseTerminal);
    } catch {
      gone = true;
    }
    check(gone, 'its terminal is gone from the core');
  }
  fs.rmSync(FOLDER, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exitCode = failed ? 1 : 0;
}
