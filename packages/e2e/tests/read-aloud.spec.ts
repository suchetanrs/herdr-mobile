import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_TOKEN, E2E_URL, MULTI_MESSAGES, READ_ALOUD_REPLY, readState, signInLink } from '../lib/env.js';
import { expect, test } from './fixtures.js';

// Read aloud with a recording speechSynthesis put in before the page loads, and copy in a page that says it is not
// a secure context (as a phone on plain HTTP is): the copy must take the execCommand path with the exact markdown.
const state = readState();
const link = (hash = '') => signInLink(E2E_URL, E2E_TOKEN, hash);

const SENTENCES = [
  'Read-aloud check.',
  'First sentence is here.',
  'Second sentence has a link text and ends here!',
  'Third one asks a question?',
  'List item one.',
  'List item two.',
  'Final sentence after the code.',
];

interface Spoken {
  text: string;
  rate: number;
  voice: string | null;
  /** navigator.userActivation.isActive when speak() was called (null where the browser has no such API). */
  inTap: boolean | null;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const spoken: unknown[] = [];
    w.__spoken = spoken;
    w.__cancels = 0;
    class Utterance {
      rate = 1;
      lang = '';
      voice: { voiceURI: string } | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    let current: Utterance | null = null;
    const synth = {
      speaking: false,
      pending: false,
      getVoices: () => [
        { voiceURI: 'mock-a', name: 'Mock A', lang: 'en-US', localService: true, default: true },
        { voiceURI: 'mock-b', name: 'Mock B', lang: 'en-GB', localService: false, default: false },
      ],
      speak(u: Utterance) {
        const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        spoken.push({ text: u.text, rate: u.rate, voice: u.voice?.voiceURI ?? null, inTap: ua ? ua.isActive : null });
        current = u;
        synth.speaking = true;
      },
      cancel() {
        w.__cancels = (w.__cancels as number) + 1;
        const u = current;
        current = null;
        synth.speaking = false;
        if (u) setTimeout(() => u.onerror?.({ error: 'interrupted' }), 0);
      },
      pause() {
        w.__nativePause = true;
      },
      resume() {
        w.__nativeResume = true;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    w.__finish = () => {
      const u = current;
      current = null;
      synth.speaking = false;
      u?.onend?.();
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: Utterance });
    // Plain HTTP on a phone: not a secure context. Record what execCommand('copy') copies, and any Clipboard API use.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    if (navigator.clipboard) {
      navigator.clipboard.writeText = () => {
        w.__clipboardApi = true;
        return Promise.reject(new Error('not here'));
      };
    }
    const exec = document.execCommand.bind(document);
    document.execCommand = (cmd: string, ...rest: unknown[]) => {
      const ok = exec(cmd, ...(rest as [boolean, string]));
      if (cmd === 'copy') {
        const el = document.activeElement as HTMLTextAreaElement | null;
        w.__copied = el && 'value' in el ? el.value.slice(el.selectionStart, el.selectionEnd) : String(getSelection());
        w.__copyOk = ok;
      }
      return ok;
    };
  });
});

const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: Spoken[] }).__spoken);
const lastSpoken = async (page: Page) => (await spoken(page)).at(-1);
const finish = (page: Page) => page.evaluate(() => (window as unknown as { __finish: () => void }).__finish());
/** The sentence marked in the reply: the CSS highlight's text (or the marked paragraph's where that's missing). */
const highlighted = (page: Page) =>
  page.evaluate(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
    const h = reg?.get('hm-speech');
    if (h) return [...h][0]?.toString() ?? null;
    return document.querySelector('.speak-block')?.textContent ?? null;
  });

async function openReply(page: Page, signedIn = false) {
  const hash = `#/a/${encodeURIComponent(state.conv)}/conversation`;
  await page.goto(signedIn ? `${E2E_URL}/${hash}` : link(hash));
  const reply = page.locator('.msg-agent', { hasText: 'Final sentence after the code.' });
  // Earlier specs' chats append to the seeded transcript: the reply can be past the first page.
  const older = page.getByRole('button', { name: 'Load earlier messages' });
  await expect(page.locator('.conv-list')).toContainText('E2E seeded prompt');
  for (let i = 0; i < 5 && !(await reply.count()) && (await older.count()); i++) {
    await older.click();
    await expect(page.locator('.conv-older[disabled]')).toHaveCount(0);
  }
  await expect(reply).toBeVisible();
  await reply.scrollIntoViewIfNeeded();
  return reply;
}

