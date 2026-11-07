// Live check of the Claude account per agent (task 13): a private bridge on 127.0.0.1:8788 (seen sync off,
// read only: never types), then
//   1. /api/world's accounts equal the desktop my-agents mod's own script, run read-only:
//      `python3 -I ~/.config/herdr-app/mods/my-agents/accounts.py` (terminal id -> [name, plan]);
//   2. every account in the payload holds exactly {name, plan};
//   3. screenshots of the space screen, the agent screen header and the desktop sidebar at iPhone 15 (WebKit),
//      375 px wide (WebKit) and desktop (Chromium), to .test-tmp/screens/acc-*.png (or CHECK_SHOTS_DIR).
// usage: npm run build && node scripts/check-accounts.mjs [--no-shots]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(REPO, '.test-tmp/accounts');
const SHOTS = process.env.CHECK_SHOTS_DIR ?? path.join(REPO, '.test-tmp/screens');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `acc-check-${'a'.repeat(40)}`;
const SCRIPT = path.join(os.homedir(), '.config/herdr-app/mods/my-agents/accounts.py');
const shots = !process.argv.includes('--no-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` ${detail}` : ''}`);
  return ok;
};
const getWorld = () =>
  new Promise((resolve, reject) => {
    http
      .get(`${BASE}/api/world`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        let s = '';
        res.on('data', (d) => {
          s += d;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(s).world);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
const theirs = () => JSON.parse(execFileSync('python3', ['-I', SCRIPT], { encoding: 'utf8' }));
const ours = (world) => {
  const out = {};
  for (const t of Object.values(world.terminals)) if (t.account) out[t.id] = [t.account.name, t.account.plan];
  return out;
};

function webkitEnv() {
  const lib = path.join(REPO, '.test-tmp/webkit-libs/root/usr/lib/x86_64-linux-gnu');
  const libs = ['libyuv.so.0', 'libgav1.so.1', 'libavif.so.16'].map((f) => path.join(lib, f));
  if (!libs.every((f) => fs.existsSync(f))) return undefined;
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
  return { ...process.env, LD_PRELOAD: libs.join(':') };
}

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
  },
});

try {
  let world = null;
  for (let i = 0; i < 100 && !(world?.core.connected && world.spaceOrder.length && Object.keys(ours(world)).length); i++) {
    await sleep(200);
    world = await getWorld().catch(() => null);
  }
  check(Boolean(world?.core.connected), 'bridge up, core connected');

  // 1. Same as accounts.py (sampled around ours, so a claude starting meanwhile can't fail it).
  let equal = false;
  let a = {};
  let b = {};
  for (let i = 0; i < 3 && !equal; i++) {
    const before = theirs();
    world = await getWorld();
    a = ours(world);
    b = theirs();
    // Restricted to terminals the world shows (accounts.py also lists claudes in terminals Herdr doesn't show).
    const shown = (m) => Object.fromEntries(Object.entries(m).filter(([id]) => world.terminals[id]));
    equal = JSON.stringify(shown(before)) === JSON.stringify(shown(b)) && sortKeys(a) === sortKeys(shown(b));
    if (!equal) await sleep(1000);
  }
  const hidden = Object.keys(b).filter((id) => !world.terminals[id]);
  check(equal, '/api/world accounts == accounts.py', `\n  bridge:     ${sortKeys(a)}\n  accounts.py: ${sortKeys(b)}`);
  console.log(`  ${Object.keys(a).length} agents with an account; accounts.py ids not in the world: ${hidden.join(',') || 'none'}`);

  // 2. Nothing but name + plan.
  const extra = Object.values(world.terminals).filter((t) => t.account && Object.keys(t.account).sort().join() !== 'name,plan');
  check(extra.length === 0, 'every account is exactly {name, plan}');
  const remote = Object.values(world.terminals).filter((t) => t.machine && t.account);
  check(remote.length === 0, 'no account on another machine’s terminal');

  if (shots) await screenshots(world, a);
} finally {
  bridge.kill('SIGTERM');
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);

function sortKeys(m) {
  return JSON.stringify(Object.fromEntries(Object.entries(m).sort(([x], [y]) => x.localeCompare(y))));
}

async function screenshots(world, accounts) {
  // The space with the most agents that have an account; an agent of the second login if there is one.
  const count = (sid) => Object.values(world.terminals).filter((t) => t.spaceId === sid && !t.parent && t.account).length;
  const space = [...world.spaceOrder].sort((x, y) => count(y) - count(x))[0];
  const names = new Map();
  for (const [id, [n]] of Object.entries(accounts)) if (!names.has(n)) names.set(n, id);
  const placed = (id) => world.terminals[id]?.paneId;
  const agent = [...names.values()].reverse().find(placed) ?? Object.keys(accounts).find(placed);
  const targets = [
    { name: 'iphone15', make: async () => [await webkit.launch({ env: webkitEnv() }), strip(devices['iPhone 15'])] },
    {
      name: '375',
      make: async () => [
        await webkit.launch({ env: webkitEnv() }),
        { ...strip(devices['iPhone SE']), viewport: { width: 375, height: 740 } },
      ],
    },
    {
      name: 'desktop',
      make: async () => [await chromium.launch({ args: ['--use-angle=swiftshader'] }), { viewport: { width: 1440, height: 900 } }],
    },
  ];
  for (const t of targets) {
    const [browser, opts] = await t.make();
    const page = await (await browser.newContext({ ...opts, colorScheme: 'dark' })).newPage();
    page.on('pageerror', (e) => check(false, `[${t.name}] page error`, e.message));
    await page.goto(`${BASE}/#token=${TOKEN}&/s/${encodeURIComponent(space)}`);
    await page.waitForSelector('.agent-row .account', { timeout: 15000 }).catch(() => null);
    const shown = await page.locator('.agent-row .account').allTextContents();
    check(shown.length > 0, `[${t.name}] space rows show accounts`, JSON.stringify(shown));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `[${t.name}] no sideways scroll`, String(overflow));
    await page.screenshot({ path: path.join(SHOTS, `acc-${t.name}-space.png`) });
    if (t.name === 'desktop') {
      const side = await page.locator('.sb-agent .account').allTextContents();
      check(side.length > 0, '[desktop] sidebar agents list shows accounts', JSON.stringify(side));
    }
    if (agent && t.name !== '375') {
      await page.evaluate(
        (h) => {
          window.location.hash = h;
        },
        `#/a/${encodeURIComponent(agent)}`,
      );
      const sel = t.name === 'desktop' ? '.pane-head .account' : '.agent-bar .account';
      const head = await page.waitForSelector(sel, { timeout: 15000 }).catch(() => null);
      const [n, p] = accounts[agent];
      check((await head?.textContent()) === (p ? `${n}, ${p}` : n), `[${t.name}] agent header shows ${agent}'s account`);
      await sleep(1500);
      await page.screenshot({ path: path.join(SHOTS, `acc-${t.name}-agent.png`) });
    }
    await browser.close();
  }
}

function strip({ defaultBrowserType, ...d }) {
  return d;
}
