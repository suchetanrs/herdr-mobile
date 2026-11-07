// Live check of the web app against a running bridge (HERDR_MOBILE_INCLUDE_UNPLACED=1) using throwaway
// terminals only: live add/remove, status changes, one-tap answer, composer send + echo, quick keys, desktop
// typing, and that the terminals' size never changes.
// usage: node scripts/check-web.mjs <screens-dir> [base-url]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const out = path.resolve(process.argv[2] ?? '.test-tmp/screens');
const base = process.argv[3] ?? 'http://127.0.0.1:8787';
const token = process.env.HERDR_MOBILE_TOKEN ?? fs.readFileSync(path.join(os.homedir(), '.config/herdr-mobile/token'), 'utf8').trim();
const tw = path.resolve('.test-tmp/tw');
fs.mkdirSync(out, { recursive: true });

const hc = (...args) => execFileSync('hc', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hcJson = (...args) => JSON.parse(hc(...args, '--json'));
const results = [];
const ok = (name, detail = '') => {
  results.push({ name, ok: true, detail });
  console.log(`PASS ${name} ${detail}`);
};
const fail = (name, detail = '') => {
  results.push({ name, ok: false, detail });
  console.log(`FAIL ${name} ${detail}`);
};
const until = async (fn, ms = 10000, step = 25) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};
const byName = (name) => hcJson('ls').terminals.find((t) => t.name === name);
const size = (addr) => {
  const t = hcJson('get', addr);
  return `${t.cols}x${t.rows}`;
};
const screenText = (addr) => hcJson('read', addr).text;
const spawned = [];
const spawn = (name, argv, env = {}) => {
  const envArgs = Object.entries(env).flatMap(([k, v]) => [`${k}=${v}`]);
  const r = hcJson(
    'run',
    '--bg',
    '--no-parent',
    '--no-notify',
    '--name',
    name,
    '--cwd',
    tw,
    '--',
    ...(envArgs.length ? ['env', ...envArgs] : []),
    ...argv,
  );
  spawned.push(r.address);
  return r.address;
};
const remove = (addr) => {
  try {
    hc('kill', addr);
  } catch {}
  try {
    hc('rm', addr);
  } catch {}
};

