/** Hash routes, so any path the bridge serves loads the app and deep links survive reloads. */
export type Route =
  | { name: 'spaces' }
  | { name: 'alerts' }
  | { name: 'settings' }
  | { name: 'new' }
  /**
   * The file browser (its folder is remembered on the device, not in the address); `view`: a file open in the
   * viewer; `space`: opened from that space, at its folder (back returns to it; nothing remembered).
   */
  | { name: 'files'; view?: string; space?: string }
  | { name: 'space'; spaceId: string }
  /** No `view`: the agent's remembered tab, else Conversation when it has a transcript. */
  | { name: 'agent'; terminalId: string; view?: 'terminal' | 'conversation' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [head, id, extra] = parts;
  if (head === 's' && id) {
    if (extra === 'files') {
      const v = parts[3] === 'view' ? parts[4] : undefined;
      return v ? { name: 'files', space: id, view: v } : { name: 'files', space: id };
    }
    return { name: 'space', spaceId: id };
  }
  if (head === 'a' && id)
    return extra === 'conversation' || extra === 'terminal'
      ? { name: 'agent', terminalId: id, view: extra }
      : { name: 'agent', terminalId: id };
  if (head === 'alerts') return { name: 'alerts' };
  if (head === 'settings') return { name: 'settings' };
  if (head === 'new') return { name: 'new' };
  if (head === 'files') return id === 'view' && extra ? { name: 'files', view: extra } : { name: 'files' };
  return { name: 'spaces' };
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'spaces':
      return '#/';
    case 'alerts':
      return '#/alerts';
    case 'settings':
      return '#/settings';
    case 'new':
      return '#/new';
    case 'files': {
      const base = r.space ? `#/s/${encodeURIComponent(r.space)}/files` : '#/files';
      return r.view ? `${base}/view/${encodeURIComponent(r.view)}` : base;
    }
    case 'space':
      return `#/s/${encodeURIComponent(r.spaceId)}`;
    case 'agent':
      return `#/a/${encodeURIComponent(r.terminalId)}${r.view ? `/${r.view}` : ''}`;
  }
}

/** How deep a screen is (for the slide direction between screens). */
export function depth(r: Route): number {
  return r.name === 'spaces' ? 0 : r.name === 'agent' || (r.name === 'files' && r.space) ? 2 : 1;
}

// Entries this app pushed, so "back" only pops its own history (a deep link opened cold goes up instead).
let pushed = 0;
let ours = false;

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (ours) ours = false;
    else pushed = Math.max(0, pushed - 1);
  });
}

export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const hash = routeHash(r);
  if (window.location.hash === hash || (hash === '#/' && window.location.hash === '')) return;
  if (opts.replace) {
    window.history.replaceState(window.history.state, '', hash);
    ours = true;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  ours = true;
  pushed++;
  window.location.hash = hash;
}

/** Back through this app's own history, else up to `parent`. */
export function back(parent: Route): void {
  if (pushed > 0) {
    pushed--;
    ours = true;
    window.history.back();
    return;
  }
  navigate(parent, { replace: true });
}
