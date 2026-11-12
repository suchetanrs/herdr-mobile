// Live check of the agent screen's "Choose model" / "Choose effort level" with a real `claude --model haiku` in a
// throwaway terminal (one session for every device; a private bridge on 127.0.0.1:8788, seen sync off, built web).
// Per device (iPhone 15 on WebKit, Pixel 7, desktop):
//   ⋯ menu: Branch out, Choose model, Choose effort level, "More features coming soon" (disabled).
//   Choose model: Claude's list (More models included) with Haiku 5.5 ticked; tap Haiku 4.5 -> Claude confirms on its
//   screen; reopen: Haiku 4.5 ticked (a "More models" model); tap Haiku 5.5 -> confirmed.
//   Choose effort level: low..max, the one in use ticked; tap another level -> Claude confirms (screen), its transcript
//   records it.
//   Busy: a short Bash turn; while Claude works (or asks): menu items disabled with the reason, the API refuses (409).
//   The terminal's size never changes; no page errors.
// The session is set up like the user's real agents: a session name (shown in the message box's top rule), the
// user's own ~/.claude config (claude-hud status line under the box), a 173x45 terminal (held by an `hc attach` in a
// pty for the whole run) and a background shell (`sleep`, listed below the status line).
// Kills and removes the terminal at the end.
// usage: npm run build && node scripts/check-model-effort.mjs [iphone|android|desktop ...]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(REPO, '.test-tmp/model-effort');
const SHOTS = process.env.CHECK_SHOTS_DIR ?? path.join(REPO, '.test-tmp/screens');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `me-check-${'m'.repeat(40)}`;
const NAME = 'hm-me-live';
const which = process.argv.slice(2).length ? process.argv.slice(2) : ['iphone', 'android', 'desktop'];
const LEVEL = { iphone: 'low', android: 'high', desktop: 'medium' };