let ui1 = byName('hm-ui1')?.address;
if (!ui1) ui1 = spawn('hm-ui1', ['bash', '--norc', '-i']);
const ui1Size = size(ui1);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // ---------- phone ----------
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail('page error', e.message));
  await page.goto(`${base}/#token=${encodeURIComponent(token)}`);
  await page.waitForSelector('.screen');
  ok('signs in with #token= and strips it', page.url().includes('token=') ? 'token still in URL' : page.url());
  if (page.url().includes('token=')) fail('token stripped');
  await page.waitForSelector('text=Not in a space');

  // Live: a new agent appears without a reload, and its status moves it.
  const t0 = Date.now();
  const ui2 = spawn('hm-ui2', [path.join(tw, 'agent.sh')], { WORK: '5' });
  const appeared = await until(() => page.locator('.agent-line', { hasText: 'hm-ui2' }).count(), 8000);
  appeared ? ok('new agent appears live', `${Date.now() - t0} ms`) : fail('new agent appears live');
  const working = await until(
    async () =>
      (await page
        .locator('section', { has: page.locator('h2', { hasText: 'Working' }) })
        .locator('text=Not in a space')
        .count()) > 0,
    8000,
  );
  working ? ok('space filed under Working') : fail('space filed under Working');
  await page.screenshot({ path: path.join(out, 'live-iphone-spaces-working.png') });
  const blocked = await until(
    async () =>
      (await page
        .locator('section', { has: page.locator('h2', { hasText: 'Needs you' }) })
        .locator('text=hm-ui2')
        .count()) > 0,
    12000,
    5,
  );
  // From the core's own timestamp of the change to the row moving on the page (same clock, 5 ms poll).
  const shownAt = Date.now();
  const statusMs = hcJson('get', ui2).status_ms;
  blocked
    ? ok('status change shows live (Needs you)', `${shownAt - statusMs} ms after the core saw it`)
    : fail('status change shows live (Needs you)');
  await page.screenshot({ path: path.join(out, 'live-iphone-spaces-blocked.png') });

  // One-tap answer from the agent screen.
  await page.locator('.agent-line', { hasText: 'hm-ui2' }).first().tap();
  await page.waitForSelector('.approve');
  const labels =
    (await until(async () => {
      const l = await page.locator('.approve-btn .approve-label').allTextContents();
      return l.some((x) => x.startsWith('No, and tell')) ? l : null;
    }, 3000)) ?? (await page.locator('.approve-btn .approve-label').allTextContents());
  labels.some((l) => l.startsWith('No, and tell'))
    ? ok('approve bar reads the menu', JSON.stringify(labels))
    : fail('approve bar reads the menu', JSON.stringify(labels));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'live-iphone-agent-blocked.png') });
  await page.locator('.approve-btn', { hasText: 'Yes' }).first().tap();
  const answered = await until(() => screenText(ui2).includes('answered: [1]'), 5000);
  answered ? ok('one-tap answer reached the agent') : fail('one-tap answer reached the agent', screenText(ui2).slice(-200));
  const gone = await until(async () => (await page.locator('.approve').count()) === 0, 5000);
  gone ? ok('approve bar leaves once answered') : fail('approve bar leaves once answered');

  // Composer send on the shell: echo shows in the page's terminal.
  await page.evaluate((id) => {
    window.location.hash = `#/a/${encodeURIComponent(id)}`;
  }, ui1);
  await page.waitForSelector('.xterm-rows');
  await page.waitForTimeout(500);
  const marker = `HMWEB${Date.now() % 100000}`;
  await page.locator('.composer-input').fill(`echo ${marker.slice(0, 5)}$((${marker.slice(5)}+0))`);
  const sentAt = Date.now();
  await page.locator('.send-btn').tap();
  const echoed = await until(async () => (await page.locator('.xterm-rows').textContent())?.includes(marker), 6000, 5);
  echoed
    ? ok('composer send echoes in the page terminal', `${Date.now() - sentAt} ms`)
    : fail('composer send echoes', (await page.locator('.xterm-rows').textContent())?.slice(-300));
  // Draft cleared; quick keys: start a sleep, ^C it.
  await page.locator('.composer-input').fill('sleep 30');
  await page.locator('.send-btn').tap();
  await page.waitForTimeout(400);
  await page.locator('.key', { hasText: '^C' }).dispatchEvent('pointerdown');
  const interrupted = await until(() => /sleep 30\s*\n?\^C/.test(screenText(ui1)), 4000);
  interrupted ? ok('quick key ^C interrupts') : fail('quick key ^C', screenText(ui1).slice(-200));
  // Sticky ctrl + "l" typed in the composer clears the screen (ctrl+l).
  await page.locator('.key-mod').tap();
  await page.locator('.composer-input').focus();
  await page.keyboard.type('l');
  const cleared = await until(() => !screenText(ui1).includes(marker), 4000);
  cleared ? ok('sticky ctrl + typed key (ctrl+l)') : fail('sticky ctrl + typed key (ctrl+l)');
  const composerEmpty = (await page.locator('.composer-input').inputValue()) === '';
  composerEmpty ? ok('ctrl key not inserted into the draft') : fail('ctrl key not inserted into the draft');
  await page.screenshot({ path: path.join(out, 'live-iphone-agent-shell.png') });

  // Swipe to the next agent of the (made-up) space.
  const before = page.url();
  const bar = await page.locator('.agent-bar').boundingBox();
  if (bar) {
    await page.evaluate(
      ({ y }) => {
        const el = document.querySelector('.agent-bar');
        const mk = (type, x) =>
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
            touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
          });
        el.dispatchEvent(mk('touchstart', 320));
        el.dispatchEvent(mk('touchend', 120));
      },
      { y: bar.y + bar.height / 2 },
    );
  }
  const swiped = await until(() => page.url() !== before, 2000);
  swiped ? ok('swipe goes to the next agent', page.url().split('#')[1]) : fail('swipe goes to the next agent');

  // Alerts: paneless throwaways never alert (Herdr's rule), so check the in-page path with the inbox's test alert.
  await page.evaluate(() => {
    window.location.hash = '#/alerts';
  });
  await page.locator('button', { hasText: 'Test alert' }).tap();
  const toast = await until(() => page.locator('.toast', { hasText: 'This is how an alert looks' }).count(), 3000);
  toast ? ok('in-page alert toast (test alert)') : fail('in-page alert toast (test alert)');
  const title = await page.title();
  await page.screenshot({ path: path.join(out, 'live-iphone-alerts-toast.png') });
  ok('title badge', JSON.stringify(title));

  // Removed agent disappears without a reload.
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  remove(ui2);
  const removed = await until(
    async () =>
      (await page.locator('.agent-line', { hasText: 'hm-ui2' }).count()) === 0 && (await page.locator('text=hm-ui2').count()) === 0,
    8000,
  );
  removed ? ok('removed agent disappears live') : fail('removed agent disappears live');
  await ctx.close();

  // ---------- android ----------
  const actx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  const apage = await actx.newPage();
  await apage.goto(`${base}/#token=${encodeURIComponent(token)}&/a/${encodeURIComponent(ui1)}`);
  await apage.waitForSelector('.xterm-rows');
  await apage.locator('.composer-input').fill('echo ANDROID$((40+2))');
  await apage.locator('.send-btn').tap();
  const aecho = await until(async () => (await apage.locator('.xterm-rows').textContent())?.includes('ANDROID42'), 6000, 5);
  aecho ? ok('android: composer send echoes') : fail('android: composer send echoes');
  await apage.screenshot({ path: path.join(out, 'live-android-agent-shell.png') });
  await actx.close();

  // ---------- desktop: typing straight into the terminal ----------
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const dpage = await dctx.newPage();
  await dpage.goto(`${base}/#token=${encodeURIComponent(token)}&/a/${encodeURIComponent(ui1)}`);
  await dpage.waitForSelector('.pane-card .xterm');
  await dpage.waitForTimeout(500);
  await dpage.locator('.pane-card .xterm').click();
  const typedAt = Date.now();
  await dpage.keyboard.type('echo DESK$((20+22))');
  await dpage.keyboard.press('Enter');
  const decho = await until(() => screenText(ui1).includes('DESK42'), 5000, 5);
  decho
    ? ok('desktop: typing in the terminal reaches it', `${Date.now() - typedAt} ms incl. typing`)
    : fail('desktop: typing in the terminal');
  await dpage.screenshot({ path: path.join(out, 'live-desktop-agent-shell.png') });
  await dctx.close();
} finally {
  await browser.close();
  const after = size(ui1);
  after === ui1Size ? ok('terminal size never changed', after) : fail('terminal size never changed', `${ui1Size} -> ${after}`);
  for (const a of spawned) remove(a);
  if (process.env.KEEP_UI1 !== '1') remove(ui1);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
