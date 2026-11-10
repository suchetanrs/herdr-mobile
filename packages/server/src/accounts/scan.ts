import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentAccount } from '@herdr-mobile/protocol';

/**
 * Which Claude login each local terminal's `claude` runs under, computed the way the
 * desktop's my-agents mod (`accounts.py`) does: every process whose comm is `claude`,
 * its HC_TERMINAL_ID, and the `oauthAccount` of CLAUDE_CONFIG_DIR/.claude.json (else
 * ~/.claude.json). Those config files hold credentials: only the email's local part and
 * the plan are ever taken out of them, and nothing read from them is logged.
 */

/** One running `claude` and the config file it reads. */
export interface ClaudeProcess {
  pid: number;
  terminal: string;
  configFile: string;
}

export interface ScanOptions {
  /** /proc, or a fixture tree in tests. */
  procRoot: string;
  /** Whose ~/.claude.json a process without CLAUDE_CONFIG_DIR reads. */
  home: string;
  /**
   * The core socket the bridge talks to: a process whose HC_TERMINAL_SOCKET names another
   * core is skipped (its terminal ids aren't ours). Unset: no check, as accounts.py.
   */
  coreSocket?: string;
  /** A `claude` whose environment couldn't be read (EACCES: e.g. the bridge runs in its own user namespace). */
  onDenied?: (pid: number) => void;
}

/** Every `claude` process with a terminal id, in /proc listing order (a later one wins, as in accounts.py). */
export async function findClaudeProcesses(opts: ScanOptions): Promise<ClaudeProcess[]> {
  let names: string[];
  try {
    names = await fs.readdir(opts.procRoot);
  } catch {
    return [];
  }
  const out: ClaudeProcess[] = [];
  await Promise.all(
    names.map(async (name, i) => {
      if (!/^\d+$/.test(name)) return;
      const dir = path.join(opts.procRoot, name);
      let env: Map<string, string>;
      try {
        if ((await fs.readFile(path.join(dir, 'comm'), 'utf8')).trim() !== 'claude') return;
      } catch {
        return; // gone meanwhile
      }
      try {
        env = parseEnviron(await fs.readFile(path.join(dir, 'environ')));
      } catch (err) {
        // Gone meanwhile, or not ours to read (another user's, or across a user namespace).
        if ((err as NodeJS.ErrnoException).code === 'EACCES') opts.onDenied?.(Number(name));
        return;
      }
      const terminal = env.get('HC_TERMINAL_ID');
      if (!terminal || !/^[A-Za-z0-9_-]{1,64}$/.test(terminal)) return;
      const socket = env.get('HC_TERMINAL_SOCKET');
      if (opts.coreSocket && socket && path.resolve(socket) !== path.resolve(opts.coreSocket)) return;
      const configDir = env.get('CLAUDE_CONFIG_DIR');
      // accounts.py would resolve a relative dir against Herdr's cwd, which the bridge can't know.
      if (configDir && !path.isAbsolute(configDir)) return;
      const configFile = configDir ? path.join(configDir, '.claude.json') : path.join(opts.home, '.claude.json');
      out[i] = { pid: Number(name), terminal, configFile };
    }),
  );
  return out.filter((p) => p !== undefined);
}

/** NUL-separated KEY=value pairs; a later duplicate wins (Python's dict()). */
export function parseEnviron(raw: Buffer): Map<string, string> {
  const env = new Map<string, string>();
  for (const entry of raw.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return env;
}

const MAX_TEXT = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function clean(s: string): string {
  return s.replace(CONTROL, '').slice(0, MAX_TEXT);
}

/**
 * The account in a parsed .claude.json, as accounts.py reads it: [email local part or "?",
 * planDisplayName or organizationType, lower case]. Null where accounts.py would fail
 * (not an object, or a field of the wrong type). Picks the two fields and nothing else.
 */
export function accountOf(config: unknown): AgentAccount | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const o = or((config as Record<string, unknown>).oauthAccount, {});
  // `.get` on a non-dict raises in accounts.py.
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const acc = o as Record<string, unknown>;
  const email = or(acc.emailAddress, '?');
  const plan = or(acc.planDisplayName, or(acc.organizationType, ''));
  if (typeof email !== 'string' || typeof plan !== 'string') return null;
  return { name: clean(email.split('@')[0] ?? ''), plan: clean(plan.toLowerCase()) };
}

/** Python's `a or b` for JSON values. */
function or(a: unknown, b: unknown): unknown {
  const truthy = Array.isArray(a) ? a.length > 0 : a && typeof a === 'object' ? Object.keys(a).length > 0 : Boolean(a);
  return truthy ? a : b;
}

/** The account per config file, re-read only when the file's mtime, size or inode changes. */
export class ConfigCache {
  private readonly entries = new Map<string, { stamp: string; account: AgentAccount | null }>();
  /** Files actually read and parsed (tests). */
  reads = 0;

  async get(file: string): Promise<AgentAccount | null> {
    let stamp: string;
    try {
      const st = await fs.stat(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      this.entries.delete(file);
      return null;
    }
    const have = this.entries.get(file);
    if (have && have.stamp === stamp) return have.account;
    let account: AgentAccount | null = null;
    try {
      this.reads++;
      account = accountOf(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
      account = null;
    }
    this.entries.set(file, { stamp, account });
    return account;
  }

  /** Forgets files no process uses any more. */
  keepOnly(files: ReadonlySet<string>): void {
    for (const f of this.entries.keys()) if (!files.has(f)) this.entries.delete(f);
  }
}

/** terminal id -> account, for the processes found now. */
export async function scanAccounts(opts: ScanOptions, cache: ConfigCache): Promise<Map<string, AgentAccount>> {
  return accountsOf(await findClaudeProcesses(opts), cache);
}

export async function accountsOf(procs: readonly ClaudeProcess[], cache: ConfigCache): Promise<Map<string, AgentAccount>> {
  const out = new Map<string, AgentAccount>();
  const files = new Set(procs.map((p) => p.configFile));
  const byFile = new Map<string, AgentAccount | null>();
  for (const f of files) byFile.set(f, await cache.get(f));
  cache.keepOnly(files);
  for (const p of procs) {
    const a = byFile.get(p.configFile);
    if (a) out.set(p.terminal, a);
  }
  return out;
}

/**
 * Claude Code runs each Bash tool command (a background one, a Monitor) as a direct child
 * `bash -c 'source <config>/shell-snapshots/snapshot-...'`. Claude reports `done` once its own turn
 * ends, even while such work (its own, or a background sub-agent's that waits on it) still runs.
 */
const TOOL_SHELL = /\/shell-snapshots\/snapshot-/;

/** Terminals whose `claude` has a Bash tool command running (only read: children's cmdlines). */
export async function backgroundOf(procs: readonly ClaudeProcess[], procRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(
    procs.map(async (p) => {
      let kids: string[];
      try {
        kids = (await fs.readFile(path.join(procRoot, String(p.pid), 'task', String(p.pid), 'children'), 'utf8'))
          .split(/\s+/)
          .filter((k) => /^\d+$/.test(k));
      } catch {
        return;
      }
      for (const k of kids) {
        try {
          if (TOOL_SHELL.test((await fs.readFile(path.join(procRoot, k, 'cmdline'))).toString('utf8'))) {
            out.add(p.terminal);
            return;
          }
        } catch {
          // gone meanwhile
        }
      }
    }),
  );
  return out;
}
