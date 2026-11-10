import fs from 'node:fs';
import path from 'node:path';
import {
  FS_PAGE,
  FS_PATH_MAX,
  FS_SCAN_MAX,
  type FsEntry,
  type FsError,
  type FsFile,
  type FsKind,
  type FsListing,
} from '@herdr-mobile/protocol';
import { gitIgnored, type IgnoreOptions } from './ignored.js';

/** A refusal with its HTTP status and the code the page shows a message for. */
export class FsFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: FsError['code'],
    message: string,
  ) {
    super(message);
  }
}

const NOT_FOUND = () => new FsFailure(404, 'not-found', 'No such file or folder');
const DENIED = () => new FsFailure(403, 'denied', 'Permission denied');
const PRIVATE = () => new FsFailure(403, 'private', 'The bridge keeps its own secrets there; it never shares them');

/** Kernel views (/proc, /sys) and devices: listed, never downloaded (`/proc/<pid>/environ` holds secrets). */
const PSEUDO = ['/proc', '/sys', '/dev'];

const within = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * A typed or pasted path as an absolute one: `~` and `~/x` from the home folder, relative ones from the home
 * folder too (the page joins them to the folder it shows first), surrounding quotes and spaces dropped.
 */
export function expandPath(typed: string, home: string): string {
  let t = typed.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) t = t.slice(1, -1);
  if (t === '') return home;
  if (t.length > FS_PATH_MAX) throw new FsFailure(400, 'bad-path', 'That path is too long');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new FsFailure(400, 'bad-path', 'That path has control characters in it');
  if (t === '~') return home;
  if (t.startsWith('~/')) return path.resolve(home, t.slice(2));
  if (t.startsWith('~')) throw new FsFailure(400, 'bad-path', 'Only ~ (your own home folder) is understood');
  return path.resolve(home, t);
}

function failure(e: unknown): FsFailure {
  if (e instanceof FsFailure) return e;
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return DENIED();
  return NOT_FOUND(); // ENOENT, ENOTDIR, ELOOP, ENAMETOOLONG...
}

export interface BrowserOptions {
  home: string;
  /** Folders nothing under is ever listed or sent (the bridge's own config: token, sessions, env). */
  privateDirs: readonly string[];
  /** Single files never sent (the diagnostics file). */
  privateFiles?: readonly string[];
  /** Test hook: where /proc, /sys, /dev are. */
  pseudoRoots?: readonly string[];
  /** How entries git ignores are found (test hook). */
  ignore?: IgnoreOptions;
}

/**
 * Read-only access to the whole filesystem as the bridge's user: list folders, describe and open files. Paths
 * are resolved with realpath first, so a symlink can't lead into a private folder; the bridge's own secrets
 * are neither listed nor sent; only regular files are ever opened.
 */
export class FileBrowser {
  readonly home: string;
  private readonly pseudo: readonly string[];

  constructor(private readonly opts: BrowserOptions) {
    this.home = opts.home;
    this.pseudo = opts.pseudoRoots ?? PSEUDO;
  }

  /** Real paths of the private folders and files (resolved each time: they may appear later). */
  private privateRoots(): { dirs: string[]; files: string[] } {
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const files = (this.opts.privateFiles ?? []).flatMap((f) => [real(f), real(`${f}.1`)]);
    return { dirs: this.opts.privateDirs.map(real), files };
  }

  isPrivate(real: string): boolean {
    const { dirs, files } = this.privateRoots();
    return dirs.some((d) => within(real, d)) || files.includes(real);
  }

  /** The real path of what was typed; refuses private places. */
  async resolve(typed: string): Promise<string> {
    const abs = expandPath(typed, this.home);
    let real: string;
    try {
      real = await fs.promises.realpath(abs);
    } catch (e) {
      throw failure(e);
    }
    if (this.isPrivate(real)) throw PRIVATE();
    return real;
  }

