import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  APP_LINES,
  DIAG_FILE,
  E2E_BLOCK_MS,
  E2E_MAX_FAILURES,
  E2E_TOKEN,
  E2E_URL,
  HIST_LINES,
  hc,
  hcJson,
  LOG_FILE,
  REPO,
  readState,
  SHELL_NAME,
  screenText,
  signInLink,
  sizeOf,
  startInstance,
  stopInstance,
  until,
} from '../lib/env.js';
import { expect, listedSpaces, live, test } from './fixtures.js';

// The e2e instance: same production build, loopback only, unplaced (throwaway) terminals shown, seen sync off.
// Only the throwaway terminals hm-e2e-sh (bash) and hm-e2e-conv (scripts/fake-agent.py) are ever opened or typed into.
const state = readState();
const auth = { authorization: `Bearer ${E2E_TOKEN}` };
const link = (hash = '') => signInLink(E2E_URL, E2E_TOKEN, hash);
const agentHash = (id: string, view?: string) => `#/a/${encodeURIComponent(id)}${view ? `/${view}` : ''}`;

async function openAgent(page: Page, id: string, view?: 'terminal' | 'conversation') {
  await page.goto(link(agentHash(id, view)));
  await expect(
    page.locator(view === 'conversation' ? '.conv-list' : view === 'terminal' ? '.xterm' : '.xterm, .conv-list').first(),
  ).toBeVisible();
}

/**
 * What the page's terminal shows. Phones use xterm's DOM renderer (text in .xterm-rows); desktop (DPR 1) draws with
 * WebGL on a canvas, so there the terminal's own screen (`hc read`) stands in.
 */
async function terminalText(page: Page, id: string): Promise<string> {
  if ((await page.locator('.xterm-rows').count()) > 0) return (await page.locator('.xterm-rows').first().textContent()) ?? '';
  await expect(page.locator('.xterm canvas').first()).toBeVisible();
  return screenText(id);
}

async function send(page: Page, text: string) {
  await page.locator('.composer-input').fill(text);
  await page.locator('.send-btn').click();
}

test.describe.configure({ mode: 'serial' });

test('sign-in link (#token=) signs this device in and leaves no token anywhere; spaces list matches /api/world', async ({
  page,
  context,
  request,
}) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  page.on('websocket', (ws) => requests.push(`WS ${ws.url()}`));
  await page.goto(link());
  await live(page);
  expect(page.url()).not.toContain('token');
  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toEqual(['hm_session']);
  expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false });
  expect(cookies[0]?.value).not.toContain(E2E_TOKEN);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(E2E_TOKEN);
  expect(requests.join('\n')).not.toContain(E2E_TOKEN);
  expect(requests).toContain(`POST ${E2E_URL}/api/session`);
  expect(requests).toContain(`WS ${E2E_URL.replace('http', 'ws')}/ws`);
  const getWorld = async () => (await (await request.get(`${E2E_URL}/api/world`, { headers: auth })).json()).world;
  await expect.poll(async () => Boolean((await getWorld()).terminals[state.shell])).toBe(true);
  const world = await getWorld();
  const names = (world.spaceOrder as string[]).map((id) => world.spaces[id].name as string);
  // Throwaways are in no pane: the app lists them under its made-up "Not in a space".
  await expect.poll(async () => (await listedSpaces(page)).sort()).toEqual([...names, 'Not in a space'].sort());
});

