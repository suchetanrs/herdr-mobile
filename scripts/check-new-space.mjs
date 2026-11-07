// Live check of "New space" against the real Herdr window, then a full clean-up.
// Starts its own bridge on 127.0.0.1:8788 (seen sync off), makes spaces through the web UI (Chromium, phone
// size), checks each shows in the app and in `herdr-app ls` the way a desktop-made one does (appended last,
// its folder, Herdr's tab "1", the core's labels), then ends the terminal so Herdr closes the space, removes
// it, and checks `herdr-app ls` is back to what it was.
// usage: npm run build && node scripts/check-new-space.mjs [unnamed|named|both]   (default unnamed: one shell, Herdr's name)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(REPO, '.test-tmp/new-space');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `ns-check-${'x'.repeat(40)}`;
const HOME = os.homedir();
const which = process.argv[2] ?? 'unnamed';
// This checkout and its parent folder, as ~/... (both must be inside the home folder).
const inHome = (p) => `~/${path.relative(HOME, p)}`;
const cases = [
  { folder: inHome(REPO), name: '' },
  { folder: inHome(path.dirname(REPO)), name: 'hm-new-space-check' },
].filter((_, i) => which === 'both' || (which === 'named' ? i === 1 : i === 0));

const hc = (...a) => execFileSync('hc', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ls = () => JSON.parse(execFileSync('herdr-app', ['ls'], { encoding: 'utf8' })).spaces;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(100);
  }
};
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` ${detail}` : ''}`);
};

fs.mkdirSync(WORK, { recursive: true });
const before = ls();
const beforeIds = before.map((s) => s.id);
console.log(`before: ${before.length} spaces: ${before.map((s) => s.name).join(', ')}`);

const log = fs.openSync(path.join(WORK, 'bridge.log'), 'w');
const bridge = spawn(process.execPath, [path.join(REPO, 'packages/server/dist/main.js')], {
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
const made = [];
let browser;
try {
  check(Boolean(await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok)), 'bridge up on :8788');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/#token=${TOKEN}`);
  await page.locator('.conn.conn-ok').first().waitFor({ state: 'attached', timeout: 15000 });
  for (const c of cases) {
    const t0 = Date.now();
    await page.locator('.topbar').getByRole('button', { name: 'New space' }).click();
    const form = page.locator('.ns-page');
    await form.getByRole('button', { name: /Terminal/ }).waitFor();
    await form.getByLabel('Folder', { exact: true }).fill(c.folder);
    if (c.name) await form.getByLabel('Name', { exact: true }).fill(c.name);
    const reply = page.waitForResponse((r) => r.url().endsWith('/api/spaces') && r.request().method() === 'POST', { timeout: 30000 });
    await form.getByRole('button', { name: 'Create space' }).click();
    const res = await reply;
    const body = await res.json();
    check(res.status() === 200, 'POST /api/spaces', JSON.stringify(body));
    if (res.status() !== 200) continue;
    made.push(body);
    await page.waitForURL(new RegExp(`#/s/${body.spaceId}$`), { timeout: 15000 });
    check(true, 'web UI opened the new space', `${Date.now() - t0} ms after tapping Create`);
    const after = ls();
    const sp = after.at(-1);
    const expectName = c.name || null;
    check(sp?.id === body.spaceId, 'herdr-app ls: appended last like space.new', sp?.id);
    check(sp?.folder === path.join(HOME, c.folder.slice(2)), 'herdr-app ls: folder', sp?.folder);
    const shownName = await until(() => {
      const s = ls().find((x) => x.id === body.spaceId);
      return s && (expectName === null || s.name === expectName) ? s.name : null;
    }, 5000);
    check(shownName !== null, 'herdr-app ls: name', `${JSON.stringify(shownName)}${expectName ? '' : ' (Herdr’s automatic name)'}`);
    check(sp?.tabs.length === 1 && sp.tabs[0].id === body.tabId && sp.tabs[0].name === '1', 'herdr-app ls: one tab "1" with our tab id');
    check(sp?.tabs[0].terminals[0]?.terminal === body.terminalId, 'herdr-app ls: its terminal', body.terminalId);
    const rec = JSON.parse(hc('get', body.terminalId, '--json'));
    check(
      rec.labels['herdr.space'] === body.spaceId &&
        rec.labels['herdr.tab'] === body.tabId &&
        rec.labels['herdr.seen'] === '0' &&
        rec.keep === true,
      'core: labels + keep like herdr-app spawn',
      JSON.stringify({ labels: rec.labels, keep: rec.keep, argv: rec.argv, size: `${rec.cols}x${rec.rows}` }),
    );
    const heading = await page.locator('.topbar-title').first().textContent();
    const world = await (await fetch(`${BASE}/api/world`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    const appName = world.world.spaces[body.spaceId]?.name;
    check(appName === ls().find((x) => x.id === body.spaceId)?.name, 'web app name = herdr-app name', `${appName} / title "${heading}"`);
    await page.goto(`${BASE}/#/`);
  }
  // Rate limit: a 7th within 10 minutes is refused (not exercised live: it would make spaces).
} finally {
  for (const m of made) {
    try {
      hc('kill', m.terminalId);
    } catch (e) {
      console.log(`kill ${m.terminalId}: ${e.message}`);
    }
    const closed = await until(() => !ls().some((s) => s.id === m.spaceId), 15000);
    check(Boolean(closed), `Herdr closed the space after its terminal ended`, m.spaceId);
    try {
      hc('rm', m.terminalId);
    } catch (e) {
      console.log(`rm ${m.terminalId}: ${e.message.split('\n')[0]}`);
    }
  }
  await browser?.close();
  bridge.kill('SIGTERM');
  await until(() => bridge.exitCode !== null || bridge.signalCode !== null, 8000);
  const afterIds = ls().map((s) => s.id);
  check(JSON.stringify(afterIds) === JSON.stringify(beforeIds), 'herdr-app ls back to before', `${afterIds.length} spaces`);
  for (const m of made) {
    let gone = false;
    try {
      hc('get', m.terminalId, '--json');
    } catch {
      gone = true;
    }
    check(gone, `terminal ${m.terminalId} removed from the core`);
  }
  const recent = JSON.parse(fs.readFileSync(path.join(HOME, '.config/herdr-app/view.json'), 'utf8')).recent ?? [];
  console.log(`Herdr's recent list now: ${JSON.stringify(recent)}`);
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exitCode = failed ? 1 : 0;
}
