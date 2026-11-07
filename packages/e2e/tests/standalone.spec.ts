import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { DIAG_FILE, E2E_TOKEN, E2E_URL, readState, signInLink } from '../lib/env.js';
import { expect, test } from './fixtures.js';

// The home-screen app (iOS "Add to Home Screen", Android "Install"): display-mode standalone and, on iOS,
// navigator.standalone. iOS only raises its keyboard for a focus made inside the tap itself, so every
// text field must get focus during the touch's own events, never later.
const state = readState();
const link = (hash = '') => signInLink(E2E_URL, E2E_TOKEN, hash);

/** Emulates the home-screen app, and records every focus with the input event being dispatched at the time. */
async function standalonePage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => {
      if (!/display-mode:\s*standalone/.test(q)) return real(q);
      const mq = real('(min-width: 0px)');
      return new Proxy(mq, {
        get: (t, k) => {
          if (k === 'matches') return true;
          if (k === 'media') return q;
          const v = Reflect.get(t, k, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }) as MediaQueryList;
    };
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    const w = window as Window & {
      __dispatching?: string | null;
      __focus?: Array<{ el: string; during: string | null }>;
      __events?: string[];
    };
    w.__dispatching = null;
    w.__focus = [];
    w.__events = [];
    let n = 0;
    const types = ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'];
    for (const type of types) {
      // The first listener of each input event marks the task it runs in; a 0 ms timer queued now runs right after
      // this task, before any timer, frame or later task the page queues from its handlers. So a focus that sees
      // the mark happened in the tap's own task (its listeners, their microtasks or the browser's default action).
      window.addEventListener(
        type,
        () => {
          const mine = ++n;
          w.__dispatching = type;
          w.__events?.push(type);
          setTimeout(() => {
            if (n === mine) w.__dispatching = null;
          }, 0);
        },
        { capture: true },
      );
    }
    document.addEventListener(
      'focusin',
      (e) => {
        const el = e.target as HTMLElement;
        w.__focus?.push({ el: el.className || el.tagName, during: w.__dispatching ?? null });
      },
      { capture: true },
    );
  });
}

const focusLog = (page: Page) =>
  page.evaluate(() => (window as Window & { __focus?: Array<{ el: string; during: string | null }> }).__focus ?? []);
const clearFocusLog = (page: Page) =>
  page.evaluate(() => {
    (window as Window & { __focus?: unknown[] }).__focus = [];
  });

/** A real tap (touch on phones) on `selector`; returns the focus events it caused. */
async function tapAndLog(page: Page, selector: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await clearFocusLog(page);
  await page.locator(selector).tap();
  return focusLog(page);
}

/** Plays a one-finger touch from (x0, y) to (x1, y) on `selector` (or the document) as bare touch events. */
async function fakeSwipe(page: Page, selector: string | null, x0: number, x1: number, y: number) {
  await page.evaluate(
    ({ selector, x0, x1, y }) => {
      const target = (selector ? document.querySelector(selector) : document.body) as Element;
      const touch = (x: number) => ({ identifier: 7, clientX: x, clientY: y, target });
      const fire = (type: string, x: number, down: boolean) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'touches', { value: down ? [touch(x)] : [] });
        Object.defineProperty(e, 'changedTouches', { value: [touch(x)] });
        target.dispatchEvent(e);
      };
      fire('touchstart', x0, true);
      fire('touchend', x1, false);
    },
    { selector, x0, x1, y },
  );
}

test.beforeEach(({ browserName: _ }, info) => {
  test.skip(!info.project.use.hasTouch, 'phones only (home-screen app)');
});

