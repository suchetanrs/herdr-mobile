// Live check of Claude Code questions in the web app, with a real `claude` (cheapest model) in a throwaway terminal.
// Per device (iPhone 15 on WebKit, Pixel 7, desktop): starts `claude --model haiku` asking one AskUserQuestion with
// three questions, then through the web app (a private bridge on 127.0.0.1:8788, seen sync off, built web dir):
//   Q1 (single, long question)  Conversation: full question + descriptions, white = first; Terminal: no answer card,
//                               quick-key arrows to "Type something", typed through the composer, lands in the field
//                               (not submitted), quick-key Enter picks it.
//   Q2 (multi-select)           Conversation: tick two, "Type something" with a custom answer, Next.
//   Q3 (single)                 Conversation: pick the 2nd; step back to it: white = the checked one; then Submit.
// and reads Claude's transcript (tool_result) for the answers. Kills and removes the terminal after each device.
// usage: npm run build (or a web build in CHECK_WEB_DIR) && node scripts/check-question.mjs [iphone|android|desktop ...]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(REPO, '.test-tmp/question');
const RUNS = process.env.CHECK_RUNS_DIR ?? path.join(REPO, '.test-tmp/q-runs');
const SHOTS = process.env.CHECK_SHOTS_DIR ?? path.join(REPO, '.test-tmp/screens');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `q-check-${'q'.repeat(40)}`;
const which = process.argv.slice(2).length ? process.argv.slice(2) : ['iphone', 'android', 'desktop'];

const Q1 =
  'Which database should the new inventory service use for its primary store, considering that we need strong consistency for stock counts, cheap horizontal reads for the catalog pages, and a migration path from the existing MySQL 5.7 cluster?';
const PROMPT = `Call the AskUserQuestion tool exactly once, right now, with exactly these 3 questions and nothing else. Q1 header "Database", multiSelect false, question "${Q1}", options "PostgreSQL" (description "Strong consistency and rich SQL; the team knows it well"), "CockroachDB" (description "Distributed SQL; more moving parts"), "Keep MySQL" (description "Upgrade to 8.0 in place"). Q2 header "Features", multiSelect true, question "Which features should the first release include?", options "Search" (description "Full-text search over items"), "Barcode scan" (description "Scan items with the phone camera"), "CSV export" (description "Download stock as a spreadsheet"). Q3 header "Name", multiSelect false, question "What should the service be called?", options "stockd" (description "Short and unix-y"), "inventory-api" (description "Says what it is"). After the answer, reply with just the word OK.`;

const hc = (...a) => execFileSync('hc', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hcJson = (cmd, ...a) => JSON.parse(hc(cmd, '--json', ...a));
const screen = (addr) => hcJson('read', addr).text;
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
  return ok;
};
/** The bottom block of the terminal (from the tab bar down). */
const block = (addr) => {
  const lines = screen(addr).split('\n');
  const i = lines.findLastIndex((l) => /[☐☒]/u.test(l));
  return lines.slice(Math.max(0, i)).join('\n');
};

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

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
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
    HERDR_MOBILE_INCLUDE_UNPLACED: '1',
    ...(process.env.CHECK_WEB_DIR ? { HERDR_MOBILE_WEB_DIR: process.env.CHECK_WEB_DIR } : {}),
  },
});

