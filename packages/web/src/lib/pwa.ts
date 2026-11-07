/**
 * The service worker (public/sw.js) is where Web Push lands once the bridge
 * has HTTPS. Browsers only allow it in a secure context (HTTPS or localhost),
 * so on the plain-HTTP tailnet address it's simply not registered.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('service worker not registered', err));
  });
  // A tap on a system notification: the worker asks this page to open the agent.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === 'open' && e.data.url) window.location.hash = new URL(e.data.url, window.location.href).hash;
  });
}