test('read aloud: sentence by sentence, next/prev/pause/resume/speed, highlight follows, code never spoken', async ({ page }, info) => {
  const reply = await openReply(page);
  await reply.getByRole('button', { name: 'Read the reply aloud' }).click();
  const dock = page.getByRole('region', { name: 'Read aloud' });
  await expect(dock).toBeVisible();
  await expect.poll(() => spoken(page)).toHaveLength(1);
  const first = await lastSpoken(page);
  expect(first).toMatchObject({ text: SENTENCES[0], rate: 1 });
  // Spoken inside the tap (iOS refuses speech that doesn't start from one).
  expect(first?.inTap).not.toBe(false);
  await expect(dock).toContainText(`1 / ${SENTENCES.length}`);
  await expect.poll(() => highlighted(page)).toMatch(/^Read-aloud check/);
  for (const [i, h] of [
    [1, 'First sentence is here'],
    [2, 'Second sentence has a link text and ends here'],
  ] as const) {
    await finish(page);
    await expect.poll(async () => (await lastSpoken(page))?.text).toBe(SENTENCES[i]);
    await expect.poll(() => highlighted(page)).toMatch(new RegExp(`^${h}`));
    await expect(dock).toContainText(`${i + 1} / ${SENTENCES.length}`);
  }
  await dock.getByRole('button', { name: 'Next sentence' }).click();
  await expect.poll(async () => (await lastSpoken(page))?.text).toBe(SENTENCES[3]);
  await expect.poll(() => highlighted(page)).toMatch(/^Third one asks a question/);
  if (process.env.E2E_SCREENS) await page.screenshot({ path: path.join(process.env.E2E_SCREENS, `read-aloud-${info.project.name}.png`) });
  await dock.getByRole('button', { name: 'Previous sentence' }).click();
  await expect.poll(async () => (await lastSpoken(page))?.text).toBe(SENTENCES[2]);
  await expect.poll(() => highlighted(page)).toMatch(/^Second sentence/);

  // Pause = cancel (never the native pause); resume speaks the same sentence again.
  const cancels = await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels);
  const n = (await spoken(page)).length;
  await dock.getByRole('button', { name: 'Pause' }).click();
  await expect(dock.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels)).toBeGreaterThan(cancels);
  await page.waitForTimeout(150);
  expect(await spoken(page)).toHaveLength(n);
  await expect.poll(() => highlighted(page)).toMatch(/^Second sentence/);
  await dock.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => spoken(page)).toHaveLength(n + 1);
  expect((await lastSpoken(page))?.text).toBe(SENTENCES[2]);

  // Speed: 1× -> 1.25× restarts the sentence at the new speed; it cycles 1.5×, 2×, back to 1×.
  await dock.getByRole('button', { name: 'Reading speed 1×' }).click();
  await expect.poll(async () => (await lastSpoken(page))?.rate).toBe(1.25);
  expect((await lastSpoken(page))?.text).toBe(SENTENCES[2]);
  await dock.getByRole('button', { name: 'Reading speed 1.25×' }).click();
  await dock.getByRole('button', { name: 'Reading speed 1.5×' }).click();
  await expect.poll(async () => (await lastSpoken(page))?.rate).toBe(2);
  await dock.getByRole('button', { name: 'Reading speed 2×' }).click();
  await expect(dock.getByRole('button', { name: 'Reading speed 1×' })).toBeVisible();

  // To the end: the code block is never spoken.
  for (let i = 3; i < SENTENCES.length; i++) {
    await finish(page);
    await expect.poll(async () => (await lastSpoken(page))?.text).toBe(SENTENCES[i]);
  }
  await finish(page);
  await expect(dock).toContainText('Done');
  const all = (await spoken(page)).map((s) => s.text);
  expect(all.join(' ')).not.toMatch(/SECRET|echo|```|\*\*|##|https?:/);
  expect(new Set(all)).toEqual(new Set(SENTENCES));
  expect(await page.evaluate(() => (window as unknown as { __nativePause?: boolean }).__nativePause)).toBeUndefined();

  await dock.getByRole('button', { name: 'Close the player' }).click();
  await expect(dock).toHaveCount(0);
});

test('read aloud stops on a screen change and when the page is hidden, and resumes at the same sentence', async ({ page }) => {
  const reply = await openReply(page);
  await reply.getByRole('button', { name: 'Read the reply aloud' }).click();
  await finish(page);
  await expect.poll(async () => (await lastSpoken(page))?.text).toBe(SENTENCES[1]);
  const cancels = await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cancels: number }).__cancels)).toBeGreaterThan(cancels);
  const n = (await spoken(page)).length;
  await page.getByRole('tab', { name: 'Conversation' }).click();
  const dock = page.getByRole('region', { name: 'Read aloud' });
  await expect(dock.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(dock).toContainText(`2 / ${SENTENCES.length}`);
  expect(await spoken(page)).toHaveLength(n);
  await dock.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await lastSpoken(page))?.text).toBe(SENTENCES[1]);

  // Page hidden (phone locked, app switched): paused.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(dock.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(dock).toContainText(`2 / ${SENTENCES.length}`);
});

test('copy puts the reply exactly as written (markdown) on the clipboard over plain HTTP, via execCommand', async ({ page }) => {
  const reply = await openReply(page);
  await reply.getByRole('button', { name: 'Copy the reply' }).click();
  await expect(reply.getByRole('status')).toHaveText('Copied');
  const got = await page.evaluate(() => {
    const w = window as unknown as { __copied?: string; __copyOk?: boolean; __clipboardApi?: boolean };
    return { copied: w.__copied, ok: w.__copyOk, api: w.__clipboardApi ?? false, secure: window.isSecureContext };
  });
  expect(got).toEqual({ copied: READ_ALOUD_REPLY, ok: true, api: false, secure: false });
});

test('a turn with several messages: the speaker and copy under each message act on that message only', async ({ page }) => {
  await openReply(page);
  const said = [
    ['Got it.', 'Option 1: check the files first.'],
    ['The files look fine.', 'Running the tests next.'],
    ['All tests pass.', 'The final answer is here.'],
  ];
  // The highlight may stop before a full stop that follows bold text (another text node): compare without it.
  const head = (t = '') => new RegExp(`^${t.replace(/[.!?]$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const dock = page.getByRole('region', { name: 'Read aloud' });
  for (let i = MULTI_MESSAGES.length - 1; i >= 0; i--) {
    const msg = page.locator('.msg-agent', { hasText: said[i]?.[1] as string });
    await expect(msg).toHaveCount(1);
    await msg.scrollIntoViewIfNeeded();
    const before = (await spoken(page)).length;
    await msg.getByRole('button', { name: 'Read the reply aloud' }).click();
    await expect(dock).toContainText('1 / 2');
    await expect.poll(async () => (await lastSpoken(page))?.text).toBe(said[i]?.[0]);
    await expect.poll(() => highlighted(page)).toMatch(head(said[i]?.[0]));
    await finish(page);
    await expect.poll(async () => (await lastSpoken(page))?.text).toBe(said[i]?.[1]);
    await expect.poll(() => highlighted(page)).toMatch(head(said[i]?.[1]));
    await finish(page);
    await expect(dock).toContainText('Done');
    expect((await spoken(page)).slice(before).map((s) => s.text)).toEqual(said[i]);
    await msg.getByRole('button', { name: 'Copy the reply' }).click();
    await expect(msg.getByRole('status')).toHaveText('Copied');
    expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(MULTI_MESSAGES[i]);
  }
});

test('settings: the read-aloud voice is picked, tested and remembered on this device', async ({ page }) => {
  await page.goto(link('#/settings'));
  const select = page.getByRole('combobox', { name: /Read aloud voice/ });
  await expect(select.locator('option')).toHaveCount(3);
  await select.selectOption('mock-b');
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect.poll(async () => (await lastSpoken(page))?.voice).toBe('mock-b');
  await page.reload();
  await expect(page.getByRole('combobox', { name: /Read aloud voice/ })).toHaveValue('mock-b');
  // The reply is then read with that voice.
  const reply = await openReply(page, true);
  await reply.getByRole('button', { name: 'Read the reply aloud' }).click();
  await expect.poll(async () => (await lastSpoken(page))?.voice).toBe('mock-b');
  await page.getByRole('region', { name: 'Read aloud' }).getByRole('button', { name: 'Close the player' }).click();
  await page.goto(`${E2E_URL}/#/settings`);
  await page.getByRole('combobox', { name: /Read aloud voice/ }).selectOption('');
});
