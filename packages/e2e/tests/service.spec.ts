import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { SERVICE_UNIT, SERVICE_URL, serviceToken, signInLink, until } from '../lib/env.js';
import { expect, listedSpaces, live, test } from './fixtures.js';

// The user's production service (systemd, seen sync on). Read-only: these tests stay on the spaces list and
// never open an agent, so nothing is marked seen.
const token = serviceToken();
const auth = { authorization: `Bearer ${token}` };

function serviceActive(): boolean {
  try {
    return execFileSync('systemctl', ['--user', 'is-active', SERVICE_UNIT], { encoding: 'utf8' }).trim() === 'active';
  } catch {
    return false;
  }
}

/** Test browsers sign the service in like a phone: sign them out again so they don't pile up in the device list. */
async function signOut(page: Page): Promise<void> {
  await page.evaluate(() => fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' }));
}

test.describe('production service', () => {
  test.skip(!serviceActive(), `${SERVICE_UNIT} is not running`);

  test('health: core connected, versions', async ({ request }) => {
    const pub = await (await request.get(`${SERVICE_URL}/api/health`)).json();
    expect(pub).toEqual({ ok: true });
    const h = await (await request.get(`${SERVICE_URL}/api/health`, { headers: auth })).json();
    expect(h).toMatchObject({ ok: true, status: 'ok', core: { connected: true } });
    expect(h.core.version).toMatch(/^\d+\.\d+/);
    expect(h.bridge).toMatchObject({ protocol: 1, conversationProtocol: 1 });
    expect(h.bridge.node).toMatch(/^v22\./);
    expect(JSON.stringify(h)).not.toContain(token);
  });

  test('PWA manifest, icons and service worker are served', async ({ request }) => {
    const m = await request.get(`${SERVICE_URL}/manifest.webmanifest`);
    expect(m.status()).toBe(200);
    expect(m.headers()['content-type']).toContain('application/manifest+json');
    const manifest = await m.json();
    expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
    for (const icon of manifest.icons as Array<{ src: string }>) {
      const r = await request.get(`${SERVICE_URL}${icon.src}`);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()['content-type']).toBe('image/png');
    }
    expect((await request.get(`${SERVICE_URL}/app/apple-touch-icon.png`)).status()).toBe(200);
    const sw = await request.get(`${SERVICE_URL}/sw.js`);
    expect(sw.status()).toBe(200);
    expect(sw.headers()['content-type']).toContain('javascript');
  });

  test('data needs the token; pages carry security headers', async ({ request }) => {
    expect((await request.get(`${SERVICE_URL}/api/world`)).status()).toBe(401);
    expect((await request.get(`${SERVICE_URL}/api/world`, { headers: auth })).status()).toBe(200);
    const page = await request.get(`${SERVICE_URL}/`);
    const h = page.headers();
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
  });

  test('sign-in link signs in; the spaces list matches /api/world', async ({ page, context, request }) => {
    await page.goto(signInLink(SERVICE_URL, token));
    await live(page);
    expect(page.url()).not.toContain('token');
    const cookie = (await context.cookies()).find((c) => c.name === 'hm_session');
    expect(cookie?.httpOnly).toBe(true);
    const { world } = await (await request.get(`${SERVICE_URL}/api/world`, { headers: auth })).json();
    const names = (world.spaceOrder as string[]).map((id) => world.spaces[id].name as string).sort();
    await expect.poll(async () => (await listedSpaces(page)).sort()).toEqual(names);
    await signOut(page);
  });

  test('clients reconnect after systemctl --user restart', async ({ page, request }) => {
    test.setTimeout(60_000);
    let sockets = 0;
    page.on('websocket', () => sockets++);
    await page.goto(signInLink(SERVICE_URL, token));
    await live(page);
    const before = sockets;
    const started = (await (await request.get(`${SERVICE_URL}/api/health`, { headers: auth })).json()).bridge.startedAt;
    execFileSync('systemctl', ['--user', 'restart', SERVICE_UNIT]);
    const restarted = await until(async () => {
      try {
        const h = await (await fetch(`${SERVICE_URL}/api/health`, { headers: auth })).json();
        return h.bridge.startedAt !== started && h.core.connected;
      } catch {
        return false;
      }
    }, 20_000);
    expect(restarted).toBeTruthy();
    await expect.poll(() => sockets, { timeout: 20_000 }).toBeGreaterThan(before);
    await live(page);
    expect((await listedSpaces(page)).length).toBeGreaterThan(0);
    await signOut(page);
  });
});