async function device(name) {
  console.log(`\n== ${name}`);
  const cwd = path.join(RUNS, `live-${name}`);
  fs.mkdirSync(cwd, { recursive: true });
  const tname = `hm-q-${name}`;
  const addr = hcJson(
    'run',
    '--bg',
    '--no-parent',
    '--no-notify',
    '--name',
    tname,
    '--cwd',
    cwd,
    '--',
    'claude',
    '--model',
    'haiku',
    PROMPT,
  ).address;
  const { browser, ctx } = await DEVICES[name]();
  try {
    const asking = await until(() => hcJson('get', addr).status?.state === 'blocked' && /Database/.test(block(addr)), 90000);
    if (!check(Boolean(asking), 'claude is asking', JSON.stringify(hcJson('get', addr).status))) {
      console.log(screen(addr).split('\n').slice(-25).join('\n'));
      throw new Error('no question');
    }
    const resume = JSON.parse(hcJson('get', addr).labels['agent-resume']);
    const page = await (await browser.newContext({ ...ctx, colorScheme: 'dark' })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (what) => page.screenshot({ path: path.join(SHOTS, `q-${name}-${what}.png`) });
    await page.goto(`${BASE}/#token=${TOKEN}&/a/${addr}/conversation`);
    const card = page.locator('.agent-input .approve');
    const btn = (label) => card.locator('.approve-btn', { hasText: label }).first();
    const tab = (label) => page.getByRole('tab', { name: label });
    // Scrolled into view first: a tap right after its card or bar scrolled is dropped (it stops a fling), as on a phone.
    const tapOn = async (loc) => {
      await loc.scrollIntoViewIfNeeded();
      await sleep(300);
      await loc.click();
    };
    const press = async (label) => {
      const k = page.getByRole('button', { name: label, exact: true });
      // Scrolled into view first: the key bar ignores a touch right after it scrolled (that touch stops a fling).
      await k.scrollIntoViewIfNeeded();
      await sleep(300);
      if (ctx.hasTouch) await k.tap();
      else await k.click();
    };

    // Q1 in Conversation: the whole question, descriptions, the first option white.
    await card.locator('.approve-q', { hasText: 'migration path' }).waitFor({ timeout: 20000 });
    check(
      (await card.locator('.approve-q').textContent()) === Q1,
      'Q1 full text',
      JSON.stringify(await card.locator('.approve-q').textContent()),
    );
    check(
      await btn('PostgreSQL').locator('.approve-desc', { hasText: 'Strong consistency and rich SQL' }).isVisible(),
      'descriptions shown',
    );
    check(
      (await card.locator('.approve-btn.primary').allTextContents()).join('|').startsWith('1PostgreSQL'),
      'white = first (nothing checked)',
    );
    check(
      (await card.locator('.approve-tab').allTextContents()).map((s) => s.replace(/\s+/g, '')).join(',') ===
        'Database,Features,Name,Submit',
      'steps shown',
    );
    check((await card.locator('.approve-tab.on').textContent())?.replace(/\s+/g, '') === 'Database', 'current step = Database');
    await shot('conv-q1');

    // Q1 in Terminal: no answer card; arrows + composer into "Type something"; Enter picks it.
    await tab('Terminal').click();
    await page.locator('.xterm').first().waitFor();
    await sleep(600);
    check((await page.locator('.approve').count()) === 0, 'Terminal view: no answer card');
    for (let i = 0; i < 3; i++) {
      await press('Down');
      await sleep(250);
    }
    check(Boolean(await until(() => /❯ 4\. Type something/.test(block(addr)), 5000)), 'arrows reached Type something');
    await page.locator('.composer-input').fill('Use SQLite 3 for now');
    await sleep(400);
    check((await page.locator('.composer-input').getAttribute('placeholder')) === 'Type your answer', 'composer knows it types the answer');
    await page.locator('.send-btn').click();
    check(
      Boolean(await until(() => /❯ 4\. Use SQLite 3 for now/.test(block(addr)), 5000)),
      'text landed in the field',
      block(addr)
        .split('\n')
        .find((l) => l.includes('4.')),
    );
    await sleep(500);
    check(/☐ Database/.test(block(addr)) && /❯ 4\. Use SQLite 3 for now/.test(block(addr)), 'not submitted early');
    check((await page.locator('.approve').count()) === 0, 'still no answer card in Terminal view');
    await shot('term-typed');
    await press('Enter');
    check(Boolean(await until(() => /Which features/.test(block(addr)), 5000)), 'Enter picked it: on to Q2');

    // Q2 in Conversation: multi-select.
    await tab('Conversation').click();
    await card.locator('.approve-q', { hasText: 'Which features' }).waitFor();
    check((await card.locator('.approve-tab.on').textContent())?.replace(/\s+/g, '') === 'Features', 'current step = Features');
    await tapOn(btn('Barcode scan'));
    await until(async () => (await btn('Barcode scan').getAttribute('aria-pressed')) === 'true', 5000);
    await tapOn(btn('CSV export'));
    check(
      Boolean(await until(async () => (await btn('CSV export').getAttribute('aria-pressed')) === 'true', 5000)),
      'multi-select ticks follow the terminal',
    );
    check(/\[✔\] Barcode scan/.test(block(addr)) && /\[✔\] CSV export/.test(block(addr)), 'ticked in Claude');
    await tapOn(btn('Type something'));
    await card.getByLabel('Your answer').fill('QR codes 2');
    await tapOn(card.getByRole('button', { name: 'Send answer' }));
    check(Boolean(await until(() => /\[✔\] QR codes 2/.test(block(addr)), 5000)), 'custom answer typed + ticked in Claude');
    await until(async () => (await btn('QR codes 2').count()) > 0, 5000);
    await shot('conv-multi');
    await tapOn(card.locator('.approve-next'));
    check(Boolean(await until(() => /What should the service be called/.test(block(addr)), 5000)), 'Next: on to Q3');

    // Q3: pick the 2nd, step back: the checked one is white though the cursor is on the first.
    await card.locator('.approve-q', { hasText: 'What should the service be called' }).waitFor();
    await tapOn(btn('inventory-api'));
    await card.locator('.approve-q', { hasText: 'Ready to submit' }).waitFor({ timeout: 8000 });
    await tapOn(card.locator('.approve-tab', { hasText: 'Name' }));
    await card.locator('.approve-q', { hasText: 'What should the service be called' }).waitFor({ timeout: 8000 });
    await sleep(400);
    const lit = await card.locator('.approve-btn.primary').allTextContents();
    check(lit.length === 1 && lit[0].includes('inventory-api'), 'white = the checked answer', JSON.stringify(lit));
    check(/❯ 1\. stockd/.test(block(addr)) && /inventory-api ✔/.test(block(addr)), 'Claude: cursor on 1, check on 2');
    await shot('conv-checked');
    await tapOn(card.locator('.approve-tab', { hasText: 'Submit' }));
    await card.locator('.approve-q', { hasText: 'Ready to submit' }).waitFor({ timeout: 8000 });
    await shot('conv-review');
    await tapOn(btn('Submit answers'));

    // What Claude got.
    const answers = await until(() => {
      for (const l of fs.readFileSync(resume.transcript, 'utf8').split('\n')) {
        if (!l.includes('"toolUseResult"')) continue;
        const r = JSON.parse(l).toolUseResult;
        if (r?.answers) return r.answers;
      }
      return null;
    }, 20000);
    check(answers?.[Q1] === 'Use SQLite 3 for now', 'Claude got Q1 (typed in Terminal view)', JSON.stringify(answers?.[Q1]));
    check(
      answers?.['Which features should the first release include?'] === 'Barcode scan, CSV export, QR codes 2',
      'Claude got Q2 (multi + typed)',
      JSON.stringify(answers?.['Which features should the first release include?']),
    );
    check(answers?.['What should the service be called?'] === 'inventory-api', 'Claude got Q3');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await page.close();
  } finally {
    await browser.close();
    try {
      hc('kill', addr);
    } catch {}
    try {
      hc('rm', addr);
    } catch {}
  }
}

try {
  check(Boolean(await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok)), `bridge up on :${PORT}`);
  for (const d of which) await device(d);
} catch (e) {
  failed++;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  bridge.kill('SIGTERM');
  check(!hcJson('ls').terminals.some((t) => t.name?.startsWith('hm-q-')), 'no hm-q-* terminals left');
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
