// Live check of the Conversation tab against a running bridge. Two parts:
//  1. Synthetic: a throwaway terminal (hm-conv) runs scripts/fake-agent.py, which writes a Claude Code-shaped
//     transcript. The bridge must run with HERDR_MOBILE_INCLUDE_UNPLACED=1,
//     HERDR_MOBILE_TRANSCRIPT_ROOTS=<dir> and HERDR_MOBILE_TRANSCRIPT_OVERRIDE=hm-conv=<dir>/session.jsonl.
//     Checks: default tab, append -> on screen latency, composer send -> agent -> bubble, working row,
//     scroll-up hold + jump pill, tab memory.
//  2. Real agent, read only (REAL_AGENT=t10 or the first done/idle agent with a transcript): the tab's
//     prompts and replies against the transcript file and the terminal's text (`hc read`), plus screenshots.
// usage: node scripts/check-conversation.mjs <screens-dir> <synthetic-dir> [base-url]
// Run the bridge with HERDR_MOBILE_SEEN_SYNC=0 so looking at real agents doesn't mark them seen.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const out = path.resolve(process.argv[2] ?? '.test-tmp/screens');
const synth = path.resolve(process.argv[3] ?? '.test-tmp/conv');
const base = process.argv[4] ?? 'http://127.0.0.1:8787';
const token = process.env.HERDR_MOBILE_TOKEN ?? fs.readFileSync(path.join(os.homedir(), '.config/herdr-mobile/token'), 'utf8').trim();
const file = path.join(synth, 'session.jsonl');
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
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : fail(name, detail));
const until = async (fn, ms = 10000, step = 25) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const headers = { authorization: `Bearer ${token}` };
const world = async () => (await (await fetch(`${base}/api/world`, { headers })).json()).world;

// ---- a seeded synthetic transcript (so the screenshots show every kind of card) ----
let n = 0;
const ts = () => new Date(Date.now() - 600_000 + n * 1000).toISOString();
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const asst = (block, more = {}) => ({
  type: 'assistant',
  uuid: id(),
  timestamp: ts(),
  ...more,
  message: {
    id: `m${n}`,
    model: 'claude-opus-5-5',
    role: 'assistant',
    content: [block],
    usage: { input_tokens: 4, cache_read_input_tokens: 48_000, output_tokens: 90 },
  },
});
const result = (tool, content, extra) => ({
  type: 'user',
  uuid: id(),
  timestamp: ts(),
  message: { role: 'user', content: [{ tool_use_id: tool, type: 'tool_result', content, is_error: false }] },
  toolUseResult: extra,
});
const seed = [
  { type: 'custom-title', customTitle: 'login-fix' },
  {
    type: 'user',
    uuid: id(),
    timestamp: ts(),
    message: { role: 'user', content: 'The login form accepts an empty password. Fix it and add a test.' },
  },
  asst(
    { type: 'thinking', thinking: 'Find where the form validates, then add a guard and a test.', signature: 'x' },
    { thinkingDurationMs: 2100 },
  ),
  asst({
    type: 'tool_use',
    id: 'toolu_s1',
    name: 'Bash',
    input: { command: 'rg -n "password" src/auth', description: 'Find the password checks' },
  }),
  result('toolu_s1', 'src/auth/login.ts:14:  if (!user) return fail();\nsrc/auth/login.ts:15:  return check(user, password);', {
    stdout: 'src/auth/login.ts:14:  if (!user) return fail();\nsrc/auth/login.ts:15:  return check(user, password);',
    stderr: '',
  }),
  asst({
    type: 'tool_use',
    id: 'toolu_s2',
    name: 'Edit',
    input: {
      file_path: `${synth}/src/auth/login.ts`,
      old_string: '  if (!user) return fail();',
      new_string: "  if (!user) return fail();\n  if (!password) return fail('empty password');",
    },
  }),
  result('toolu_s2', 'updated', {
    filePath: `${synth}/src/auth/login.ts`,
    structuredPatch: [
      {
        oldStart: 13,
        oldLines: 3,
        newStart: 13,
        newLines: 4,
        lines: [
          '   const user = await find(name);',
          '   if (!user) return fail();',
          "+  if (!password) return fail('empty password');",
          '   return check(user, password);',
        ],
      },
    ],
  }),
  asst({
    type: 'tool_use',
    id: 'toolu_s3',
    name: 'TodoWrite',
    input: {
      todos: [
        { content: 'Guard empty passwords', status: 'completed' },
        { content: 'Add a test', status: 'in_progress' },
        { content: 'Run the suite', status: 'pending' },
      ],
    },
  }),
  asst({ type: 'tool_use', id: 'toolu_s4', name: 'Bash', input: { command: 'npm test -- login', description: 'Run the login tests' } }),
  result('toolu_s4', 'PASS src/auth/login.test.ts\n  ✓ rejects an empty password (4 ms)\n  ✓ logs in (6 ms)\nTests: 2 passed', {
    stdout: 'PASS src/auth/login.test.ts\n  ✓ rejects an empty password (4 ms)\n  ✓ logs in (6 ms)\nTests: 2 passed',
    stderr: '',
  }),
  asst({
    type: 'text',
    text: "Fixed. An empty password now fails before the lookup:\n\n```ts\nif (!password) return fail('empty password');\n```\n\n- **Test:** `rejects an empty password` passes.\n- Nothing else changed.",
  }),
  { type: 'system', subtype: 'turn_duration', uuid: id(), timestamp: ts(), durationMs: 48_000 },
  { type: 'cost-state', totalCostUSD: 0.84 },
];
fs.mkdirSync(synth, { recursive: true });
fs.writeFileSync(file, seed.map((e) => `${JSON.stringify(e)}\n`).join(''));