test('navigate to a space, then an agent; its terminal renders', async ({ page }) => {
  await page.goto(link());
  await live(page);
  await page.locator('.space-row, .space-line', { hasText: 'Not in a space' }).first().click();
  await expect(page).toHaveURL(/#\/s\//);
  await page.locator('.rows').getByText(SHELL_NAME, { exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/a/${state.shell}`));
  await expect(page.locator('.xterm').first()).toBeVisible();
  await expect.poll(() => terminalText(page, state.shell)).toContain('$');
});

test('typing reaches the throwaway terminal and echoes back', async ({ page }, info) => {
  await openAgent(page, state.shell, 'terminal');
  const tag = `E2E${info.project.name.toUpperCase()}`;
  // The shell computes the marker, so seeing it proves the bytes ran there (not just the local echo).
  await send(page, `echo ${tag}$((40+2))`);
  await expect.poll(() => terminalText(page, state.shell), { timeout: 8000 }).toContain(`${tag}42`);
  expect(screenText(state.shell)).toContain(`${tag}42`);
  if (info.project.name === 'desktop') {
    // Desktop: type straight into the terminal.
    await page.locator('.xterm').first().click();
    await page.keyboard.type(`echo DESK$((20+22))`);
    await page.keyboard.press('Enter');
    await expect.poll(() => screenText(state.shell), { timeout: 8000 }).toContain('DESK42');
  }
});

/** Records the quick keys the page sends to the bridge (term.keys requests), from before the app loads. */
async function recordKeys(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __keys: string[] };
    w.__keys = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data) {
      if (typeof data === 'string' && data.includes('"term.keys"')) w.__keys.push(data);
      return send.call(this, data);
    };
  });
}
const sentKeys = (page: Page) => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys.length);

/**
 * A finger dragged sideways across the quick-key bar, starting on `key`. Chromium: real touch input (CDP), so the
 * browser pans the bar itself. WebKit has no touch-drag API: the events a pan produces are replayed (pointerdown,
 * moves, the bar scrolling under the finger, then the harshest ending: pointerup + click rather than pointercancel).
 */
async function dragKeyBar(page: Page, key: string, dx: number) {
  const box = await page.locator('.keybar .key', { hasText: key }).boundingBox();
  if (!box) throw new Error(`no ${key} key`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (page.context().browser()?.browserType().name() === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y }] });
    await touch('touchStart', x);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', x - (dx * i) / 12);
      await page.waitForTimeout(16);
    }
    await touch('touchEnd', x - dx);
    await cdp.detach();
    return;
  }
  await page.evaluate(
    ({ key, x, y, dx }) => {
      const bar = document.querySelector('.keybar') as HTMLElement;
      const btn = [...bar.querySelectorAll('.key')].find((b) => b.textContent === key) as HTMLElement;
      const p = (type: string, px: number) =>
        btn.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 9,
            pointerType: 'touch',
            isPrimary: true,
            clientX: px,
            clientY: y,
          }),
        );
      p('pointerdown', x);
      for (let i = 1; i <= 12; i++) {
        p('pointermove', x - (dx * i) / 12);
        bar.scrollLeft += dx / 12;
        bar.dispatchEvent(new Event('scroll'));
      }
      p('pointerup', x - dx);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    },
    { key, x, y, dx },
  );
}

test('quick keys: a tap on ^C interrupts a running command', async ({ page }, info) => {
  await openAgent(page, state.shell, 'terminal');
  await expect(page.locator('.keybar')).toBeVisible();
  await send(page, 'sleep 30');
  await expect.poll(() => screenText(state.shell)).toContain('sleep 30');
  await page.waitForTimeout(300);
  const cc = page.locator('.keybar .key', { hasText: '^C' });
  if (info.project.use.hasTouch) await cc.tap();
  else await cc.click();
  await expect.poll(() => /sleep 30\s*\n?\^C/.test(screenText(state.shell)), { timeout: 5000 }).toBe(true);
});

test('quick keys: dragging sideways across the bar scrolls it and presses nothing; a tap still presses', async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, 'touch only');
  await recordKeys(page);
  await openAgent(page, state.shell, 'terminal');
  const bar = page.locator('.keybar');
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((b) => b.scrollWidth > b.clientWidth)).toBe(true);
  await send(page, 'sleep 30');
  await expect.poll(() => screenText(state.shell)).toContain('sleep 30');
  await page.waitForTimeout(300);
  const before = screenText(state.shell);
  // Start on ^C and pan the bar left: the old bar pressed ^C on touch-down.
  await dragKeyBar(page, '^C', 160);
  await expect.poll(() => bar.evaluate((b) => b.scrollLeft)).toBeGreaterThan(20);
  await page.waitForTimeout(800);
  expect(await sentKeys(page)).toBe(0);
  expect(screenText(state.shell)).toBe(before);
  // Back the other way, starting on an arrow (a repeating key).
  await dragKeyBar(page, '←', -160);
  await page.waitForTimeout(800);
  expect(await sentKeys(page)).toBe(0);
  expect(screenText(state.shell)).toBe(before);
  // A real tap still presses, and the bar never took focus from the composer.
  await page.locator('.composer-input').tap();
  await page.locator('.keybar .key', { hasText: '^C' }).tap();
  await expect.poll(() => /sleep 30\s*\n?\^C/.test(screenText(state.shell)), { timeout: 5000 }).toBe(true);
  expect(await sentKeys(page)).toBe(1);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('composer-input'))).toBe(true);
});

/** Drives window.visualViewport by hand (as the phone keyboard would): no event unless `fire`. */
async function fakeViewport(page: Page, height: number | null, fire: boolean) {
  await page.evaluate(
    ({ height, fire }) => {
      const vv = window.visualViewport as VisualViewport & { __h?: number | null };
      if (!('__h' in vv)) {
        const proto = Object.getPrototypeOf(vv);
        const real = Object.getOwnPropertyDescriptor(proto, 'height')?.get;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => vv.__h ?? real?.call(vv) });
        Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
      }
      vv.__h = height;
      if (fire) vv.dispatchEvent(new Event('resize'));
    },
    { height, fire },
  );
}
/** px of empty space under the input bar (0 = flush with the bottom of the screen). */
const gapUnderBar = (page: Page) =>
  page.evaluate(() =>
    Math.round(window.innerHeight - (document.querySelector('.agent-input') as HTMLElement).getBoundingClientRect().bottom),
  );
const barBottom = (page: Page) =>
  page.evaluate(() => Math.round((document.querySelector('.agent-input') as HTMLElement).getBoundingClientRect().bottom));

test('keyboard: the input bar rides up with it and comes back to the bottom when it closes', async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, 'phones only');
  await openAgent(page, state.shell, 'terminal');
  const input = page.locator('.composer-input');
  await expect(input).toBeVisible();
  expect(await gapUnderBar(page)).toBe(0);
  const full = await page.evaluate(() => window.innerHeight);
  const kb = Math.round(full * 0.55);
  const html = page.locator('html');

  for (let round = 0; round < 3; round++) {
    // Keyboard opens: focus, then the visual viewport shrinks.
    await input.tap();
    await fakeViewport(page, kb, true);
    await expect(html).toHaveAttribute('data-keyboard', 'up');
    await expect.poll(() => barBottom(page)).toBe(kb);
    // A quick key keeps the field focused (keyboard stays up, bar stays put).
    await page.locator('.keybar .key', { hasText: '⇧tab' }).tap();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('composer-input'))).toBe(true);
    expect(await barBottom(page)).toBe(kb);
    if (round === 1) {
      // Android-style: the keyboard hides with the field still focused; the viewport grows back and says so.
      await fakeViewport(page, null, true);
      await expect.poll(() => gapUnderBar(page)).toBe(0);
      await expect(html).toHaveAttribute('data-keyboard', 'down');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    } else {
      // iOS-style: the field blurs and no visualViewport event follows; the viewport even still reads short.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect.poll(() => gapUnderBar(page), { timeout: 2000 }).toBe(0);
      await expect(html).toHaveAttribute('data-keyboard', 'down');
      await fakeViewport(page, null, false);
    }
  }
  // Focus moving between two fields while the keyboard is up: the bar never drops in between.
  await input.tap();
  await fakeViewport(page, kb, true);
  await expect.poll(() => barBottom(page)).toBe(kb);
  const drops = await page.evaluate(async () => {
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(document.documentElement.dataset.keyboard ?? ''));
    mo.observe(document.documentElement, { attributes: true });
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    await new Promise((r) => setTimeout(r, 1000));
    (document.querySelector('.composer-input') as HTMLElement).focus();
    await new Promise((r) => setTimeout(r, 1000));
    mo.disconnect();
    other.remove();
    return seen.filter((s) => s === 'down').length;
  });
  expect(drops).toBe(0);
  expect(await barBottom(page)).toBe(kb);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await fakeViewport(page, null, false);
  await expect.poll(() => gapUnderBar(page), { timeout: 2000 }).toBe(0);
});

test('conversation tab renders the synthetic transcript and follows it live', async ({ page }, info) => {
  await openAgent(page, state.conv);
  // Default tab is Conversation when the agent has a transcript.
  await expect(page).toHaveURL(/\/conversation$|#\/a\/[^/]+$/);
  await expect(page.locator('.conv-list')).toContainText('E2E seeded prompt: say hello');
  await expect(page.locator('.conv-list')).toContainText('Hello from the seeded transcript.');
  const said = `ping ${info.project.name} ${Date.now() % 100000}`;
  await send(page, said);
  // The fake agent reads it from its terminal and writes the reply to the transcript.
  await expect(page.locator('.conv-list')).toContainText(`You said ${said}`, { timeout: 15_000 });
});

test('in-page alert toast via the test button (Settings)', async ({ page }) => {
  await page.goto(link('#/settings'));
  await page.getByRole('button', { name: 'Test alert' }).click();
  await expect(page.locator('.toast', { hasText: 'This is how an alert looks' })).toBeVisible();
});

test('settings: the theme follows the choice, and sticks', async ({ page }) => {
  await page.goto(link('#/settings'));
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'System', exact: true }).click();
  // The suite runs with a dark color scheme.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('settings: diagnostics records events while on and sends them to the bridge without typed text', async ({ page }) => {
  const size = () => (fs.existsSync(DIAG_FILE) ? fs.readFileSync(DIAG_FILE, 'utf8').length : 0);
  const before = size();
  await page.goto(link('#/settings'));
  await live(page);
  await page.getByRole('checkbox', { name: /Record events/ }).check();
  await page.goto(`${E2E_URL}/${agentHash(state.conv, 'conversation')}`);
  await expect(page.locator('.conv-list')).toBeVisible();
  await page.locator('.composer-input').fill('typed words that must stay private');
  await page.goto(`${E2E_URL}/#/settings`);
  await page.getByRole('button', { name: 'Send to bridge' }).click();
  await expect(page.getByText(/Sent to the bridge/)).toBeVisible();
  await expect.poll(size).toBeGreaterThan(before);
  const text = fs.readFileSync(DIAG_FILE, 'utf8').slice(before);
  expect(text).not.toContain('typed words');
  expect(text).not.toContain(E2E_TOKEN);
  expect(text).toContain('"k":"start"');
  expect(text).toContain('"k":"nav"');
  await page.getByRole('checkbox', { name: /Record events/ }).uncheck();
  await expect(page.getByRole('button', { name: 'Send to bridge' })).toHaveCount(0);
});

test.describe('on a light system', () => {
  test.use({ colorScheme: 'light' });

  const graphite = async (page: Page) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 17, 20)');
    expect(await page.locator('meta[name="theme-color"]').evaluateAll((m) => m.map((e) => e.getAttribute('content')))).toEqual(['#101114']);
  };

  test('dark (graphite) is the default on first load and after a reload; a picked Light still sticks', async ({ page }) => {
    // The page as served, before any script: graphite already.
    const served = await (await page.request.get(E2E_URL)).text();
    expect(served).toContain('<html lang="en" data-theme="dark">');
    expect(served).toContain('<meta name="color-scheme" content="dark" />');
    await page.goto(link('#/settings'));
    await live(page);
    await graphite(page);
    await page.reload();
    await graphite(page);
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(241, 241, 238)');
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await graphite(page);
  });
});

/** The history row at the top of the terminal's view, and where it is. */
async function topRow(page: Page): Promise<{ text: string; y: number } | null> {
  return page.evaluate(() => {
    const h = document.querySelector('.term-host') as HTMLElement;
    const r = h.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + 30, r.top + 4)?.closest('.th-row');
    return el ? { text: el.textContent ?? '', y: Math.round(el.getBoundingClientRect().top - r.top) || 0 } : null;
  });
}