const hc = (...a) => execFileSync('hc', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hcJson = (cmd, ...a) => JSON.parse(hc(cmd, '--json', ...a));
const screen = (addr) => hcJson('read', addr).text;
const word = (addr) => hcJson('get', addr).status?.state ?? null;
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
/** Claude's last `⎿` answer on screen. */
const lastResult = (addr) =>
  screen(addr)
    .split('\n')
    .filter((l) => /^\s*⎿\s/.test(l))
    .at(-1)
    ?.trim() ?? '';

/** The last `<local-command-stdout>` in the session's transcript starts with `text`. */
const transcriptSays = (addr, text) => {
  const file = JSON.parse(hcJson('get', addr).labels['agent-resume']).transcript;
  const outs = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((e) => (typeof e.message?.content === 'string' ? e.message.content : typeof e.content === 'string' ? e.content : ''))
    .filter((c) => c.startsWith('<local-command-stdout>'));
  return (outs.at(-1) ?? '').startsWith(`<local-command-stdout>${text}`);
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

fs.mkdirSync(path.join(WORK, 'run'), { recursive: true });
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

async function device(name, addr) {
  console.log(`\n== ${name}`);
  const { browser, ctx } = await DEVICES[name]();
  try {
    const grid = () => {
      const t = hcJson('get', addr);
      return `${t.cols}x${t.rows}`;
    };
    const size = grid();
    const page = await (await browser.newContext({ ...ctx, colorScheme: 'dark' })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = (what) => page.screenshot({ path: path.join(SHOTS, `me-${name}-${what}.png`) });
    await page.goto(`${BASE}/#token=${TOKEN}&/a/${addr}/conversation`);
    const more = page.getByRole('button', { name: 'More', exact: true }).first();
    await more.waitFor({ timeout: 20000 });
    const item = (n) => page.getByRole('menuitem', { name: n });
    const sheet = (n) => page.getByRole('dialog', { name: n });
    const radios = (n) => sheet(n).getByRole('radio');
    const ticked = async (n) =>
      (
        await radios(n).evaluateAll((els) =>
          els.filter((e) => e.getAttribute('aria-checked') === 'true').map((e) => e.querySelector('.truncate')?.textContent),
        )
      ).join('|');
    const open = async (n) => {
      await more.click();
      await item(new RegExp(n)).click();
      await radios(n).first().waitFor({ timeout: 15000 });
    };
    const pick = async (n, label) => {
      const t0 = Date.now();
      await radios(n)
        .filter({ has: page.getByText(label, { exact: true }) })
        .click();
      const out = sheet(n).locator('.setting-done, [role=alert]');
      await out.first().waitFor({ timeout: 15000 });
      const said = (await out.first().textContent()).replace(/\s+/g, ' ').trim();
      if ((await sheet(n).getByRole('alert').count()) > 0) {
        await shot(`fail-${label}`);
        console.log(
          screen(addr)
            .split('\n')
            .filter((l) => l.trim())
            .slice(-14)
            .join('\n'),
        );
        await page.getByRole('button', { name: 'Close' }).click();
        return { said: `refused: ${said}`, ms: Date.now() - t0 };
      }
      await sheet(n).waitFor({ state: 'detached', timeout: 5000 });
      return { said, ms: Date.now() - t0 };
    };

    // The menu.
    await more.click();
    const items = await page
      .getByRole('menuitem')
      .evaluateAll((els) => els.map((e) => [e.textContent.replace(/\s+/g, ' ').trim(), e.disabled]));
    check(
      JSON.stringify(items.map(([t]) => t.replace(/(conversation|model|level|soon).*/, '$1'))) ===
        JSON.stringify(['Branch out from this conversation', 'Choose model', 'Choose effort level', 'More features coming soon']),
      'menu items',
      JSON.stringify(items),
    );
    check(items[1]?.[1] === false && items[2]?.[1] === false && items[3]?.[1] === true, 'model/effort enabled, last disabled');
    await shot('menu');
    await more.click();

    // Models: switch to Haiku 4.5 and back.
    await open('Choose model');
    const labels = await radios('Choose model').evaluateAll((els) => els.map((e) => e.querySelector('.truncate')?.textContent));
    check(labels.includes('Haiku 5.5') && labels.includes('Haiku 4.5') && labels.length >= 8, 'models listed', labels.join(', '));
    check((await ticked('Choose model')) === 'Haiku 5.5', 'Haiku 5.5 ticked', await ticked('Choose model'));
    await shot('models');
    let r = await pick('Choose model', 'Haiku 4.5');
    check(r.said.includes('Set model to Haiku 4.5 for this session only'), 'switched to Haiku 4.5', `${r.said} (${r.ms} ms)`);
    check(lastResult(addr).includes('Set model to Haiku 4.5 for this session only'), 'Claude’s screen says Haiku 4.5', lastResult(addr));
    check(transcriptSays(addr, 'Set model to `Haiku 4.5` for this session only'), 'Claude’s transcript has it');
    await open('Choose model');
    check((await ticked('Choose model')) === 'Haiku 4.5', 'reopened: Haiku 4.5 ticked', await ticked('Choose model'));
    r = await pick('Choose model', 'Haiku 5.5');
    check(r.said.includes('Set model to Haiku 5.5 for this session only'), 'switched back to Haiku 5.5', `${r.said} (${r.ms} ms)`);
    check(lastResult(addr).includes('Set model to Haiku 5.5 for this session only'), 'Claude’s screen says Haiku 5.5', lastResult(addr));

    // Effort.
    await open('Choose effort level');
    const levels = (await radios('Choose effort level').allTextContents()).map((x) => x.trim());
    check(levels.join(',') === 'low,medium,high,xhigh,max', 'effort levels listed', levels.join(','));
    const before = await ticked('Choose effort level');
    check(levels.includes(before), 'one level ticked', before);
    await shot('effort');
    const level = LEVEL[name] === before ? 'xhigh' : LEVEL[name];
    r = await pick('Choose effort level', level);
    check(r.said.startsWith(`Set effort level to ${level} (this session only)`), `effort set to ${level}`, `${r.said} (${r.ms} ms)`);
    check(transcriptSays(addr, `Set effort level to ${level} (this session only)`), 'Claude’s transcript has it');
    await open('Choose effort level');
    check((await ticked('Choose effort level')) === level, 'reopened: level ticked');
    await page.getByRole('button', { name: 'Close' }).click();

    // Busy: one short turn.
    hc('send', addr, 'Use the Bash tool to run exactly this command: sleep 8. Then reply with just the word OK.');
    const busy = await until(() => ['working', 'blocked'].includes(word(addr)), 20000);
    check(Boolean(busy), 'claude busy', String(word(addr)));
    await more.click();
    const busyItem = item(/Choose model/);
    await until(async () => await busyItem.isDisabled(), 5000);
    check(await busyItem.isDisabled(), 'Choose model disabled while busy', await busyItem.textContent());
    check(/Claude is (working|waiting)/.test((await busyItem.textContent()) ?? ''), 'with the reason');
    await shot('busy-menu');
    await more.click();
    const api = await page.evaluate(async (a) => {
      const g = await fetch(`/api/agents/${a}/claude/model`);
      const p = await fetch(`/api/agents/${a}/claude/effort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'low' }),
      });
      return [g.status, (await g.json()).error, p.status];
    }, addr);
    check(api[0] === 409 && api[2] === 409, 'API refuses while busy', JSON.stringify(api));
    // Back to idle (a permission question is declined).
    const idle = await until(() => {
      const w = word(addr);
      if (w === 'blocked') hc('keys', addr, 'esc');
      return w === 'idle' || w === 'done';
    }, 60000);
    check(Boolean(idle), 'claude idle again', String(word(addr)));
    await sleep(500);
    check(grid() === size, 'terminal size unchanged', `${size} -> ${grid()}`);
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await page.close();
  } finally {
    await browser.close();
  }
}

const COLS = 173;
const ROWS = 45;
let addr = null;
let holder = null;
try {
  check(Boolean(await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok)), `bridge up on :${PORT}`);
  addr = hcJson(
    'run',
    '--bg',
    '--no-parent',
    '--no-notify',
    '--name',
    NAME,
    '--cwd',
    path.join(WORK, 'run'),
    '--',
    'claude',
    '--model',
    'haiku',
    '--name',
    'hm-branch',
  ).address;
  const ready = await until(() => /❯/.test(screen(addr)) && ['idle', 'done'].includes(word(addr)), 60000);
  if (!check(Boolean(ready), 'claude ready', String(word(addr)))) throw new Error('claude did not start');
  // A wide terminal like the user's: an attach from a COLSxROWS pty owns the size while it stays open.
  holder = spawn('script', ['-qfec', `stty cols ${COLS} rows ${ROWS}; exec hc attach ${addr}`, '/dev/null'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const wide = await until(() => {
    const t = hcJson('get', addr);
    return t.cols === COLS && t.rows === ROWS;
  }, 10000);
  check(Boolean(wide), `terminal ${COLS}x${ROWS}`);
  hc(
    'send',
    addr,
    'Use the Bash tool with run_in_background set to true to run exactly this command: sleep 900. Then reply with just the word OK.',
  );
  const shell = await until(() => ['idle', 'done'].includes(word(addr)) && /\b\d+ shells?\b/.test(screen(addr)), 90000);
  const bottom = screen(addr).split('\n');
  check(Boolean(shell), 'background shell listed under the status line', shell ? '' : `${word(addr)}: ${bottom.slice(-4).join(' / ')}`);
  check(
    bottom.some((l) => /^─+ hm-branch ─\s*$/.test(l)),
    'session name in the message box’s top rule',
  );
  check(
    bottom.some((l) => /^\s*\[Haiku [\d.]+\] │/.test(l)),
    'claude-hud status line under the box',
  );
  for (const d of which) await device(d, addr);
} catch (e) {
  failed++;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  bridge.kill('SIGTERM');
  holder?.stdin.end();
  holder?.kill('SIGTERM');
  if (addr) {
    try {
      hc('kill', addr);
    } catch {}
    try {
      hc('rm', addr);
    } catch {}
  }
  check(!hcJson('ls').terminals.some((t) => t.name?.startsWith('hm-me-')), 'no hm-me-* terminals left');
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
