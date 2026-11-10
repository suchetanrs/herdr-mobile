import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_TOKEN, E2E_URL, signInLink, WORK } from '../lib/env.js';
import { expect, live, test } from './fixtures.js';

// The file browser on the e2e bridge (the user's own home folder, read only). Downloads use files made here
// under .test-tmp/e2e/files; nothing outside it is written.
const link = (hash = '') => signInLink(E2E_URL, E2E_TOKEN, hash);
const FILES = path.join(WORK, 'files');
const NAME = 'hello wörld (1).bin';
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
const SHOTS = process.env.E2E_SHOTS;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fs.rmSync(FILES, { recursive: true, force: true });
  fs.mkdirSync(path.join(FILES, 'inner folder'), { recursive: true });
  fs.writeFileSync(path.join(FILES, NAME), BYTES);
  fs.writeFileSync(path.join(FILES, 'notes.dat'), 'plain notes\n');
  fs.writeFileSync(path.join(FILES, '.hidden-file'), 'hidden\n');
  fs.writeFileSync(path.join(FILES, 'inner folder', 'deep.txt'), 'deep\n');
});
test.afterAll(() => fs.rmSync(FILES, { recursive: true, force: true }));

async function openFiles(page: Page, project: string) {
  await page.goto(link());
  await live(page);
  // No folder remembered from an earlier test: start at home.
  await page.evaluate(() => {
    localStorage.removeItem('hm.files.dir');
    localStorage.removeItem('hm.files.hidden');
  });
  const button =
    project === 'desktop'
      ? page.locator('.sb-head').getByRole('button', { name: 'Files' })
      : page.locator('.topbar').getByRole('button', { name: 'Files' });
  if (project !== 'desktop') {
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await button.click();
  await expect(page).toHaveURL(/#\/files$/);
}

const bar = (page: Page) => page.getByLabel('Path', { exact: true });
const row = (page: Page, name: string) =>
  page
    .locator('.fs-row')
    .filter({ has: page.locator('.fs-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

async function go(page: Page, typed: string) {
  await bar(page).fill(typed);
  await bar(page).press('Enter');
}

test('folder icon -> home -> into a folder -> crumb back -> path bar to a folder and a file (downloads) -> hidden toggle', async ({
  page,
}, info) => {
  test.skip(!WORK.startsWith(`${os.homedir()}/`), 'the checkout is not in the home folder');
  const home = os.homedir();
  const first = path.relative(home, WORK).split(path.sep)[0] as string;
  await openFiles(page, info.project.name);

  // $HOME: the path bar says ~, folders first.
  await expect(bar(page)).toHaveValue('~');
  await expect(row(page, first)).toBeVisible();
  await expect(page.locator('.fs-crumb.on')).toHaveText(path.basename(home));
  const names = await page.locator('.fs-name').allTextContents();
  expect(names.some((n) => n.startsWith('.'))).toBe(false);

  // Into a folder, then back with the crumb for home.
  await row(page, first).click();
  await expect(bar(page)).toHaveValue(`~/${first}`);
  await expect(page.locator('.fs-crumb.on')).toHaveText(first);
  expect((await page.locator('.fs-crumb').allTextContents()).slice(0, 2)).toEqual(['/', home.split('/')[1]]);
  await page.locator('.fs-crumb', { hasText: new RegExp(`^${path.basename(home)}$`) }).click();
  await expect(bar(page)).toHaveValue('~');
  // "/" is a crumb too.
  await page.locator('.fs-crumb', { hasText: /^\/$/ }).click();
  await expect(page.locator('.fs-crumb.on')).toHaveText('/');
  await expect(page.getByRole('button', { name: 'Up one folder' })).toBeDisabled();

  // The path bar: a folder (absolute) opens it.
  await go(page, FILES);
  await expect(row(page, NAME)).toBeVisible();
  await expect(bar(page)).toHaveValue(`~/${path.relative(home, FILES)}`);
  const order = await page.locator('.fs-name').allTextContents();
  expect(order[0]).toBe('inner folder');
  await expect(row(page, NAME).locator('.fs-meta')).toContainText('4.0 KB');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `files-${info.project.name}-folder.png`) });

  // The path bar: a file downloads it (right name, right bytes).
  const viaBar = page.waitForEvent('download');
  await go(page, `~/${path.relative(home, path.join(FILES, NAME))}`);
  const d1 = await viaBar;
  // WebKit on Linux turns spaces in a download's name into "_" itself; the UTF-8 "ö" (filename*) arrives intact.
  expect(info.project.use.browserName === 'webkit' ? d1.suggestedFilename().replace(/_/g, ' ') : d1.suggestedFilename()).toBe(NAME);
  expect(fs.readFileSync(await d1.path()).equals(BYTES)).toBe(true);
  await expect(page.locator('.fs-notice')).toContainText(`Downloading ${NAME}`);
  // A tap on a file row downloads it too.
  const viaRow = page.waitForEvent('download');
  await row(page, 'notes.dat').click();
  const d2 = await viaRow;
  expect(d2.suggestedFilename()).toBe('notes.dat');
  expect(fs.readFileSync(await d2.path(), 'utf8')).toBe('plain notes\n');
  // The page stayed where it was.
  await expect(page).toHaveURL(/#\/files$/);

  // A relative path from the folder shown.
  await go(page, 'inner folder');
  await expect(row(page, 'deep.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Up one folder' }).click();
  await expect(row(page, NAME)).toBeVisible();

  // Hidden files: off, on, off; remembered.
  await expect(row(page, '.hidden-file')).toHaveCount(0);
  await expect(page.locator('.fs-foot')).toContainText('1 hidden');
  await page.getByRole('button', { name: /Hidden/ }).click();
  await expect(row(page, '.hidden-file')).toBeVisible();
  await expect(page.getByRole('button', { name: /Hidden/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Hidden/ }).click();
  await expect(row(page, '.hidden-file')).toHaveCount(0);

  // Errors: missing, and the bridge's own config folder (private even with a session).
  await go(page, '~/hm-e2e-no-such-folder');
  await expect(page.locator('.state-card h3')).toHaveText('Not found');
  await go(page, path.join(WORK, 'cfg'));
  await expect(page.locator('.state-card h3')).toHaveText('Private');
  await page.getByRole('button', { name: 'Back to the folder' }).click();
  await expect(row(page, NAME)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `files-${info.project.name}-hidden-off.png`) });

  // Remembers the folder: leave and come back.
  if (info.project.name === 'desktop') await page.locator('.sb-label-link').click();
  else await page.getByRole('button', { name: 'Back' }).click();
  await expect(page).not.toHaveURL(/#\/files$/);
  await expect(page.locator('.space-row-name, .space-line-name').first()).toBeVisible();
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `files-${info.project.name}-spaces.png`) });
  await (info.project.name === 'desktop' ? page.locator('.sb-head') : page.locator('.topbar'))
    .getByRole('button', { name: 'Files' })
    .click();
  await expect(row(page, NAME)).toBeVisible();
});