/** Scrolls the way a person does (a wheel/touch is theirs) so the oldest loaded row is at the top of the view. */
async function scrollToOldest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = document.querySelector('.term-host') as HTMLElement;
    h.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    const first = document.querySelector('.th-body .th-row');
    if (first) h.scrollTop += first.getBoundingClientRect().top - h.getBoundingClientRect().top;
  });
}

const histNumbers = (rows: string[]) => rows.flatMap((t) => (/^hist (\d{5})/.exec(t) ? [Number(t.slice(5, 10))] : []));

test('terminal history: scrolling up loads older pages to the oldest line herdr-core kept, in order, without jumps', async ({ page }) => {
  const size0 = sizeOf(state.hist);
  await openAgent(page, state.hist, 'terminal');
  await expect(page.locator('.th-body .th-row').first()).toBeAttached();
  // Opening loads only the snapshot's rows; the rest waits for the person to scroll up.
  expect(await page.locator('.th-row').count()).toBeLessThan(400);
  // What herdr-core holds for this terminal (main screen: a plain read).
  const kept = histNumbers((hcJson('read', state.hist, '--lines', '100000').text as string).split('\n'));
  expect(kept.length).toBeGreaterThan(1000);
  expect(kept.at(-1)).toBe(HIST_LINES);
  const status = page.locator('.th-status');
  for (let i = 0; i < 40 && !(await status.textContent())?.startsWith('Start of history'); i++) {
    const rows = await page.locator('.th-row').count();
    await scrollToOldest(page);
    // WebKit delivers the scroll a frame later.
    await expect.poll(() => topRow(page)).not.toBeNull();
    const before = await topRow(page);
    await expect
      .poll(async () => (await page.locator('.th-row').count()) > rows || (await status.textContent())?.startsWith('Start of history'))
      .toBe(true);
    // The page went in above the view: the row at the top stayed where it was.
    expect(await topRow(page)).toEqual(before);
  }
  await expect(status).toHaveText(/^Start of history/);
  const shown = histNumbers(await page.locator('.th-row').allTextContents());
  // Every line herdr-core kept (the bridge may hold a few more it dropped since), once, in order, ending above the screen.
  expect(shown[0]).toBeLessThanOrEqual(kept[0] ?? 0);
  expect(shown.every((n, i) => i === 0 || n === (shown[i - 1] ?? 0) + 1)).toBe(true);
  expect(shown.at(-1)).toBeGreaterThan(HIST_LINES - 200);
  // Colors kept.
  await expect(page.locator('.th-row span[style*="--th-c"]').first()).toBeAttached();

  // Live output still lands while the person reads the top: below them, the view doesn't move.
  const top = await topRow(page);
  const tag = `tail${Date.now() % 100000}`;
  hc('send', state.hist, `seq -f '${tag} %g' 1 300`);
  await expect(page.locator('.th-row', { hasText: `${tag} 150` })).toBeAttached({ timeout: 15_000 });
  expect(await topRow(page)).toEqual(top);
  const tails = (await page.locator('.th-row').allTextContents())
    .filter((t) => t.startsWith(`${tag} `))
    .map((t) => Number(t.split(' ')[1]));
  expect(tails[0]).toBe(1);
  expect(tails.every((n, i) => i === 0 || n === (tails[i - 1] ?? 0) + 1)).toBe(true);
  // Read only: the terminal's size never changed.
  expect(sizeOf(state.hist)).toBe(size0);
});

