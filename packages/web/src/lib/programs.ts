// What runs in a terminal, as Herdr shows it: name, icon, tile. The table is
// herdr-app's defaults/programs.json (Apache-2.0), resolved the way
// herdr-app's programs.rs `resolve` does (by the agent's 7501 app, else the
// foreground program's name).
import table from './programs.json';

interface Entry {
  name?: string;
  icon?: string;
  tint?: boolean;
  tile?: string;
  color?: string;
  match?: string[];
}

export interface Program {
  key: string;
  name: string;
  /** URL of the icon. */
  icon: string | null;
  /** A one-color glyph (drawn in the text color), else a picture. */
  tint: boolean;
  tile: string | null;
  color: string | null;
  shell: boolean;
  agent: boolean;
}

const programs = (table as { programs: Record<string, Entry> }).programs;
const shells = new Set((table as { shells: string[] }).shells);
const ICON_BASE = '/icons/programs/';

function find(name: string): [string, Entry] | null {
  const lower = name.toLowerCase();
  for (const [k, e] of Object.entries(programs)) if (k === name || k.toLowerCase() === lower) return [k, e];
  for (const [k, e] of Object.entries(programs)) if (e.match?.some((a) => a === name || a.toLowerCase() === lower)) return [k, e];
  return null;
}

function shown(key: string, e: Entry | undefined, name: string | null, shell: boolean, agent: boolean): Program {
  return {
    key,
    name: name ?? e?.name ?? key,
    icon: e?.icon ? ICON_BASE + e.icon.replace(/^icons\//, '') : null,
    tint: e?.tint ?? true,
    tile: e?.tile ?? null,
    color: e?.color ?? null,
    shell,
    agent,
  };
}

/** A color for a program nobody listed, the same every time (programs.rs `hash_color`). */
export function hashColor(s: string): string {
  const PALETTE = ['#6d5bd0', '#2f80ed', '#0f9d8a', '#d9822b', '#c2417d', '#3a7d44', '#8a5a44', '#4e5d94'];
  let h = 2166136261;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return PALETTE[h % PALETTE.length] as string;
}

const cache = new Map<string, Program>();

export function programOf(app: string | null, program: string | null): Program {
  const key = `${app ?? ''}\u0000${program ?? ''}`;
  let p = cache.get(key);
  if (!p) {
    p = resolve(app, program);
    cache.set(key, p);
  }
  return p;
}

function resolve(app: string | null, program: string | null): Program {
  if (app) {
    const f = find(app);
    return f ? shown(f[0], f[1], null, false, true) : shown('agent', programs.agent, app, false, true);
  }
  const first = program?.replace(/^.*[/\\]/, '').replace(/^-+/, '') ?? '';
  if (!first) return shown('shell', programs.shell, null, true, false);
  const f = find(first);
  if (f) return shown(f[0], f[1], null, false, false);
  if (shells.has(first)) return shown('shell', programs.shell, first, true, false);
  return shown('program', { ...programs.program, tile: hashColor(first), color: '#ffffff' }, first, false, false);
}
