import type { Locator, Page } from '@playwright/test';
import { E2E_TOKEN, E2E_URL, readState, signInLink } from '../lib/env.js';
import { expect, test } from './fixtures.js';

// Sheets and forms with a text field, with the phone keyboard emulated the way app.spec's keyboard test does it:
// the visual viewport shrinks (by hand) while the layout viewport stays (iOS never resizes it for the keyboard).
const state = readState();
const link = (hash = '') => signInLink(E2E_URL, E2E_TOKEN, hash);

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

/** Whether the element is entirely inside the visual viewport (the part of the screen the keyboard leaves). */
const inView = (el: Locator) =>
  el.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const vv = window.visualViewport as VisualViewport;
    return r.height > 0 && r.top >= vv.offsetTop - 0.5 && r.bottom <= vv.offsetTop + vv.height + 0.5;
  });
/** px between the element's bottom and the bottom of the screen (0 = flush). */
const gapUnder = (el: Locator) => el.evaluate((e) => Math.round(window.innerHeight - e.getBoundingClientRect().bottom));
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/**
 * Makes the e2e conversation terminal (a fake agent) look like a Claude Code agent in a space, so its ⋯ menu offers
 * Branch out. Only the page's copy of the world is changed; the sheet is closed without creating anything.
 */
async function branchableConv(page: Page) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const fix = (t: Record<string, unknown>, spaceId: string) => ({
      ...t,
      program: 'claude',
      machine: null,
      spaceId: t.spaceId ?? spaceId,
      transcript: '/e2e/00000000-0000-4000-8000-000000000000.jsonl',
    });
    let spaceId = '';
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      try {
        const msg = JSON.parse(m);
        if (msg.t === 'snapshot' && msg.world?.terminals?.[state.conv]) {
          spaceId = msg.world.spaceOrder?.[0] ?? '';
          msg.world.terminals[state.conv] = fix(msg.world.terminals[state.conv], spaceId);
          return ws.send(JSON.stringify(msg));
        }
        if (msg.t === 'patch' && Array.isArray(msg.ops)) {
          for (const o of msg.ops) if (o.op === 'terminal' && o.value?.id === state.conv) o.value = fix(o.value, spaceId);
          return ws.send(JSON.stringify(msg));
        }
      } catch {}
      ws.send(m);
    });
    ws.onMessage((m) => server.send(m));
  });
}

async function openBranchSheet(page: Page) {
  await branchableConv(page);
  await page.goto(link(`#/a/${encodeURIComponent(state.conv)}/conversation`));
  await expect(page.locator('.conv-list').first()).toBeVisible();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Branch out from this conversation/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Branch out' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('keyboard: the Branch out sheet rides above it (name field + Create visible) and is back at the bottom after', async ({
  page,
}, info) => {
  test.skip(!info.project.use.hasTouch, 'phones only');
  const sheet = await openBranchSheet(page);
  const input = sheet.getByRole('textbox', { name: 'Name of the new conversation' });
  const create = sheet.getByRole('button', { name: 'Create' });
  await expect.poll(() => gapUnder(sheet)).toBe(0);
  const kb = Math.round((await page.evaluate(() => window.innerHeight)) * 0.55);

  for (let round = 0; round < 2; round++) {
    await input.tap();
    await expect(input).toBeFocused();
    await fakeViewport(page, kb, true);
    await expect.poll(() => inView(input)).toBe(true);
    await expect.poll(() => inView(create)).toBe(true);
    // Its bottom sits on the keyboard, not under it.
    await expect.poll(() => sheet.evaluate((e) => Math.round(e.getBoundingClientRect().bottom))).toBe(kb);
    if (round === 0) {
      // iOS: the field blurs and no visualViewport event follows (it even still reads short).
      await blur(page);
      await expect.poll(() => gapUnder(sheet), { timeout: 2000 }).toBe(0);
      await fakeViewport(page, null, false);
    } else {
      // Android: the keyboard hides with the field still focused; the viewport grows back and says so.
      await fakeViewport(page, null, true);
      await expect.poll(() => gapUnder(sheet)).toBe(0);
      await blur(page);
    }
  }
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keyboard: New space keeps the focused field and Create space visible above it, and comes back down after', async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, 'phones only');
  await page.goto(link('#/new'));
  const form = page.locator('.ns-page');
  const create = form.getByRole('button', { name: 'Create space' });
  const app = page.locator('.app');
  await expect(create).toBeVisible();
  const kb = Math.round((await page.evaluate(() => window.innerHeight)) * 0.55);

  for (const label of ['Folder', 'Name']) {
    const input = form.getByLabel(label, { exact: true });
    await input.scrollIntoViewIfNeeded();
    await input.tap();
    await expect(input).toBeFocused();
    await fakeViewport(page, kb, true);
    await expect.poll(() => inView(input), { message: label }).toBe(true);
    await expect.poll(() => inView(create), { message: label }).toBe(true);
    // The button doesn't cover the field.
    const [f, b] = await Promise.all([input.boundingBox(), create.boundingBox()]);
    expect((f?.y ?? 0) + (f?.height ?? 0)).toBeLessThanOrEqual(b?.y ?? 0);
    // iOS-style close: blur, no visualViewport event.
    await blur(page);
    await expect.poll(() => gapUnder(app), { timeout: 2000 }).toBe(0);
    await fakeViewport(page, null, false);
    await expect(form.locator('.ns-actions')).toHaveCSS('position', 'static');
  }
});

test('desktop: sheets and New space are unchanged while typing (centred dialog, Create space in the page)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop only');
  const sheet = await openBranchSheet(page);
  const input = sheet.getByRole('textbox', { name: 'Name of the new conversation' });
  await expect(input).toBeFocused();
  const box = await page.locator('.sheet-backdrop').boundingBox();
  const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  expect(box).toEqual({ x: 0, y: 0, width: w, height: h });
  // Centred once its entrance animation is over.
  await expect
    .poll(async () => {
      const d = await sheet.boundingBox();
      return Math.round(Math.abs((d?.y ?? 0) + (d?.height ?? 0) / 2 - h / 2));
    })
    .toBeLessThan(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New space' }).first().click();
  await expect(page.locator('.ns-page').getByRole('button', { name: 'Create space' })).toBeVisible();
  await page.locator('.ns-page').getByLabel('Folder', { exact: true }).focus();
  await expect(page.locator('.ns-actions')).toHaveCSS('position', 'static');
});
