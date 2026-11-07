import fs from 'node:fs';
import path from 'node:path';
import { FOLDER_MAX, type FolderChoice, type World } from '@herdr-mobile/protocol';

export class FolderError extends Error {}

/** A typed folder as an absolute path: `~` and `~/x` from the home folder, relative ones too. */
export function expand(typed: string, home: string): string {
  const t = typed.trim();
  if (t.length === 0) throw new FolderError('Pick a folder');
  if (t.length > FOLDER_MAX) throw new FolderError('That path is too long');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new FolderError('That path has control characters in it');
  if (t === '~') return home;
  if (t.startsWith('~/')) return path.join(home, t.slice(2));
  if (t.startsWith('~')) throw new FolderError('Only your own home folder (~/…)');
  return path.resolve(home, t);
}

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** `~/x` for a path in the home folder. */
export function display(p: string, home: string): string {
  if (p === home) return '~';
  return inside(p, home) ? `~/${p.slice(home.length).replace(/^\/+/, '')}` : p;
}

/**
 * The folder a new space may start in: it exists, is a folder we can enter, and (after
 * symlinks) lies in the home folder, or is the folder of a space Herdr already shows/showed.
 */
export function checkFolder(typed: string, home: string, known: readonly string[] = []): string {
  const want = expand(typed, home);
  let real: string;
  try {
    real = fs.realpathSync(want);
  } catch {
    throw new FolderError('No such folder');
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    throw new FolderError('No such folder');
  }
  if (!st.isDirectory()) throw new FolderError('That is a file, not a folder');
  try {
    fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new FolderError('You can’t open that folder');
  }
  const realHome = safeReal(home);
  const allowed = inside(real, realHome) || known.some((k) => safeReal(k) === real);
  if (!allowed) throw new FolderError('Pick a folder in your home folder');
  return real;
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Sub-folders matching what's typed so far (the part after the last `/`), in the home folder
 * only. Hidden ones only when the typed part starts with a dot. Typed paths, not real ones.
 */
export function complete(typed: string, home: string, limit = 50): string[] {
  const t = typed.trim() === '' ? '~/' : typed.trim();
  let abs: string;
  try {
    abs = expand(t, home);
  } catch {
    return [];
  }
  const endsSlash = t.endsWith('/') || t === '~';
  const dir = endsSlash ? abs : path.dirname(abs);
  const prefix = endsSlash ? '' : path.basename(abs);
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return [];
  }
  if (!inside(realDir, safeReal(home))) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const lower = prefix.toLowerCase();
  const out: string[] = [];
  const order = (n: string) => [n.toLowerCase(), n] as const;
  entries.sort((a, b) => {
    const [x, y] = [order(a.name), order(b.name)];
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  });
  for (const e of entries) {
    if (e.name.startsWith('.') && !prefix.startsWith('.')) continue;
    if (!e.name.toLowerCase().startsWith(lower)) continue;
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(realDir, e.name)).isDirectory();
      } catch {}
    }
    if (!isDir) continue;
    out.push(`${display(path.join(dir, e.name), home)}/`);
    if (out.length >= limit) break;
  }
  return out;
}

/** herdr-app's recently closed spaces (view.json `recent`: name + folder), read only. */
export function recentSpaces(herdrAppDir: string): Array<{ name: string; folder: string }> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(herdrAppDir, 'view.json'), 'utf8')) as { recent?: unknown };
    if (!Array.isArray(v.recent)) return [];
    return v.recent
      .filter((r): r is { name: string; folder: string } => typeof r?.folder === 'string' && typeof r?.name === 'string')
      .map((r) => ({ name: r.name, folder: r.folder }));
  } catch {
    return [];
  }
}

/** Folders to offer: this machine's open spaces' folders, then recently closed ones; existing folders, each once. */
export function folderChoices(world: World, recent: ReadonlyArray<{ name: string; folder: string }>, home: string): FolderChoice[] {
  const out: FolderChoice[] = [];
  const seen = new Set<string>();
  const add = (folder: string, label: string, from: FolderChoice['from']) => {
    if (!folder.startsWith('/') || seen.has(folder)) return;
    seen.add(folder);
    try {
      if (!fs.statSync(folder).isDirectory()) return;
    } catch {
      return;
    }
    out.push({ path: folder, display: display(folder, home), from, label });
  };
  for (const id of world.spaceOrder) {
    const s = world.spaces[id];
    if (s && s.machine === null) add(s.folder, s.name, 'space');
  }
  for (const r of recent) add(r.folder, r.name, 'recent');
  return out.slice(0, 30);
}
