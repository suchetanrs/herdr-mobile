import { save } from './storage';

/** What the sign-in link carries in its fragment: `/#token=<token>` (optionally `&/a/<id>` to open after). */
const FRAGMENT = /^#token=([^&]*)(?:&(.*))?$/;

export type SignInResult = 'ok' | 'unauthorized' | 'blocked' | 'unreachable';

/**
 * A sign-in link's token, taken out of the address at once (before anything else runs, so it never stays in
 * history, a bookmark or a home-screen icon). The fragment never reaches the server: the token goes only in
 * the sign-in request's body.
 */
export function takeTokenFromUrl(loc: Location = window.location, hist: History = window.history): string | null {
  const m = FRAGMENT.exec(loc.hash);
  if (!m) return null;
  let token = m[1] ?? '';
  try {
    token = decodeURIComponent(token);
  } catch {}
  const rest = m[2] ? `#${m[2]}` : '';
  hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}${rest}`);
  return token.trim() || null;
}

/** Pre-1.3 builds kept the token itself in localStorage: nothing auth-related is kept there now. */
export function forgetStoredToken(): void {
  save('token', null);
}

/** Exchanges the token for this device's session (an HttpOnly cookie the page never sees). */
export async function signIn(token: string, fetcher: typeof fetch = fetch): Promise<SignInResult> {
  const standalone =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
  try {
    const r = await fetcher('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, standalone }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    // Read the (tiny) body so the request is over, not left open.
    await r.text().catch(() => '');
    if (r.ok) return 'ok';
    return r.status === 401 ? 'unauthorized' : r.status === 429 ? 'blocked' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** Asks the bridge whether this device is signed in (its session cookie). */
export async function checkSession(fetcher: typeof fetch = fetch): Promise<'ok' | 'unauthorized' | 'unreachable'> {
  try {
    const r = await fetcher('/api/session', { cache: 'no-store', credentials: 'same-origin' });
    await r.text().catch(() => '');
    if (r.ok) return 'ok';
    return r.status === 401 ? 'unauthorized' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** The WebSocket URL: no token, ever (the session cookie goes with the handshake). */
export function wsUrl(loc: Location = window.location): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/ws`;
}

export interface Device {
  id: string;
  name: string;
  created: string;
  lastSeen: string;
  ip: string;
}

export async function listDevices(fetcher: typeof fetch = fetch): Promise<{ current: string | null; devices: Device[] }> {
  const r = await fetcher('/api/sessions', { cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error(`The bridge said ${r.status}`);
  return (await r.json()) as { current: string | null; devices: Device[] };
}

/** Signs one device out (its open connection closes at once). */
export async function revokeDevice(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  const r = await fetcher(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error(`The bridge said ${r.status}`);
}

/** Signs every device out, this one included. */
export async function signOutEverywhere(fetcher: typeof fetch = fetch): Promise<void> {
  const r = await fetcher('/api/sessions', { method: 'DELETE', cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error(`The bridge said ${r.status}`);
}
