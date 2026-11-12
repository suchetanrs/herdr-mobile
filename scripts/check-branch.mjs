// Live check of the agent screen's "⋯" -> Branch out against the real Herdr window, on iPhone 15 (WebKit),
// Pixel 7 and desktop Chrome, then a full clean-up.
// Makes one throwaway space (shell) in FOLDER, resumes SESSION in a new tab of it (the source agent, kept
// for all devices), then per device on its own bridge (127.0.0.1:8788, seen sync off): opens the source's
// Conversation, ⋯ (placeholder disabled) -> Branch out -> name NAME -> Create; checks a new tab named NAME in
// the same space runs `claude --resume SESSION --fork-session --name NAME` (one argument), shows the
// conversation's history, runs a new session id, and SESSION's transcript isn't touched by the fork.
// usage: npm run build && node scripts/check-branch.mjs <folder> <session-id> [iphone,android,desktop]
//   FOLDER must hold a throwaway Claude session (e.g. `claude --model haiku -p "say pong"` run there).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(REPO, '.test-tmp/branch');
const SHOTS = process.env.SHOTS ?? path.join(WORK, 'shots');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `br-check-${'y'.repeat(40)}`;
const [FOLDER_ARG, SESSION, which = 'iphone,android,desktop'] = process.argv.slice(2);
if (!FOLDER_ARG || !/^[0-9a-f-]{36}$/.test(SESSION ?? '')) {
  console.error('usage: node scripts/check-branch.mjs <folder> <session-id> [devices]');
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

const NAME = 'branch test é "q"';
const projectDir = (folder) => folder.replace(/[^A-Za-z0-9]/g, '-');
const SOURCE_FILE = () => path.join(process.env.HOME, '.claude/projects', projectDir(FOLDER), `${SESSION}.jsonl`);
const stamp = (f) => {
  const s = fs.statSync(f);
  return `${s.size}:${s.mtimeMs}`;
};
/** The session id a live claude runs (Claude's registry), read only. */
const sessionOf = (pid) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude/sessions', `${pid}.json`), 'utf8')).sessionId;
  } catch {
    return null;
  }
};
const screenText = (t) => JSON.parse(hc('read', t, '--json')).text;
/** Answers Claude's folder-trust question if it asks (the throwaway folder), then waits for `re`. */
async function shows(t, re, ms = 25000) {
  const seen = await until(() => {
    const txt = screenText(t);
    return (re.test(txt) || /Yes, proceed|trust the files/i.test(txt)) && txt;
  }, ms);
  if (seen && !re.test(seen) && /Yes, proceed|trust the files/i.test(seen)) hc('keys', t, 'enter');
  return Boolean(await until(() => re.test(screenText(t)), ms));
}

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const before = ls();
const beforeIds = before.map((s) => s.id);
console.log(`before: ${before.length} spaces: ${before.map((s) => s.name).join(', ')}`);
const started = [];
let spaceId = null;
let baseTerminal = null;
let source = null;
let browser;
try {
  await startBridge('setup');
  const made = await api('/api/spaces', { method: 'POST', body: JSON.stringify({ folder: FOLDER, start: { kind: 'shell' } }) });
  check(made.status === 200, 'throwaway space made (POST /api/spaces, shell)', JSON.stringify(made.body));
  if (made.status !== 200) throw new Error('no space');
  spaceId = made.body.spaceId;
  baseTerminal = made.body.terminalId;
  const res = await api(`/api/spaces/${spaceId}/tabs`, {
    method: 'POST',
    body: JSON.stringify({ start: { kind: 'resume', session: SESSION } }),
  });
  check(res.status === 200, 'source agent: the throwaway session resumed in a new tab', JSON.stringify(res.body));
  if (res.status !== 200) throw new Error('no source');
  source = res.body.terminalId;
  started.push(source);
  check(await shows(source, /pong/), 'source shows the throwaway conversation ("pong")');
  const known = await until(async () => {
    const w = (await api('/api/world')).body.world ?? {};
    const t = w.terminals?.[source];
    return t?.program === 'claude' && t.transcript?.endsWith(`${SESSION}.jsonl`) ? t : null;
  }, 20000);
  check(Boolean(known), 'the bridge knows its session (world transcript)', known?.transcript ?? '');
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
    await page.goto(`${BASE}/#token=${TOKEN}&/a/${source}/conversation`);
    await page
      .waitForURL(new RegExp(`#/a/${source}/conversation$`), { timeout: 10000 })
      .catch(() => page.goto(`${BASE}/#/a/${source}/conversation`));
    await page.getByText('pong').first().waitFor({ timeout: 20000 });
    const more = page.getByRole('button', { name: 'More', exact: true });
    await more.waitFor({ timeout: 10000 });
    const box = await more.boundingBox();
    check(name === 'desktop' || (box && box.width >= 44 && box.height >= 44), 'the ⋯ button: 44 px on phones', JSON.stringify(box));
    const vw = page.viewportSize()?.width ?? 0;
    check(Boolean(box) && box.x + box.width > vw * 0.6, 'top right', `x=${box?.x} of ${vw}`);
    await more.click();
    const branchItem = page.getByRole('menuitem', { name: /Branch out from this conversation/ });
    const soon = page.getByRole('menuitem', { name: /More options coming soon/ });
    check(await branchItem.isEnabled(), 'Branch out is enabled for this Claude agent');
    check(await soon.isDisabled(), 'the placeholder is disabled');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `branch-${name}-menu.png`) });
    await branchItem.click();
    const input = page.getByRole('textbox', { name: 'Name of the new conversation' });
    await input.waitFor();
    check(/\(branch\)$/.test(await input.inputValue()), 'name prefilled', await input.inputValue());
    await input.fill(NAME);
    const dlg = await page.getByRole('dialog', { name: 'Branch out' }).boundingBox();
    check(Boolean(dlg) && dlg.height > 100 && dlg.y >= 0, 'the name sheet is on screen', JSON.stringify(dlg));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `branch-${name}-name.png`) });
    const src0 = stamp(SOURCE_FILE());
    const t0 = Date.now();
    await page.getByRole('button', { name: /Create/ }).click();
    await page.waitForURL((u) => /^#\/a\/[^/]+/.test(u.hash) && !u.hash.startsWith(`#/a/${source}`), { timeout: 25000 });
    const fork = decodeURIComponent(new URL(page.url()).hash.replace(/^#\/a\//, '').split('/')[0]);
    if (fork !== source) started.push(fork);
    check(fork !== source, 'opened the new agent’s screen', `${fork} after ${Date.now() - t0} ms`);
    check(
      new URL(page.url()).hash.endsWith('/terminal'),
      'on its Terminal view (the fork’s history shows there at once)',
      new URL(page.url()).hash,
    );
    const tab = await until(() => {
      const sp = ls().find((s) => s.id === spaceId);
      const tb = sp?.tabs.find((x) => x.terminals.some((y) => y.terminal === fork));
      return tb?.name === NAME ? tb : null;
    }, 8000);
    check(Boolean(tab), 'herdr-app ls: a new tab in the SAME space, named exactly the name', JSON.stringify(tab?.name));
    const argv = hcGet(fork).argv;
    check(
      argv.slice(1, 4).join('|') === `-ic|"$@"; exec "$0" -i|${argv[0]}` &&
        JSON.stringify(argv.slice(4)) === JSON.stringify(['claude', '--resume', SESSION, '--fork-session', '--name', NAME]),
      'core argv = $SHELL -ic \'"$@"; exec "$0" -i\' $SHELL claude --resume <id> --fork-session --name <name>',
      JSON.stringify(argv),
    );
    const rec = hcGet(fork);
    check(
      rec.cwd === FOLDER && rec.keep === true && rec.labels['herdr.space'] === spaceId,
      'cwd = the source’s folder, keep, same space id',
      rec.cwd,
    );
    const proc = await until(() => claudeIn(fork), 15000);
    check(
      Boolean(proc) && JSON.stringify(proc.argv.slice(-5)) === JSON.stringify(['--resume', SESSION, '--fork-session', '--name', NAME]),
      'the claude process got the name as ONE argument',
      proc ? JSON.stringify(proc.argv) : '',
    );
    check(await shows(fork, /pong/), 'the fork shows the conversation’s history ("pong")');
    const sid = await until(() => (proc ? sessionOf(proc.pid) : null), 10000);
    check(Boolean(sid) && sid !== SESSION, 'the fork runs a NEW session id', String(sid));
    await sleep(1500);
    check(
      stamp(SOURCE_FILE()) === src0,
      'the source transcript is not modified by the fork (size:mtime)',
      `${src0} -> ${stamp(SOURCE_FILE())}`,
    );
    if (name !== 'desktop') {
      // (desktop at DPR 1 draws the terminal with WebGL: no DOM text to find; see the screenshot)
      await page
        .getByText('pong')
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => {});
      check(
        await page
          .getByText('pong')
          .first()
          .isVisible()
          .catch(() => false),
        'the page shows the history ("pong") in the fork’s terminal',
      );
    }
    await page.screenshot({ path: path.join(SHOTS, `branch-${name}-fork.png`) });
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await end(fork);
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
  // Anything else left in the throwaway space (ours) goes too.
  for (const t of ls()
    .find((s) => s.id === spaceId)
    ?.tabs.flatMap((x) => x.terminals.map((y) => y.terminal)) ?? []) {
    if (t !== baseTerminal) {
      console.log(`ending leftover ${t}`);
      await end(t);
    }
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
