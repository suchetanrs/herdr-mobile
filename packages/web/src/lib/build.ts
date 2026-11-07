import type { AppStore } from './store';
import { isEditable } from './viewport';

declare const __HERDR_BUILD__: string | undefined;

/** This page's build: short git sha and build time (vite.config.ts), 'dev' under the dev server and tests. */
export const BUILD: string = typeof __HERDR_BUILD__ === 'string' ? __HERDR_BUILD__ : 'dev';

const GUARD_KEY = 'hm.reloadedFor';

/**
 * Whether this page should reload to pick up the build the bridge serves now. A home-screen app on iOS is
 * resumed, not reloaded, so without this it can run an old build for days after an update. Never in dev,
 * never while a text field has focus (the person is typing), and at most once per server build (if the
 * reload still brings this build, e.g. a cache in the way, don't loop).
 */
export function shouldReload(o: { own: string; server: string | null; editing: boolean; reloadedFor: string | null }): boolean {
  if (!o.server || o.own === 'dev' || o.server === o.own) return false;
  if (o.reloadedFor === o.server) return false;
  return !o.editing;
}

/** Reloads into the bridge's build when one differs from this page's (checked on welcome, refocus, blur). */
export function watchBuild(store: AppStore, reload: () => void = () => window.location.reload()): () => void {
  const check = () => {
    let reloadedFor: string | null = null;
    try {
      reloadedFor = sessionStorage.getItem(GUARD_KEY);
    } catch {}
    const server = store.getState().serverBuild;
    if (!shouldReload({ own: BUILD, server, editing: isEditable(document.activeElement), reloadedFor })) return;
    try {
      sessionStorage.setItem(GUARD_KEY, server ?? '');
    } catch {}
    reload();
  };
  let last: string | null = null;
  const off = store.subscribe(() => {
    const b = store.getState().serverBuild;
    if (b === last) return;
    last = b;
    check();
  });
  const later = () => setTimeout(check, 0);
  document.addEventListener('focusout', later);
  document.addEventListener('visibilitychange', check);
  return () => {
    off();
    document.removeEventListener('focusout', later);
    document.removeEventListener('visibilitychange', check);
  };
}