test('terminal history: a finger scrolls it natively, and quick flicks never zoom', async ({ page }, info) => {
  test.skip(info.project.name !== 'android', 'touch input (CDP) is Chromium only');
  await openAgent(page, state.hist, 'terminal');
  await expect(page.locator('.th-body .th-row').first()).toBeAttached();
  const host = page.locator('.term-host');
  const box = await host.boundingBox();
  if (!box) throw new Error('no terminal');
  const rowH = () => page.evaluate(() => (document.querySelector('.xterm-screen') as HTMLElement).offsetHeight);
  const h0 = await rowH();
  const top0 = await host.evaluate((h) => h.scrollTop);
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + 60;
  for (let k = 0; k < 4; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 50 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await expect.poll(() => host.evaluate((h) => h.scrollTop)).toBeLessThan(top0 - 1000);
  // Following stopped (the person scrolled), older rows loading as they go up; no zoom.
  await expect(page.locator('.follow-pill')).toBeVisible();
  expect(await rowH()).toBe(h0);
});

test("terminal history: a full-screen app's own history is read on request (herdr-core scrolls it and back)", async ({ page }) => {
  const size0 = sizeOf(state.app);
  const screen0 = screenText(state.app);
  await openAgent(page, state.app, 'terminal');
  const note = page.locator('.th-alt');
  await expect(note).toContainText('Full-screen app');
  await expect(page.locator('.th-app .th-row')).toHaveCount(0);
  await note.getByRole('button', { name: 'Read earlier output' }).click();
  await expect(note).toHaveAttribute('data-state', 'read', { timeout: 30_000 });
  const rows = await page.locator('.th-app .th-row').allTextContents();
  // Everything above less's screen, in order; the screen itself isn't repeated.
  const nums = rows.map((t) => Number(/^app line (\d+)$/.exec(t)?.[1] ?? Number.NaN));
  expect(nums[0]).toBe(1);
  expect(nums.every((n, i) => i === 0 || n === (nums[i - 1] ?? 0) + 1)).toBe(true);
  expect(screen0).toContain(`app line ${(nums.at(-1) ?? 0) + 1}`);
  expect(nums.at(-1)).toBeLessThan(APP_LINES);
  // Put back where it was (less redraws its prompt line as plain "(END)" after a scroll), same size.
  const body = (t: string) => t.split('\n').filter((l) => l.startsWith('app line'));
  await expect.poll(() => body(screenText(state.app))).toEqual(body(screen0));
  expect(sizeOf(state.app)).toBe(size0);
});

test('terminal text as plain text: select and copy', async ({ page }) => {
  await openAgent(page, state.shell, 'terminal');
  await send(page, 'echo SHEET$((3*3))');
  await expect.poll(() => screenText(state.shell)).toContain('SHEET9');
  await page.getByRole('button', { name: 'Select and copy text' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.text-sheet-pre')).toContainText('SHEET9');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
});

test('a blocked agent is answered from the inbox with one tap (its own numbered menu)', async ({ page }) => {
  await page.goto(link());
  await live(page);
  const card = page.locator('.space-card.sec-blocked', { hasText: 'Not in a space' });
  const yes = card.locator('.inline-answer .approve-btn', { hasText: 'Yes' }).first();
  await expect(yes).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.inline-answer')).toContainText('Do you want to proceed?');
  const before = (screenText(state.ask).match(/ANSWERED/g) ?? []).length;
  await yes.click();
  await expect.poll(() => (screenText(state.ask).match(/ANSWERED '1'/g) ?? []).length, { timeout: 8000 }).toBeGreaterThan(0);
  expect((screenText(state.ask).match(/ANSWERED/g) ?? []).length).toBe(before + 1);
});

test('the answer card shows only in the Conversation view, never over the terminal', async ({ page }) => {
  await openAgent(page, state.ask, 'terminal');
  await expect.poll(() => screenText(state.ask)).toContain('Do you want to proceed?');
  // Blocked, screen read (the composer knows), yet no card: the terminal is answered on the terminal itself.
  await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', 'Answer or message');
  await page.waitForTimeout(800);
  await expect(page.locator('.approve')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Conversation' }).click();
  const card = page.locator('.agent-input .approve');
  await expect(card.locator('.approve-q')).toHaveText('Do you want to proceed?');
  await expect(card.locator('.approve-detail')).toContainText('rm -rf build');
  await expect(card.locator('.approve-btn.primary')).toHaveText(/Yes$/);
  await expect(card.locator('.approve-btn', { hasText: "Yes, and don't ask again for rm" })).toBeVisible();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.locator('.xterm').first()).toBeVisible();
  await expect(page.locator('.approve')).toHaveCount(0);
});

test('new space: folders, completion and Herdr’s agents; a bad folder is refused inline (nothing is started)', async ({ page }, info) => {
  test.skip(!REPO.startsWith(`${os.homedir()}/`), 'the checkout is not in the home folder');
  const runsBefore = fs.existsSync(LOG_FILE) ? (fs.readFileSync(LOG_FILE, 'utf8').match(/new space started/g) ?? []).length : 0;
  await page.goto(link());
  await live(page);
  if (info.project.name === 'desktop') await page.getByRole('button', { name: 'New space' }).first().click();
  else await page.locator('.topbar').getByRole('button', { name: 'New space' }).click();
  await expect(page).toHaveURL(/#\/new$/);
  const form = page.locator('.ns-page');
  await expect(form.getByRole('button', { name: /Terminal/ })).toHaveAttribute('aria-pressed', 'true');
  // The agents come from the same table and check as Herdr's + menu (Claude Code is installed here).
  await expect(form.getByRole('button', { name: /Claude Code/ })).toBeEnabled({ timeout: 15_000 });
  const folder = form.getByLabel('Folder', { exact: true });
  // Completion of this checkout's folder (as ~/...), typed without its last three letters.
  const repo = `~/${path.relative(os.homedir(), REPO)}`;
  await folder.fill(repo.slice(0, -3));
  await expect(page.getByRole('option', { name: `${repo}/` })).toBeVisible();
  await page.getByRole('option', { name: `${repo}/` }).click();
  await expect(folder).toHaveValue(`${repo}/`);
  await folder.fill('~/../../etc');
  await form.getByRole('button', { name: 'Create space' }).click();
  await expect(form.locator('.ns-error')).toHaveText('Pick a folder in your home folder');
  await folder.fill('~/hm-e2e-no-such-folder');
  await form.getByRole('button', { name: 'Create space' }).click();
  await expect(form.locator('.ns-error')).toHaveText('No such folder');
  await expect(folder).toHaveAttribute('aria-invalid', 'true');
  const runsAfter = fs.existsSync(LOG_FILE) ? (fs.readFileSync(LOG_FILE, 'utf8').match(/new space started/g) ?? []).length : 0;
  expect(runsAfter).toBe(runsBefore);
});

test('space +: Terminal | Claude session, then New | Resume and the folder’s sessions; refused requests start nothing', async ({
  page,
  request,
}) => {
  // Read only: a real local space is opened and its + menu looked at; nothing in it is tapped to start.
  const startedBefore = fs.existsSync(LOG_FILE) ? (fs.readFileSync(LOG_FILE, 'utf8').match(/new tab started/g) ?? []).length : 0;
  const world = (await (await request.get(`${E2E_URL}/api/world`, { headers: auth })).json()).world;
  const spaceId = (world.spaceOrder as string[]).find((id) => world.spaces[id].machine === null && /^sp[0-9a-f]{32}$/.test(id));
  test.skip(!spaceId, 'no local space open');
  await page.goto(link(`#/s/${spaceId}`));
  await page.getByRole('button', { name: 'New tab' }).click();
  const menu = page.getByRole('dialog', { name: 'New tab' });
  await expect(menu.getByRole('button', { name: /^Terminal/ })).toBeVisible();
  await expect(menu.getByText(/^A shell in /)).toBeVisible();
  await menu.getByRole('button', { name: /Claude session/ }).click();
  const claude = page.getByRole('dialog', { name: 'Claude session' });
  await expect(claude.getByRole('button', { name: /New session/ })).toBeVisible();
  await expect(claude.getByRole('button', { name: /Resume session/ })).toContainText(/in this folder|None in this folder/);
  await claude.getByRole('button', { name: /Resume session/ }).click();
  const list = page.getByRole('dialog', { name: 'Resume a session' });
  await expect(list.locator('.add-session, .add-empty').first()).toBeVisible();
  await list.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('dialog', { name: 'Claude session' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const listing = await request.get(`${E2E_URL}/api/spaces/${spaceId}/sessions`, { headers: auth });
  expect(listing.status()).toBe(200);
  const sessions = (await listing.json()) as { folder: string; sessions: Array<{ id: string }> };
  expect(sessions.folder.startsWith('/')).toBe(true);
  for (const s of sessions.sessions) expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const post = (space: string, start: unknown) =>
    request.post(`${E2E_URL}/api/spaces/${space}/tabs`, { headers: { ...auth, 'content-type': 'application/json' }, data: { start } });
  expect((await post(`sp${'0'.repeat(32)}`, { kind: 'shell' })).status()).toBe(404);
  expect((await post(spaceId as string, { kind: 'resume', session: 'not-a-session' })).status()).toBe(400);
  expect((await post(spaceId as string, { kind: 'resume', session: '00000000-0000-4000-8000-000000000000' })).status()).toBe(400);
  expect((await post(spaceId as string, { kind: 'exec', argv: ['true'] })).status()).toBe(400);
  const startedAfter = fs.existsSync(LOG_FILE) ? (fs.readFileSync(LOG_FILE, 'utf8').match(/new tab started/g) ?? []).length : 0;
  expect(startedAfter).toBe(startedBefore);
});

test('reconnects after the bridge restarts', async ({ page }) => {
  test.setTimeout(60_000);
  let sockets = 0;
  page.on('websocket', () => sockets++);
  await page.goto(link());
  await live(page);
  // Not mid-download of a lazy chunk (the inbox streams the blocked fake agent's terminal unseen).
  await page.waitForLoadState('networkidle');
  const before = sockets;
  await stopInstance();
  await expect(page.locator('.conn.conn-down').first()).toBeAttached({ timeout: 15_000 });
  await startInstance();
  await expect.poll(() => sockets, { timeout: 20_000 }).toBeGreaterThan(before);
  await live(page);
  // Same page, no reload: open the shell in-app; its stream works over the new connection.
  await page.evaluate(
    (h) => {
      window.location.hash = h;
    },
    agentHash(state.shell, 'terminal'),
  );
  await expect(page.locator('.xterm').first()).toBeVisible();
  await send(page, 'echo BACK$((1+1))');
  await expect.poll(() => terminalText(page, state.shell), { timeout: 10_000 }).toContain('BACK2');
});

test('failed sign-ins are rate-limited per address (signed-in devices never are), then let through again', async ({ request }) => {
  const attempt = (token: string) =>
    fetch(`${E2E_URL}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const signedIn = await attempt(E2E_TOKEN);
  const cookie = (signedIn.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
  for (let i = 0; i < E2E_MAX_FAILURES; i++) expect((await attempt('wrong')).status).toBe(401);
  const blocked = await attempt(E2E_TOKEN);
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await request.get(`${E2E_URL}/api/world`, { headers: { cookie } })).status()).toBe(200);
  const unblocked = await until(async () => (await attempt('wrong')).status === 401, E2E_BLOCK_MS + 3000, 200);
  expect(unblocked).toBeTruthy();
});

test('Settings lists this device; signing it out shows the sign-in screen; pasting the link signs in again', async ({ page }) => {
  await page.goto(link('#/settings'));
  await live(page);
  const mine = page.locator('.setting.device', { hasText: 'this device' });
  await expect(mine).toBeVisible();
  await expect(mine.locator('.setting-hint')).toContainText('127.0.0.1');
  await mine.getByRole('button', { name: 'Sign out this device' }).click();
  await expect(page.locator('.token-screen')).toBeVisible({ timeout: 10_000 });
  expect((await page.context().cookies()).find((c) => c.name === 'hm_session')).toBeUndefined();
  await page.getByLabel('Token').fill(link());
  await page.getByRole('button', { name: 'Connect' }).click();
  await live(page);
  await expect(page.locator('.token-screen')).toHaveCount(0);
});

test.afterAll(() => {
  // The phone and desktop viewers never resized the terminal.
  expect(sizeOf(state.shell)).toBe(state.shellSize);
  // The token never reaches the log.
  expect(fs.readFileSync(LOG_FILE, 'utf8')).not.toContain(E2E_TOKEN);
});
