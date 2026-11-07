// Live check of a space's "+" (new tab: Terminal, Claude new, Claude resume) against the real Herdr window,
// on iPhone 15 (WebKit), Pixel 7 and desktop Chrome, then a full clean-up.
// Makes one throwaway space (shell) in FOLDER through the bridge, then per device starts its own bridge on
// 127.0.0.1:8788 (seen sync off; a fresh one per device so the 6-per-10-minutes limit isn't hit) and through
// the UI: + -> Terminal (a tab of the space, opened), + -> Claude session -> New (claude starts; killed at
// once), + -> Claude session -> Resume (lists FOLDER's sessions; the one in SESSION opens with
// `claude --resume`; the list then marks it open). Ends every terminal it started so Herdr closes the
// space, removes them, and checks `herdr-app ls` is back to what it was.
// usage: npm run build && node scripts/check-space-plus.mjs <folder> <session-id> [iphone,android,desktop]
//   FOLDER must hold a throwaway Claude session (e.g. `claude --model haiku -p "say pong"` run there).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(REPO, '.test-tmp/space-plus');
const SHOTS = process.env.SHOTS ?? path.join(WORK, 'shots');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `sp-check-${'y'.repeat(40)}`;
const [FOLDER_ARG, SESSION, which = 'iphone,android,desktop'] = process.argv.slice(2);
if (!FOLDER_ARG || !/^[0-9a-f-]{36}$/.test(SESSION ?? '')) {
  console.error('usage: node scripts/check-space-plus.mjs <folder> <session-id> [devices]');
  process.exit(2);
}
const FOLDER = fs.realpathSync(FOLDER_ARG);

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
/** The live `claude` under a terminal's shell, with its argv. */
const claudeIn = (t) => {
  const rec = hcGet(t);
  const pid = rec.foreground?.pid;
  if (rec.foreground?.name !== 'claude' || !pid) return null;
  try {
    return { pid, argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
  } catch {
    return null;
  }
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

let bridge = null;
async function startBridge(tag) {
  const log = fs.openSync(path.join(WORK, `bridge-${tag}.log`), 'w');
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
  return check(
    Boolean(await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok)),
    `bridge up on :${PORT} (${tag})`,
  );
}
async function stopBridge() {
  if (!bridge) return;
  const b = bridge;
  bridge = null;
  b.kill('SIGTERM');
  await until(() => b.exitCode !== null || b.signalCode !== null, 8000);
}

/** Ends a terminal the check started and removes it. */
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

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const before = ls();
const beforeIds = before.map((s) => s.id);
console.log(`before: ${before.length} spaces: ${before.map((s) => s.name).join(', ')}`);
const started = [];
let spaceId = null;
let baseTerminal = null;
let browser;
try {
  await startBridge('setup');
  const made = await api('/api/spaces', { method: 'POST', body: JSON.stringify({ folder: FOLDER, start: { kind: 'shell' } }) });
  check(made.status === 200, 'throwaway space made (POST /api/spaces, shell)', JSON.stringify(made.body));
  if (made.status !== 200) throw new Error('no space');
  spaceId = made.body.spaceId;
  baseTerminal = made.body.terminalId;
  await stopBridge();

  for (const name of which.split(',')) {
    console.log(`--- ${name}`);
    await startBridge(name);
    const dev = await DEVICES[name]();
    browser = dev.browser;
    const page = await browser.newPage(dev.ctx);
    const errors = [];
    page.on('pageerror', (e) => {
      if (!/ResizeObserver loop/.test(e.message)) errors.push(e.message);
    });
    const openSpace = async () => {
      await page.goto(`${BASE}/#token=${TOKEN}&/s/${spaceId}`);
      await page.waitForURL(new RegExp(`#/s/${spaceId}$`), { timeout: 10000 }).catch(() => page.goto(`${BASE}/#/s/${spaceId}`));
      await page.getByRole('button', { name: 'New tab' }).waitFor({ timeout: 15000 });
    };
    const plus = async () => {
      await page.getByRole('button', { name: 'New tab' }).click();
      return page.getByRole('dialog');
    };
    const opened = async (what) => {
      await page.waitForURL(/#\/a\/[^/]+$/, { timeout: 20000 });
      const t = decodeURIComponent(new URL(page.url()).hash.replace('#/a/', ''));
      started.push(t);
      check(true, `${what}: opened the new terminal's screen`, t);
      return t;
    };
    const tabOf = (t) =>
      ls()
        .find((s) => s.id === spaceId)
        ?.tabs.find((x) => x.terminals.some((y) => y.terminal === t));

    // 1. Terminal
    await openSpace();
    let dialog = await plus();
    await dialog.getByText('A shell in').waitFor();
    await page.screenshot({ path: path.join(SHOTS, `sp-${name}-menu.png`) });
    let t0 = Date.now();
    await dialog.getByRole('button', { name: /^Terminal/ }).click();
    const shell = await opened('Terminal');
    console.log(`  ${Date.now() - t0} ms from tap to the terminal's screen`);
    const shellTab = tabOf(shell);
    check(
      Boolean(shellTab),
      'herdr-app ls: a new tab of the space holds it',
      JSON.stringify(shellTab && { id: shellTab.id, name: shellTab.name }),
    );
    check(/^\d+$/.test(shellTab?.name ?? ''), 'its tab is named by its number, like the + menu’s Terminal', shellTab?.name);
    const rec = hcGet(shell);
    check(
      rec.labels['herdr.space'] === spaceId &&
        rec.labels['herdr.tab'] === shellTab?.id &&
        rec.labels['herdr.seen'] === '0' &&
        rec.keep === true &&
        rec.cwd === FOLDER,
      'core: space id, fresh tab id, seen=0, keep, cwd = the space folder',
      JSON.stringify({ labels: rec.labels, keep: rec.keep, cwd: rec.cwd, argv: rec.argv }),
    );
    check(ls().find((s) => s.id === spaceId)?.tabs.length >= 2, 'the space now has the new tab besides its first');

    // 2. Claude -> New
    await openSpace();
    dialog = await plus();
    await dialog.getByRole('button', { name: /Claude session/ }).click();
    await page.getByRole('dialog', { name: 'Claude session' }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, `sp-${name}-claude.png`) });
    t0 = Date.now();
    await page.getByRole('button', { name: /New session/ }).click();
    const fresh = await opened('Claude -> New');
    const proc = await until(() => claudeIn(fresh), 15000);
    check(Boolean(proc), 'claude started in it', proc ? `${proc.argv.join(' ')} after ${Date.now() - t0} ms` : '');
    check(Boolean(proc) && !proc.argv.includes('--resume'), 'a new session (no --resume)');
    const freshTab = await until(() => (tabOf(fresh)?.name === 'Claude Code' ? tabOf(fresh) : null), 5000);
    check(Boolean(freshTab), 'its tab is named "Claude Code", as the + menu names it');
    const freshArgv = hcGet(fresh).argv;
    check(
      freshArgv.slice(1, 4).join('|') === `-ic|"$@"; exec "$0" -i|${freshArgv[0]}` && freshArgv.at(-1) === 'claude',
      'argv = $SHELL -ic \'"$@"; exec "$0" -i\' $SHELL claude',
      JSON.stringify(freshArgv),
    );
    await end(fresh);
    check(true, 'killed it at once');

    // 3. Claude -> Resume
    await openSpace();
    dialog = await plus();
    await dialog.getByRole('button', { name: /Claude session/ }).click();
    await page.getByRole('button', { name: /Resume session/ }).click();
    const list = page.getByRole('dialog', { name: 'Resume a session' });
    const row = list.getByRole('button', { name: /ago/ }).filter({ hasText: /pong/ });
    await row.first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOTS, `sp-${name}-resume.png`) });
    const listed = await api(`/api/spaces/${spaceId}/sessions`);
    check(
      listed.body.sessions?.some((s) => s.id === SESSION),
      'the folder’s throwaway session is listed',
      `${listed.body.sessions?.length} session(s) in ${listed.body.display}`,
    );
    t0 = Date.now();
    await row.first().click();
    const resumed = await opened('Claude -> Resume');
    const rp = await until(() => claudeIn(resumed), 15000);
    check(
      Boolean(rp) && rp.argv.slice(-2).join(' ') === `--resume ${SESSION}`,
      'claude --resume <the session> runs in it',
      rp ? rp.argv.join(' ') : '',
    );
    const resumedArgv = hcGet(resumed).argv;
    check(
      resumedArgv.slice(-3).join(' ') === `claude --resume ${SESSION}`,
      'argv = the + menu’s claude + --resume <id>, default login (no CLAUDE_CONFIG_DIR)',
      JSON.stringify(resumedArgv),
    );
    // A folder Claude hasn't been trusted in asks first; this is the throwaway's own folder.
    const trust = await until(
      () =>
        /trust|Yes, proceed|pong/i.test(JSON.parse(hc('read', resumed, '--json')).text) && JSON.parse(hc('read', resumed, '--json')).text,
      15000,
    );
    if (trust && /Yes, proceed|trust the files/i.test(trust) && !/pong/.test(trust)) {
      hc('keys', resumed, 'enter');
    }
    const shown = await until(() => /pong/.test(JSON.parse(hc('read', resumed, '--json')).text), 20000);
    check(Boolean(shown), 'the resumed conversation shows ("pong" from the throwaway run)');
    const again = await until(async () => {
      const r = await api(`/api/spaces/${spaceId}/sessions`);
      return r.body.sessions?.find((s) => s.id === SESSION)?.openIn === resumed ? r : null;
    }, 15000);
    check(Boolean(again), 'the list now marks it open in that terminal (tapping it jumps there)');
    if (again) {
      await openSpace();
      dialog = await plus();
      await dialog.getByRole('button', { name: /Claude session/ }).click();
      await page.getByRole('button', { name: /Resume session/ }).click();
      const openRow = page.getByRole('dialog', { name: 'Resume a session' }).getByRole('button', { name: /pong/ }).first();
      await openRow.waitFor();
      check((await openRow.textContent())?.includes('Open'), 'its row says Open');
      await openRow.click();
      await page.waitForURL(new RegExp(`#/a/${resumed}$`), { timeout: 5000 });
      check(true, 'tapping it opens that terminal, nothing new started');
      const dup = await api(`/api/spaces/${spaceId}/tabs`, {
        method: 'POST',
        body: JSON.stringify({ start: { kind: 'resume', session: SESSION } }),
      });
      check(dup.status === 409, 'resuming it again is refused', JSON.stringify(dup.body));
    }
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    for (const t of [shell, resumed]) await end(t);
    check(ls().find((s) => s.id === spaceId)?.tabs.length === 1, 'the space is back to its one tab');
    await browser.close();
    browser = null;
    await stopBridge();
  }
} catch (e) {
  check(false, 'run', e.stack);
} finally {
  await browser?.close().catch(() => {});
  await stopBridge();
  for (const t of started) {
    try {
      if (hcGet(t)) await end(t);
    } catch {}
  }
  if (baseTerminal) {
    await end(baseTerminal);
    check(Boolean(await until(() => !ls().some((s) => s.id === spaceId), 15000)), 'Herdr closed the throwaway space', spaceId);
  }
  const afterIds = ls().map((s) => s.id);
  check(JSON.stringify(afterIds) === JSON.stringify(beforeIds), 'herdr-app ls back to before', `${afterIds.length} spaces`);
  const left = [...started, baseTerminal].filter(Boolean).filter((t) => {
    try {
      hcGet(t);
      return true;
    } catch {
      return false;
    }
  });
  check(left.length === 0, 'every terminal it started is gone from the core', left.join(','));
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exitCode = failed ? 1 : 0;
}
