import type { FsError, FsLookup } from '@herdr-mobile/protocol';

/** A refusal from the bridge (or no bridge), with its code for the page's message. */
export class FsProblem extends Error {
  constructor(
    message: string,
    readonly code: FsError['code'] | 'offline',
  ) {
    super(message);
  }
}

/** A folder page or a file's facts (GET /api/fs/list). */
export async function lookup(
  typed: string,
  opts: { hidden?: boolean; offset?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<FsLookup> {
  const q = new URLSearchParams({ path: typed });
  if (opts.hidden) q.set('hidden', '1');
  if (opts.offset) q.set('offset', String(opts.offset));
  let r: Response;
  try {
    r = await fetcher(`/api/fs/list?${q}`, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new FsProblem('Can’t reach the bridge right now', 'offline');
  }
  const body = (await r.json().catch(() => ({}))) as FsLookup & Partial<FsError>;
  if (!r.ok) throw new FsProblem(body.error ?? `The bridge said ${r.status}`, body.code ?? 'not-found');
  return body;
}

/** Where a file downloads from (same origin: the session cookie goes along). */
export const downloadUrl = (abs: string) => `/api/fs/download?path=${encodeURIComponent(abs)}`;

/** Where the viewer reads a viewable file from (inline; the bridge refuses anything not on its allowlist). */
export const viewUrl = (abs: string) => `/api/fs/view?path=${encodeURIComponent(abs)}`;

/** `dir` + `name` as one absolute path. */
export const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

/**
 * What the path bar sends: `~...` and absolute paths as typed, anything else relative to the folder shown
 * (the bridge would take it from the home folder).
 */
export function typedToPath(typed: string, current: string | null): string {
  let t = typed.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) t = t.slice(1, -1);
  if (t === '' || t.startsWith('/') || t.startsWith('~') || !current) return t;
  return joinPath(current, t);
}

/** A path under the home folder as `~/...`. */
export function tildePath(abs: string, home: string): string {
  if (!home || home === '/') return abs;
  if (abs === home) return '~';
  return abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}

/** The tappable parts of a path: `/`, then each folder down to it. */
export function crumbs(abs: string): Array<{ label: string; path: string }> {
  const out = [{ label: '/', path: '/' }];
  let at = '';
  for (const part of abs.split('/').filter(Boolean)) {
    at += `/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

/** "0 B", "912 B", "4.2 KB", "13 MB", "1.1 GB" (1024s). */
export function fileSize(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Mar", "12 Mar 2024". */
export function modified(ms: number | null, now = Date.now()): string {
  if (ms === null) return '';
  const d = now - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 2 * 86_400_000) return 'yesterday';
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Starts a download of `abs` (an <a download> click: the browser's own download, the session cookie included). */
export function startDownload(abs: string, name: string): void {
  const a = document.createElement('a');
  a.href = downloadUrl(abs);
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Tab completion in the path bar: the typed last part completed from its folder's entries (the common start
 * when several match; a folder gets its `/`). Null when nothing matches.
 */
export function completeFrom(typed: string, names: ReadonlyArray<{ name: string; kind: string }>): string | null {
  const cut = typed.lastIndexOf('/');
  const head = typed.slice(0, cut + 1);
  const part = typed.slice(cut + 1);
  const hits = names.filter((n) => n.name.toLowerCase().startsWith(part.toLowerCase()));
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    const only = hits[0] as { name: string; kind: string };
    return `${head}${only.name}${only.kind === 'dir' ? '/' : ''}`;
  }
  let common = (hits[0] as { name: string }).name;
  for (const h of hits) {
    let i = 0;
    while (i < common.length && i < h.name.length && common[i]?.toLowerCase() === h.name[i]?.toLowerCase()) i++;
    common = common.slice(0, i);
  }
  return common.length > part.length ? `${head}${common}` : null;
}
