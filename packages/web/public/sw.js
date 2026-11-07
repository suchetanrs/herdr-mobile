// herdr-mobile service worker. Registered only in a secure context (HTTPS or
// localhost). Today: opens the agent when a notification is tapped, and keeps
// the app shell for offline starts. Later (HTTPS): Web Push lands in `push`.
const SHELL = 'herdr-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/app/icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for the page and its hashed assets; the cache only answers when offline. API and WebSocket never touch it.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === 'navigate' || url.pathname.startsWith('/assets/'))) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((r) => r || Response.error())),
  );
});

// Web Push (later): the bridge sends an AttentionAlert as the payload.
self.addEventListener('push', (event) => {
  let alert = {};
  try {
    alert = event.data ? event.data.json() : {};
  } catch {
    alert = { title: event.data ? event.data.text() : 'Herdr' };
  }
  const url = alert.terminalId ? `/#/a/${encodeURIComponent(alert.terminalId)}` : '/';
  event.waitUntil(
    self.registration.showNotification(alert.title || 'Herdr', {
      body: alert.body || undefined,
      tag: alert.terminalId ? `herdr-${alert.terminalId}` : undefined,
      icon: '/app/icon-192.png',
      badge: '/app/badge-96.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin) {
          c.postMessage({ type: 'open', url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