  /** A folder's entries (one page), or, for a file, what it is. */
  async lookup(typed: string, opts: { hidden?: boolean; offset?: number; limit?: number } = {}): Promise<FsListing | FsFile> {
    const real = await this.resolve(typed);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(real);
    } catch (e) {
      throw failure(e);
    }
    if (!st.isDirectory()) {
      return {
        kind: 'file',
        path: real,
        name: path.basename(real),
        size: st.size,
        mtime: st.mtimeMs,
        downloadable: st.isFile() && !this.isPseudo(real),
      };
    }
    return this.list(real, opts);
  }

  private isPseudo(real: string): boolean {
    return this.pseudo.some((r) => within(real, r));
  }

  private async list(dir: string, opts: { hidden?: boolean; offset?: number; limit?: number }): Promise<FsListing> {
    const limit = Math.min(Math.max(1, opts.limit ?? FS_PAGE), FS_PAGE);
    let handle: fs.Dir;
    try {
      handle = await fs.promises.opendir(dir, { bufferSize: 128 });
    } catch (e) {
      throw failure(e);
    }
    const found: Array<{ name: string; kind: FsKind; link: boolean }> = [];
    let hidden = 0;
    let truncated = false;
    let read = 0;
    try {
      for await (const d of handle) {
        if (++read > FS_SCAN_MAX) {
          truncated = true;
          break;
        }
        if (d.name.startsWith('.') && !opts.hidden) {
          hidden++;
          continue;
        }
        found.push({ name: d.name, kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', link: d.isSymbolicLink() });
      }
    } catch (e) {
      throw failure(e);
    } finally {
      // Breaking out of the loop closes it already; closing twice throws.
      await handle.close().catch(() => {});
    }
    // Symlinks count as what they point to; ones leading into a private place aren't shown.
    const { dirs, files } = this.privateRoots();
    const secret = (p: string) => dirs.some((d) => within(p, d)) || files.includes(p);
    const shown: typeof found = [];
    await Promise.all(
      found.map(async (e) => {
        const full = path.join(dir, e.name);
        if (secret(full)) return;
        if (e.link) {
          try {
            const target = await fs.promises.realpath(full);
            if (secret(target)) return;
            const ts = await fs.promises.stat(target);
            e.kind = ts.isDirectory() ? 'dir' : ts.isFile() ? 'file' : 'other';
          } catch {
            e.kind = 'other';
          }
        }
        shown.push(e);
      }),
    );
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    shown.sort((a, b) => ((a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : collator.compare(a.name, b.name)));
    const offset = Math.min(Math.max(0, opts.offset ?? 0), shown.length);
    const page = shown.slice(offset, offset + limit);
    const entries: FsEntry[] = await Promise.all(
      page.map(async (e) => {
        let size: number | null = null;
        let mtime: number | null = null;
        try {
          const st = await (e.link ? fs.promises.stat : fs.promises.lstat)(path.join(dir, e.name));
          size = e.kind === 'file' ? st.size : null;
          mtime = st.mtimeMs;
        } catch {}
        return { name: e.name, kind: e.kind, link: e.link, size, mtime, ignored: false };
      }),
    );
    const ignored = await gitIgnored(
      dir,
      // git sees a symlink as a file (and refuses `link/` for the whole batch).
      entries.map((e) => ({ name: e.name, dir: e.kind === 'dir' && !e.link })),
      this.opts.ignore,
    );
    for (const e of entries) e.ignored = ignored.has(e.name);
    return {
      kind: 'dir',
      path: dir,
      parent: dir === '/' ? null : path.dirname(dir),
      home: this.home,
      entries,
      total: shown.length,
      offset,
      hidden,
      truncated,
    };
  }

  /**
   * Opens a regular file to send: resolved, not private, not in /proc, /sys or /dev, not a device, socket or
   * pipe (checked before opening, so a FIFO can't block the open, and again on the open file), and not another
   * name (hard link) for a private file. The caller closes the handle.
   */
  async open(typed: string): Promise<{ handle: fs.promises.FileHandle; path: string; name: string; stat: fs.Stats }> {
    const real = await this.resolve(typed);
    const notRegular = () => new FsFailure(400, 'not-regular', 'Only regular files can be downloaded');
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(real);
    } catch (e) {
      throw failure(e);
    }
    if (!st.isFile()) throw st.isDirectory() ? new FsFailure(400, 'not-regular', 'That is a folder, not a file') : notRegular();
    if (this.isPseudo(real)) throw notRegular();
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (e) {
      throw failure(e);
    }
    try {
      const now = await handle.stat();
      if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) throw notRegular();
      if (now.nlink > 1 && this.privateInodes().has(`${now.dev}:${now.ino}`)) throw PRIVATE();
      return { handle, path: real, name: path.basename(real), stat: now };
    } catch (e) {
      await handle.close().catch(() => {});
      throw failure(e);
    }
  }

  /** dev:ino of the files in the private folders (two levels; they hold a handful), for the hard-link check. */
  private privateInodes(): Set<string> {
    const out = new Set<string>();
    const { dirs, files } = this.privateRoots();
    const add = (p: string) => {
      try {
        const s = fs.lstatSync(p);
        if (s.isFile()) out.add(`${s.dev}:${s.ino}`);
      } catch {}
    };
    const walk = (dir: string, depth: number) => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500);
      } catch {
        return;
      }
      for (const d of names) {
        const p = path.join(dir, d.name);
        if (d.isDirectory() && depth < 2) walk(p, depth + 1);
        else add(p);
      }
    };
    for (const d of dirs) walk(d, 1);
    for (const f of files) add(f);
    return out;
  }
}

/** `Content-Disposition` (attachment, or inline) with an ASCII fallback name and the real one (RFC 6266 / RFC 5987). */
export function contentDisposition(name: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * One `Range: bytes=` range of a file of `size` bytes: [start, end] inclusive; null = send it whole (absent,
 * several ranges, or a unit we don't serve); 'unsatisfiable' = 416.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
