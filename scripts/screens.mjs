// Screenshots of the running bridge's web app at phone and desktop sizes (read only: never types or clicks keys).
// usage: node scripts/screens.mjs <out-dir> [base-url]   (token from HERDR_MOBILE_TOKEN or ~/.config/herdr-mobile/token)
// Run the bridge with HERDR_MOBILE_SEEN_SYNC=0 so looking at agents doesn't mark them seen on the desktop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const out = path.resolve(process.argv[2] ?? 'screens');
const base = process.argv[3] ?? 'http://127.0.0.1:8787';
const token = process.env.HERDR_MOBILE_TOKEN ?? fs.readFileSync(path.join(os.homedir(), '.config/herdr-mobile/token'), 'utf8').trim();
const only = process.env.SHOTS?.split(',');
fs.mkdirSync(out, { recursive: true });

const headers = { authorization: `Bearer ${token}` };
const world = (await (await fetch(`${base}/api/world`, { headers })).json()).world;
const spaces = world.spaceOrder.map((id) => world.spaces[id]);
const terms = Object.values(world.terminals);
// The busiest space, and an agent in it (working first), for the deeper screens.
const rank = { blocked: 4, done: 3, working: 2, idle: 1 };
const space = [...spaces].sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0) || b.tabIds.length - a.tabIds.length)[0];
const agent =
  process.env.AGENT ??
  terms.filter((t) => t.spaceId === space?.id && t.status).sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0))[0]?.id ??
  terms[0]?.id;

const viewports = [
  { name: 'iphone', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'android', width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const routes = [
  { name: 'spaces', hash: '#/' },
  { name: 'space', hash: `#/s/${encodeURIComponent(space?.id ?? '')}` },
  { name: 'agent', hash: `#/a/${encodeURIComponent(agent ?? '')}` },
  { name: 'alerts', hash: '#/alerts' },
];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const vp of viewports) {
  if (only && !only.some((o) => vp.name.startsWith(o))) continue;
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    colorScheme: process.env.SCHEME ?? 'dark',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${vp.name}] console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[${vp.name}] pageerror: ${e.message}`));
  await page.goto(`${base}/#token=${encodeURIComponent(token)}`);
  await page.waitForSelector('.screen, .desktop', { timeout: 10000 });
  for (const r of routes) {
    await page.evaluate((h) => {
      window.location.hash = h;
    }, r.hash);
    await page.waitForTimeout(r.name === 'agent' ? 2500 : 900);
    const file = path.join(out, `${vp.name}-${r.name}${process.env.SCHEME === 'light' ? '-light' : ''}.png`);
    await page.screenshot({ path: file });
    console.log('shot', path.relative(process.cwd(), file));
  }
  await ctx.close();
}
await browser.close();
