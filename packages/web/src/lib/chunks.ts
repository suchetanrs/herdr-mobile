/**
 * Lazy chunks (xterm, the conversation view) that survive the bridge being away when they're first needed:
 * a failed import is tried again with backoff, at once when the connection comes back, and the screen
 * shows its loading state meanwhile. Browsers (Chromium, WebKit) fetch a failed module again on the next
 * import(); Vite's CSS preloader, though, takes a <link> that failed as loaded, so failed ones are removed.
 * If the bridge answers but the chunk still won't load, the page is older than the build the bridge serves
 * (hashed names changed): reload once.
 */

type Waker = () => void;
const wakers = new Set<Waker>();

/** Retry waiting chunk loads now (the connection is back). */
export function wakeChunkRetries(): void {
  for (const w of [...wakers]) w();
}

let installed = false;
/** Drops <link> elements that failed to load, so a retry fetches them again. */
export function watchFailedLinks(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'error',
    (e) => {
      const el = e.target;
      if (el instanceof HTMLLinkElement && (el.rel === 'stylesheet' || el.rel === 'modulepreload')) el.remove();
    },
    true,
  );
  window.addEventListener('online', wakeChunkRetries);
}

export interface RetryDeps {
  /** Does the bridge answer right now? */
  bridgeUp: () => Promise<boolean>;
  /** Reload the page (at most once a minute); false when it already did recently. */
  reload: () => boolean;
  delay?: (attempt: number) => number;
}

const RELOAD_KEY = 'hm.chunkReloadAt';

export const defaultDeps: RetryDeps = {
  async bridgeUp() {
    try {
      return (await fetch('/api/health', { cache: 'no-store' })).ok;
    } catch {
      return false;
    }
  },
  reload() {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last < 60_000) return false;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      return false;
    }
    window.location.reload();
    return true;
  },
};

/** `load`, retried until it works (or the page is stale and reloads, or that already happened: then it fails). */
export function retrying<T>(load: () => Promise<T>, deps: RetryDeps = defaultDeps): () => Promise<T> {
  const delay = deps.delay ?? ((n: number) => Math.min(10_000, 500 * 2 ** (n - 1)));
  return () =>
    new Promise<T>((resolve, reject) => {
      let attempt = 0;
      let upFailures = 0;
      const once = () => {
        load().then(resolve, async (err: unknown) => {
          attempt++;
          if (await deps.bridgeUp()) {
            // Reachable, yet the chunk fails: give a flaky network two more tries, then it's a stale page.
            if (++upFailures >= 3) {
              if (!deps.reload()) reject(err);
              return;
            }
          }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const go: Waker = () => {
            wakers.delete(go);
            if (timer) clearTimeout(timer);
            once();
          };
          wakers.add(go);
          timer = setTimeout(go, delay(attempt));
        });
      };
      once();
    });
}