let conv = hcJson('ls').terminals.find((t) => t.name === 'hm-conv' && t.state === 'live')?.address;
if (!conv)
  conv = hcJson(
    'run',
    '--bg',
    '--no-parent',
    '--no-notify',
    '--name',
    'hm-conv',
    '--cwd',
    synth,
    '--',
    'python3',
    '-u',
    path.resolve('scripts/fake-agent.py'),
    file,
  ).address;
console.log('throwaway', conv);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' };
const desk = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' };
const listText = (page) => page.evaluate(() => document.querySelector('.conv-list')?.textContent ?? '');

try {
  check(await until(async () => (await world()).terminals[conv]?.transcript === file, 5000), 'synthetic transcript listed in the world');
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  await page.goto(`${base}/#token=${encodeURIComponent(token)}`);
  await page.waitForSelector('.screen', { timeout: 10000 });
  await page.evaluate((t) => {
    localStorage.removeItem(`hm.view.${t}`);
    window.location.hash = `#/a/${t}`;
  }, conv);
  check(await until(() => page.$('.conv-list .row'), 8000), 'default tab is Conversation when there is a transcript');
  await page.waitForTimeout(400);
  check((await listText(page)).includes('Fixed. An empty password'), 'seeded turn rendered');

  // Appends -> on screen.
  const lat = [];
  for (let i = 0; i < 12; i++) {
    const mark = `append-probe-${Date.now()}-${i}`;
    const t0 = Date.now();
    fs.appendFileSync(file, `${JSON.stringify(asst({ type: 'text', text: `Probe ${mark}` }))}\n`);
    const seenAt = await page.waitForFunction(
      (m) => (document.querySelector('.conv-list')?.textContent?.includes(m) ? Date.now() : 0),
      mark,
      {
        polling: 'raf',
        timeout: 3000,
      },
    );
    lat.push((await seenAt.jsonValue()) - t0);
    await page.waitForTimeout(120);
  }
  check(
    pct(lat, 100) < 1000,
    'transcript append on screen < 1 s',
    `p50 ${pct(lat, 50)} ms, p95 ${pct(lat, 95)} ms, max ${pct(lat, 100)} ms (n=${lat.length})`,
  );
  check(
    await page.evaluate(() => {
      const el = document.querySelector('.conv-scroll');
      return el && el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }),
    'follows the end while at the end',
  );

  // Composer -> terminal -> fake agent -> transcript -> bubble.
  const text = `hello from the phone ${Date.now() % 10000}`;
  const t1 = Date.now();
  await page.fill('.composer textarea', text);
  await page.click('.composer .send-btn, .composer button[type=submit]');
  const bubbleAt = await until(async () => ((await listText(page)).includes(text) ? Date.now() : 0), 8000, 10);
  check(bubbleAt, 'composer send reaches the agent and comes back as a bubble', bubbleAt ? `${bubbleAt - t1} ms` : '');
  const workingSeen = await until(() => page.$('.working-row'), 3000, 20);
  check(workingSeen, 'working row while the agent works');
  const replyAt = await until(async () => ((await listText(page)).includes(`You said ${text}`) ? Date.now() : 0), 8000, 20);
  check(replyAt, 'agent reply (tool card + markdown) shows', replyAt ? `${replyAt - t1} ms after send` : '');
  await until(async () => !(await page.$('.working-row')), 4000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'conversation-iphone-synthetic.png') });

  // Blocked on a permission: the waiting tool card is marked, the approve bar reads the menu, one tap answers.
  await page.fill('.composer textarea', 'needs permission please');
  await page.click('.composer .send-btn');
  const bar = await until(async () => {
    const el = await page.$('.approve-btn.primary');
    return el && /^1\s*Yes/.test(((await el.textContent()) ?? '').trim()) ? el : null;
  }, 8000);
  const waitingCard = await page.$('.tool.is-waiting');
  check(bar && waitingCard, 'blocked: approve bar reads the menu, the waiting tool card is marked');
  await page.screenshot({ path: path.join(out, 'conversation-iphone-blocked.png') });
  if (bar) {
    await page.click('.approve-btn.primary');
    const answered = await until(
      async () => !(await page.$('.tool.is-waiting')) && (await listText(page)).includes('You said needs permission please'),
      8000,
    );
    check(answered, 'one tap answers it and the turn goes on');
  }
  await until(async () => !(await page.$('.working-row')), 4000);

  // Scrolled up: hold still, count new messages, jump back.
  await page.evaluate(() => {
    const el = document.querySelector('.conv-scroll');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);
  const topBefore = await page.evaluate(() => document.querySelector('.conv-scroll').scrollTop);
  fs.appendFileSync(file, `${JSON.stringify(asst({ type: 'text', text: 'While you were reading above.' }))}\n`);
  const pill = await until(async () => {
    const el = await page.$('.jump-pill');
    return el && /new/.test((await el.textContent()) ?? '') ? el : null;
  }, 3000);
  const pillText = pill ? await pill.textContent() : '';
  const topAfter = await page.evaluate(() => document.querySelector('.conv-scroll').scrollTop);
  check(
    pill && /new/.test(pillText ?? '') && Math.abs(topAfter - topBefore) < 4,
    'scrolled up: stays put, pill counts new',
    `pill "${pillText}"`,
  );
  await page.screenshot({ path: path.join(out, 'conversation-iphone-scrolled.png') });
  await pill?.click();
  check(
    await until(() =>
      page.evaluate(() => {
        const el = document.querySelector('.conv-scroll');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }),
    ),
    'jump pill goes back to the latest',
  );

  // Tab memory.
  await page.click('.segmented button:first-child');
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await page.waitForTimeout(400);
  await page.evaluate((t) => {
    window.location.hash = `#/a/${t}`;
  }, conv);
  check(await until(() => page.$('.term-host'), 4000), 'remembers Terminal for this agent');
  await page.click('.segmented button:nth-child(2)');
  await ctx.close();

  const dctx = await browser.newContext(desk);
  const dpage = await dctx.newPage();
  await dpage.goto(`${base}/#token=${encodeURIComponent(token)}&/a/${conv}/conversation`);
  await dpage.waitForSelector('.conv-list .row', { timeout: 10000 });
  await dpage.waitForTimeout(600);
  await dpage.screenshot({ path: path.join(out, 'conversation-desktop-synthetic.png') });
  await dctx.close();

  // ---- a real agent, read only ----
  const w = await world();
  const rank = { done: 0, idle: 1, working: 2, blocked: 3 };
  const real =
    process.env.REAL_AGENT ??
    Object.values(w.terminals)
      .filter((t) => t.transcript && t.paneId && t.id !== conv)
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0]?.id;
  if (!real) fail('a real agent with a transcript');
  else {
    const t = w.terminals[real];
    console.log('real agent', real, t.label, t.status, t.transcript);
    // Independent read of the file: the last prompts and the last reply.
    const lines = fs.readFileSync(t.transcript, 'utf8').trim().split('\n');
    const prompts = [];
    let lastReply = null;
    for (const l of lines) {
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e.isSidechain) continue;
      if (e.type === 'user' && !e.isMeta && typeof e.message?.content === 'string' && !e.message.content.trimStart().startsWith('<'))
        prompts.push(e.message.content.trim());
      if (e.type === 'assistant' && Array.isArray(e.message?.content))
        for (const b of e.message.content) if (b.type === 'text' && b.text.trim()) lastReply = b.text.trim();
    }
    for (const [name, opts] of [
      ['iphone', phone],
      ['desktop', desk],
    ]) {
      const c = await browser.newContext(opts);
      const p = await c.newPage();
      p.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
      await p.goto(`${base}/#token=${encodeURIComponent(token)}&/a/${encodeURIComponent(real)}/conversation`);
      await p.waitForSelector('.conv-list .row', { timeout: 10000 });
      await p.waitForTimeout(1200);
      await p.screenshot({ path: path.join(out, `conversation-${name}.png`) });
      if (name === 'iphone') {
        const bubbles = await p.$$eval('.msg-user .bubble', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        const shownPrompts = prompts.slice(-bubbles.length);
        const norm = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
        const matched = bubbles.filter((b) =>
          shownPrompts.some((pr) => norm(pr).startsWith(norm(b).slice(0, 60)) || norm(b).startsWith(norm(pr).slice(0, 60))),
        );
        check(
          bubbles.length > 0 && matched.length === bubbles.length,
          'real agent: prompts match the transcript',
          `${matched.length}/${bubbles.length} bubbles`,
        );
        const text = await listText(p);
        const words = (s) =>
          s
            .replace(/[*_`#>|[\]()-]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
        const replyWords = words(lastReply ?? '');
        const probe = replyWords.slice(0, 8).join(' ');
        check(probe && words(text).join(' ').includes(probe), 'real agent: last reply matches the transcript', `"${probe}"`);
        // The terminal: Claude Code draws the same reply (markdown rendered, wrapped); look for a run of its words.
        const screen = words(hcJson('read', real, '--lines', '400').text).join(' ');
        let best = 0;
        for (let i = 0; i + 6 <= replyWords.length; i += 3) if (screen.includes(replyWords.slice(i, i + 6).join(' '))) best++;
        const tries = Math.max(1, Math.floor((replyWords.length - 6) / 3) + 1);
        check(best > 0, 'real agent: last reply is on the terminal too', `${best}/${tries} six-word runs found in hc read`);
      }
      await c.close();
    }
  }
} catch (e) {
  fail('script', e.stack ?? String(e));
} finally {
  await browser.close();
  if (!process.env.KEEP) {
    try {
      hc('kill', conv);
    } catch {}
    try {
      hc('rm', conv);
    } catch {}
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