test('home-screen app: emulated, and the edge swipe back is armed but never starts on a text field', async ({ page }) => {
  await standalonePage(page);
  await page.goto(link(`#/a/${encodeURIComponent(state.conv)}/conversation`));
  await expect(page.locator('.conv-list')).toBeVisible();
  expect(await page.evaluate(() => window.matchMedia('(display-mode: standalone)').matches)).toBe(true);
  expect(await page.evaluate(() => (navigator as Navigator & { standalone?: boolean }).standalone)).toBe(true);
  const box = await page.locator('.composer-input').boundingBox();
  const y = Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2);
  // A swipe right that starts on the chat input (even at the very edge) stays on the agent.
  await fakeSwipe(page, '.composer-input', 6, 180, y);
  await page.waitForTimeout(300);
  expect(page.url()).toMatch(/#\/a\//);
  // The same swipe from the edge of the conversation goes back: the handler is armed in this mode.
  await fakeSwipe(page, '.conv-list', 6, 180, 300);
  await expect.poll(() => page.url()).not.toMatch(/#\/a\//);
});

for (const view of ['conversation', 'terminal'] as const) {
  test(`home-screen app: a tap on the ${view} tab's chat input focuses it inside the touch`, async ({ page }) => {
    await standalonePage(page);
    const id = view === 'conversation' ? state.conv : state.shell;
    await page.goto(link(`#/a/${encodeURIComponent(id)}/${view}`));
    await expect(page.locator(view === 'conversation' ? '.conv-list' : '.xterm')).toBeVisible();
    const url = page.url();
    for (let i = 0; i < 3; i++) {
      const log = await tapAndLog(page, '.composer-input');
      // One focus, on the input, in the touchend of the tap itself (before iOS's synthesized mouse events).
      expect(log).toEqual([{ el: 'composer-input', during: 'touchend' }]);
      expect(await page.evaluate(() => document.activeElement?.classList.contains('composer-input'))).toBe(true);
      await page.waitForTimeout(400);
      // Still focused once the viewport logic settled; no edge swipe or navigation happened.
      expect(await page.evaluate(() => document.activeElement?.classList.contains('composer-input'))).toBe(true);
      expect(page.url()).toBe(url);
    }
  });
}

test('home-screen app: the terminal keyboard button focuses the terminal inside its tap, typing mode on', async ({ page }) => {
  await standalonePage(page);
  await page.goto(link(`#/a/${encodeURIComponent(state.shell)}/terminal`));
  await expect(page.locator('.xterm')).toBeVisible();
  // A touch on the grid can leave xterm's field focused with no keyboard (inputmode none) first.
  await page.locator('.term-host').tap();
  await clearFocusLog(page);
  await page.locator('.keybar .key-icon').tap();
  const log = await focusLog(page);
  expect(log.at(-1)?.during).toBe('click');
  const ta = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { label: a?.getAttribute('aria-label'), mode: a?.getAttribute('inputmode') };
  });
  expect(ta).toEqual({ label: 'Terminal input', mode: 'text' });
  await page.locator('.keybar .key-icon').tap();
});

test('diagnostics: #diag turns it on, a tap is recorded with what was under the finger, Send now reaches the bridge', async ({
  page,
}) => {
  await standalonePage(page);
  const before = fs.existsSync(DIAG_FILE) ? fs.readFileSync(DIAG_FILE, 'utf8').length : 0;
  await page.goto(link(`#diag&/a/${encodeURIComponent(state.conv)}/conversation`));
  await expect(page.locator('.conv-list')).toBeVisible();
  expect(page.url()).not.toContain('diag');
  await expect(page.locator('.diag-badge')).toBeVisible();
  await page.locator('.composer-input').tap();
  await page.locator('.composer-input').fill('typed words that must stay private');
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await expect(page.getByText('This page’s build')).toBeVisible();
  await expect(page.getByText('(same)')).toBeVisible();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText(/Sent to the bridge/)).toBeVisible();
  await expect.poll(() => (fs.existsSync(DIAG_FILE) ? fs.readFileSync(DIAG_FILE, 'utf8').length : 0)).toBeGreaterThan(before);
  const text = fs.readFileSync(DIAG_FILE, 'utf8').slice(before);
  expect(text).not.toContain('typed words');
  expect(text).not.toContain(E2E_TOKEN);
  expect(text).toContain('"standalone":true');
  expect(text).toMatch(/"k":"touchend","t":\d+,"tg":"[^"]*textarea\.composer-input\[Message\]"/);
  // A diagnostics switch off again: no badge.
  await page.goto(`${E2E_URL}/#diag-off`);
  await page.reload();
  await expect(page.locator('.diag-badge')).toHaveCount(0);
});

test('keyboard test page: served, no app code', async ({ page }) => {
  const r = await page.goto(`${E2E_URL}/app/keyboard-test.html`);
  expect(r?.status()).toBe(200);
  await expect(page.locator('textarea')).toHaveCount(2);
  expect(await page.locator('script').count()).toBe(0);
});
