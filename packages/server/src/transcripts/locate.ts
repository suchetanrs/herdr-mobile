import fs from 'node:fs';
import path from 'node:path';
import type { ConversationSource } from '@herdr-mobile/protocol';
import type { CoreTerminal } from '../core/types.js';
import { claudeFormat } from './claude.js';
import type { TranscriptFormat } from './format.js';

/** The formats the bridge reads. A new agent's format goes here. */
export const FORMATS: readonly TranscriptFormat[] = [claudeFormat];

export interface Located {
  format: TranscriptFormat;
  source: ConversationSource;
}

export interface LocatorOptions {
  home: string;
  formats?: readonly TranscriptFormat[];
  /** More folders transcripts may be read from (tests, synthetic transcripts). */
  extraRoots?: readonly string[];
  /** Test hook: a terminal (address or `hc run --name`) -> transcript path, format "claude" unless "<format>:" prefixes it. */
  overrides?: ReadonlyMap<string, string>;
  /** How long a computed list of roots is trusted (new ~/.claude-* folders appear rarely). */
  rootsTtlMs?: number;
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.jsonl$/;

function realDir(p: string): string | null {
  try {
    const r = fs.realpathSync(p);
    return fs.statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

/**
 * Finds a terminal's transcript and keeps the bridge inside the transcript
 * folders: a path is served only when it resolves (symlinks followed) to a
 * `.jsonl` file under one of the formats' roots. Read only.
 *
 * Where the path comes from, in order: a test override; the agent-resume
 * label Herdr's agent-resume mod writes on SessionStart (it follows /clear and
 * restarts, and knows CLAUDE_CONFIG_DIR setups like ~/.claude-work); the
 * agent's own registry of running sessions (Claude Code: sessions/<pid>.json).
 */
export class TranscriptLocator {
  private readonly formats: readonly TranscriptFormat[];
  private readonly rootsTtlMs: number;
  private rootsCache: { at: number; roots: string[] } | null = null;
  // The world is rebuilt often; a terminal's answer is reused briefly (keyed by what it depends on).
  private readonly cache = new Map<string, { key: string; at: number; value: Located | null }>();

  constructor(private readonly opts: LocatorOptions) {
    this.formats = opts.formats ?? FORMATS;
    this.rootsTtlMs = opts.rootsTtlMs ?? 30_000;
  }

  /** Real (symlink-free) root folders, deduplicated. */
  roots(): string[] {
    const now = Date.now();
    if (this.rootsCache && now - this.rootsCache.at < this.rootsTtlMs) return this.rootsCache.roots;
    const all = [...this.formats.flatMap((f) => f.roots(this.opts.home)), ...(this.opts.extraRoots ?? [])];
    const roots = [...new Set(all.map(realDir).filter((r): r is string => r !== null))];
    this.rootsCache = { at: now, roots };
    return roots;
  }

  /**
   * The real path of `p` when it may be served, else null. A file that doesn't
   * exist yet is allowed when its folder is inside a root (a new session's
   * transcript appears with its first message).
   */
  allowed(p: string): string | null {
    if (!path.isAbsolute(p) || !FILE.test(path.basename(p))) return null;
    let real: string;
    try {
      real = fs.realpathSync(p);
      if (!fs.statSync(real).isFile() || !FILE.test(path.basename(real))) return null;
    } catch {
      const dir = realDir(path.dirname(p));
      if (!dir) return null;
      real = path.join(dir, path.basename(p));
    }
    for (const root of this.roots()) {
      const rel = path.relative(root, real);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return real;
    }
    return null;
  }

  locate(t: CoreTerminal): Located | null {
    const key = `${t.state}|${t.name ?? ''}|${t.labels?.['agent-resume'] ?? ''}|${t.foreground?.pid ?? ''}|${t.foreground?.name ?? ''}`;
    const hit = this.cache.get(t.address);
    const now = Date.now();
    if (hit && hit.key === key && now - hit.at < 2000) return hit.value;
    const value = this.find(t);
    this.cache.set(t.address, { key, at: now, value });
    if (this.cache.size > 512) this.cache.clear();
    return value;
  }

  private find(t: CoreTerminal): Located | null {
    const override = this.opts.overrides?.get(t.address) ?? (t.name ? this.opts.overrides?.get(t.name) : undefined);
    if (override) {
      const m = /^([a-z][a-z0-9-]*):(\/.*)$/.exec(override);
      const format = this.formats.find((f) => f.id === (m?.[1] ?? 'claude'));
      const file = m?.[2] ?? override;
      const real = format ? this.allowed(file) : null;
      return format && real ? { format, source: { format: format.id, session: null, path: real } } : null;
    }
    const fromLabel = this.fromLabel(t.labels?.['agent-resume']);
    if (fromLabel) return fromLabel;
    const fg = t.foreground;
    if (t.state === 'live' && fg?.pid && fg.name) {
      for (const format of this.formats) {
        const hit = format.locateProcess?.({ pid: fg.pid, name: fg.name, cwd: fg.cwd ?? t.cwd ?? null }, this.opts.home);
        const real = hit ? this.allowed(hit.path) : null;
        if (hit && real) return { format, source: { format: format.id, session: hit.session, path: real } };
      }
    }
    return null;
  }

  private fromLabel(raw: string | undefined): Located | null {
    if (!raw) return null;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof v !== 'object' || v === null) return null;
    const { agent, session, transcript } = v as { agent?: unknown; session?: unknown; transcript?: unknown };
    if (typeof agent !== 'string' || typeof transcript !== 'string') return null;
    const format = this.formats.find((f) => f.agents.includes(agent));
    const real = format ? this.allowed(transcript) : null;
    return format && real
      ? { format, source: { format: format.id, session: typeof session === 'string' ? session : null, path: real } }
      : null;
  }
}

/** HERDR_MOBILE_TRANSCRIPT_OVERRIDE: "name=/path.jsonl,t2a=claude:/other.jsonl". */
export function parseOverrides(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}