test('downloads need the session: a signed-out page gets 401, other sites 403', async ({ request }) => {
  const url = `${E2E_URL}/api/fs/download?path=${encodeURIComponent(path.join(FILES, 'notes.dat'))}`;
  expect((await request.get(url)).status()).toBe(401);
  expect((await request.get(url, { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403);
});

test('git-ignored entries are dimmed (.gitignore, info/exclude, inside an ignored folder, .git), tracked ones not; still navigable', async ({
  page,
}, info) => {
  const repo = path.join(WORK, 'files-git');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(path.join(repo, 'build', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n*.log\n');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'mine.txt\n');
  for (const f of ['build/deep/out.bin', 'debug.log', 'tracked.log', 'mine.txt', 'README.md', 'src/app.ts'])
    fs.writeFileSync(path.join(repo, f), 'x\n');
  git('add', '-f', 'tracked.log', 'README.md');
  try {
    await openFiles(page, info.project.name);
    await page.getByRole('button', { name: /Hidden/ }).click();
    await go(page, repo);
    await expect(row(page, 'README.md')).toBeVisible();
    const dim = async (name: string) => (await row(page, name).getAttribute('class'))?.includes('fs-ignored') ?? false;
    for (const n of ['build', 'debug.log', 'mine.txt', '.git']) expect(await dim(n), n).toBe(true);
    for (const n of ['src', 'README.md', 'tracked.log', '.gitignore']) expect(await dim(n), n).toBe(false);
    const color = (name: string) =>
      row(page, name)
        .locator('.fs-name')
        .evaluate((el) => getComputedStyle(el).color);
    expect(await color('debug.log')).not.toBe(await color('README.md'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `files-${info.project.name}-ignored.png`) });
    await row(page, 'build').click();
    await row(page, 'deep').click();
    await expect(row(page, 'out.bin')).toHaveClass(/fs-ignored/);
    const dl = page.waitForEvent('download');
    await row(page, 'out.bin').click();
    expect((await dl).suggestedFilename()).toBe('out.bin');
  } finally {
    await page.evaluate(() => localStorage.removeItem('hm.files.hidden')).catch(() => {});
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
