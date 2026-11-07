// Sign-in helpers for the check scripts: the token is exchanged once for a session cookie (POST /api/session),
// which then authenticates HTTP and the WebSocket. Scripts sign out again when done.

/** Signs in to `httpBase` (http://host:port) and returns the `Cookie` header value of the new session. */
export async function signIn(httpBase, token, userAgent = 'herdr-mobile script') {
  const r = await fetch(`${httpBase}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ token }),
  });
  if (r.status !== 201) throw new Error(`sign-in failed: HTTP ${r.status}`);
  const set = r.headers.getSetCookie().find((c) => c.startsWith('hm_session='));
  if (!set) throw new Error('sign-in gave no session cookie');
  return set.split(';')[0];
}

/** Signs that session out (it disappears from the device list). */
export async function signOut(httpBase, cookie) {
  await fetch(`${httpBase}/api/session`, { method: 'DELETE', headers: { cookie } }).catch(() => {});
}

/** A sign-in link: the token in the fragment (never sent to the server), then an optional `#/...` route. */
export function signInLink(httpBase, token, hash = '') {
  return `${httpBase}/#token=${encodeURIComponent(token)}${hash ? `&${hash.replace(/^#/, '')}` : ''}`;
}
