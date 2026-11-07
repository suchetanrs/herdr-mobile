// Renders the PWA icons from Herdr's logo (packages/web/public/app/herdr.svg, Apache-2.0) with Playwright's Chromium.
// usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = path.resolve('packages/web/public/app');
const svg = fs.readFileSync(path.join(dir, 'herdr.svg'), 'utf8');
const ram = svg.match(/<path id="ram" d="([^"]+)"/)?.[1];
if (!ram) throw new Error('no ram path in herdr.svg');
const logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
// Monochrome ram for Android's status-bar badge (alpha only).
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 896 896"><path d="${ram}" transform="translate(-80 967) scale(.22 -.22)" fill="#fff"/></svg>`;

const jobs = [
  { file: 'favicon-32.png', size: 32, html: `<img src="${logo}" style="width:100%;height:100%">` },
  { file: 'icon-192.png', size: 192, html: `<img src="${logo}" style="width:100%;height:100%">` },
  { file: 'icon-512.png', size: 512, html: `<img src="${logo}" style="width:100%;height:100%">` },
  // Maskable: the tile inside the safe zone, on Herdr's chrome color.
  { file: 'maskable-512.png', size: 512, bg: '#101114', html: `<img src="${logo}" style="width:76%;height:76%;margin:12%">` },
  { file: 'apple-touch-icon.png', size: 180, bg: '#101114', html: `<img src="${logo}" style="width:84%;height:84%;margin:8%">` },
  { file: 'badge-96.png', size: 96, html: badge.replace('<svg ', '<svg style="width:100%;height:100%" ') },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const j of jobs) {
  await page.setViewportSize({ width: j.size, height: j.size });
  await page.setContent(
    `<html><body style="margin:0;background:${j.bg ?? 'transparent'};width:${j.size}px;height:${j.size}px;overflow:hidden">${j.html}</body></html>`,
  );
  await page.waitForTimeout(50);
  await page.screenshot({ path: path.join(dir, j.file), omitBackground: !j.bg });
  console.log('wrote', j.file);
}
await browser.close();
