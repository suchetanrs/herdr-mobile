import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_TOKEN, E2E_URL, LOG_FILE, signInLink, WORK } from '../lib/env.js';
import { expect, live, test } from './fixtures.js';

// The file viewer: small media/image/pdf/md files made here under .test-tmp/e2e/viewer (video and mp3 with
// ffmpeg; without it those two are skipped), each opened from the Files list.
const DIR = path.join(WORK, 'viewer');
const SHOTS = process.env.E2E_SHOTS;
let ffmpeg = true;

/** A minimal one-page PDF with a line of text (offsets computed, so viewers accept it). */
function tinyPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 100 Td (Hello PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A 1-second 8 kHz mono WAV of a quiet tone. */
function tinyWav(): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 3000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// A 4x3 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGP4z8AARww4OQD1MQv1NXv7ggAAAABJRU5ErkJggg==', 'base64');

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  try {
    const ff = (...a: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: 'ignore', timeout: 60_000 });
    ff(
      ...['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050'],
      ...['-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(DIR, 'clip.mp4')],
    );
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', '2', '-c:a', 'libmp3lame', path.join(DIR, 'tone.mp3'));
  } catch {
    ffmpeg = false;
  }
  fs.writeFileSync(path.join(DIR, 'tone.wav'), tinyWav());
  fs.writeFileSync(path.join(DIR, 'red.png'), PNG);
  fs.writeFileSync(path.join(DIR, 'doc.pdf'), tinyPdf());
  fs.writeFileSync(
    path.join(DIR, 'notes.md'),
    '# Viewer notes\n\nSome **bold** text and a [link](https://example.com).\n\n<script>window.__mdPwned = 1</script>\n\n<img src=x onerror="window.__mdPwned = 2">\n\n```js\nconst x = 1;\n```\n',
  );
  fs.writeFileSync(path.join(DIR, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgPwned = 1</script></svg>');
  fs.writeFileSync(path.join(DIR, 'page.html'), '<!doctype html><script>window.__htmlPwned = 1</script>');
});
test.afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const row = (page: Page, name: string) =>
  page.locator('.fs-row').filter({ has: page.locator('.fs-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });

async function openFolder(page: Page, project: string) {
  await page.goto(signInLink(E2E_URL, E2E_TOKEN));
  await live(page);
  await page.evaluate(() => localStorage.removeItem('hm.files.dir'));
  await (project === 'desktop' ? page.locator('.sb-head') : page.locator('.topbar')).getByRole('button', { name: 'Files' }).click();
  const bar = page.getByLabel('Path', { exact: true });
  await bar.fill(DIR);
  await bar.press('Enter');
  await expect(row(page, 'red.png')).toBeVisible();
}

async function open(page: Page, name: string) {
  await row(page, name)
    .getByRole('button', { name: `Open ${name}` })
    .click();
  await expect(page).toHaveURL(/#\/files\/view\//);
  await expect(page.locator('.file-viewer .fv-title')).toHaveText(name);
}

async function close(page: Page) {
  await page.locator('.file-viewer').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.file-viewer')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/files$/);
}

test('each viewable kind opens in the viewer; video seeks over Range; md renders without scripts; svg/html download', async ({
  page,
}, info) => {
  const project = info.project.name;
  await openFolder(page, project);
  // Download stays one tap away on viewable rows.
  await expect(row(page, 'red.png').getByRole('link', { name: 'Download red.png' })).toBeVisible();

  // Image: fitted, loaded.
  await open(page, 'red.png');
  const img = page.locator('.file-viewer img.fv-img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(4);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `viewer-${project}-image.png`) });
  // Browser back closes the viewer too.
  await page.goBack();
  await expect(page.locator('.file-viewer')).toHaveCount(0);
  await expect(row(page, 'red.png')).toBeVisible();

  // Video: metadata, then a seek; the bridge saw range requests for it.
  if (ffmpeg) {
    const before = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    await open(page, 'clip.mp4');
    const video = page.locator('.file-viewer video');
    await expect(video).toHaveAttribute('playsinline', '');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((v: HTMLVideoElement) => Math.round(v.duration))).toBe(6);
    const at = await video.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<number>((resolve, reject) => {
          v.addEventListener('seeked', () => resolve(v.currentTime), { once: true });
          setTimeout(() => reject(new Error('no seeked event')), 10_000);
          v.currentTime = 4.5;
        }),
    );
    expect(at).toBeGreaterThan(4);
    // A screenshot of a video frame crashes headless WebKit (GStreamer) here; the other engines take one.
    if (SHOTS && info.project.use.browserName !== 'webkit')
      await page.screenshot({ path: path.join(SHOTS, `viewer-${project}-video.png`) });
    await expect
      .poll(() => {
        const log = fs.readFileSync(LOG_FILE).subarray(before).toString();
        return log.split('\n').some((l) => l.includes('"msg":"file view"') && l.includes('clip.mp4') && l.includes('"range"'));
      })
      .toBe(true);
    await close(page);

    await open(page, 'tone.mp3');
    const mp3 = page.locator('.file-viewer audio');
    await expect.poll(() => mp3.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await close(page);
  }

  // Audio (wav).
  await open(page, 'tone.wav');
  const audio = page.locator('.file-viewer audio');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  expect(await audio.evaluate((a: HTMLAudioElement) => Math.round(a.duration))).toBe(1);
  await close(page);

  // PDF: framed in the browser's viewer where there is one; otherwise Open / Download.
  await open(page, 'doc.pdf');
  const pdfViewer = await page.evaluate(() => navigator.pdfViewerEnabled);
  if (pdfViewer) {
    const frame = page.locator('.file-viewer iframe.fv-frame');
    await expect(frame).toHaveAttribute('src', /\/api\/fs\/view\?path=/);
  } else {
    await expect(page.locator('.file-viewer').getByRole('link', { name: 'Open' })).toHaveAttribute('href', /\/api\/fs\/view\?path=/);
    await expect(
      page
        .locator('.file-viewer')
        .getByRole('link', { name: /Download/ })
        .first(),
    ).toBeVisible();
  }
  const pdf = await page.request.get(`${E2E_URL}/api/fs/view?path=${encodeURIComponent(path.join(DIR, 'doc.pdf'))}`);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `viewer-${project}-pdf.png`) });
  await close(page);

  // Markdown: rendered, highlighted, and its <script>/<img onerror> stay text.
  await open(page, 'notes.md');
  await expect(page.locator('.fv-md h1')).toHaveText('Viewer notes');
  await expect(page.locator('.fv-md strong')).toHaveText('bold');
  await expect(page.locator('.fv-md a[href="https://example.com"]')).toHaveAttribute('target', '_blank');
  await expect(page.locator('.fv-md .md-code')).toBeVisible();
  await expect(page.locator('.fv-md')).toContainText('<script>window.__mdPwned = 1</script>');
  expect(await page.locator('.fv-md script, .fv-md img').count()).toBe(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as Window & { __mdPwned?: number }).__mdPwned)).toBeUndefined();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `viewer-${project}-md.png`) });
  await close(page);

  // SVG and HTML are not viewable: their rows download, and never open the viewer.
  for (const name of ['logo.svg', 'page.html']) {
    await expect(row(page, name).getByRole('button', { name: `Open ${name}` })).toHaveCount(0);
    const dl = page.waitForEvent('download');
    await row(page, name).click();
    expect((await dl).suggestedFilename()).toBe(name);
    await expect(page).toHaveURL(/#\/files$/);
  }
  expect(await page.evaluate(() => Object.keys(window).filter((k) => k.endsWith('Pwned')))).toEqual([]);
});

test('the view endpoint: session needed, svg/html never inline', async ({ request }) => {
  const url = (n: string) => `${E2E_URL}/api/fs/view?path=${encodeURIComponent(path.join(DIR, n))}`;
  expect((await request.get(url('red.png'))).status()).toBe(401);
  expect((await request.get(url('red.png'), { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403);
});
