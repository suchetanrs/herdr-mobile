import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StartChoice } from '@herdr-mobile/protocol';

/** An agent Herdr's + menu can start (programs.json entries with `run`). */
export interface Startable {
  key: string;
  name: string;
  run: string[];
}

/**
 * herdr-app's built-in table (defaults/programs.json, v0.1.13, the entries with `run`; the
 * web app has the whole table in packages/web/src/lib/programs.json and a test keeps them equal).
 */
export const BUILT_IN: readonly Startable[] = [
  { key: 'claude', name: 'Claude Code', run: ['claude'] },
  { key: 'codex', name: 'Codex', run: ['codex'] },
  { key: 'pi', name: 'Pi', run: ['pi'] },
  { key: 'pig', name: 'PiG', run: ['pig'] },
  { key: 'opencode', name: 'OpenCode', run: ['opencode'] },
  { key: 'cursor', name: 'Cursor', run: ['cursor-agent'] },
  { key: 'copilot', name: 'Copilot', run: ['copilot'] },
  { key: 'amp', name: 'Amp', run: ['amp'] },
  { key: 'grok', name: 'Grok', run: ['grok'] },
  { key: 'dsh-tui', name: 'DeepSeek Harness', run: ['dsh-tui'] },
  { key: 'antigravity', name: 'Antigravity', run: ['agy'] },
  { key: 'kimi', name: 'Kimi', run: ['kimi'] },
  { key: 'kiro', name: 'Kiro', run: ['kiro-cli'] },
  { key: 'hermes', name: 'Hermes', run: ['hermes'] },
  { key: 'qoder', name: 'Qoder', run: ['qodercli'] },
  { key: 'crush', name: 'Crush', run: ['crush'] },
  { key: 'gemini', name: 'Gemini', run: ['gemini'] },
];

/** programs.rs `AGENTS_FIRST`: the agents people pick most, first in menus; the rest follow by key. */
const AGENTS_FIRST = ['claude', 'codex', 'pi', 'opencode', 'cursor', 'copilot', 'amp', 'gemini', 'grok'];

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORD = /^[^\0\n\r]{1,256}$/;

/**
 * The startable agents: the built-in table with the person's `programs.json` (herdr-app's
 * home) on top, entry by entry (programs.rs `load` / `Entry::over`), most picked first.
 */
export function startable(herdrAppDir: string): Startable[] {
  const table = new Map<string, Startable>(BUILT_IN.map((s) => [s.key, { ...s, run: [...s.run] }]));
  try {
    const mine = JSON.parse(fs.readFileSync(path.join(herdrAppDir, 'programs.json'), 'utf8')) as {
      programs?: Record<string, { name?: unknown; run?: unknown }>;
    };
    for (const [key, e] of Object.entries(mine.programs ?? {})) {
      if (!KEY.test(key) || !e || typeof e !== 'object') continue;
      const was = table.get(key);
      const run =
        Array.isArray(e.run) && e.run.length > 0 && e.run.length <= 16 && e.run.every((a) => typeof a === 'string' && WORD.test(a))
          ? (e.run as string[])
          : null;
      const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 64) : null;
      if (was) table.set(key, { key, name: name ?? was.name, run: run ?? was.run });
      else if (run) table.set(key, { key, name: name ?? key, run });
    }
  } catch {
    // No file (the usual case) or not JSON: the desktop shows its own error; built-ins stand.
  }
  const rank = (k: string) => {
    const i = AGENTS_FIRST.indexOf(k);
    return i === -1 ? AGENTS_FIRST.length : i;
  };
  return [...table.values()].sort((a, b) => rank(a.key) - rank(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The shell agents start in (window.rs `shell()`: $SHELL, else /bin/sh), here also the account's login shell. */
export function userShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL) return env.SHELL;
  try {
    const s = os.userInfo().shell;
    if (s) return s;
  } catch {}
  return '/bin/sh';
}

const fishy = (shell: string) => path.basename(shell) === 'fish';

/**
 * An agent in the interactive shell, which stays when the agent exits (window.rs
 * `unix_agent_argv`, not a login shell: Linux).
 */
export function agentArgv(shell: string, run: readonly string[]): string[] {
  const script = fishy(shell) ? 'command $argv[2..]; exec $argv[1] -i' : '"$@"; exec "$0" -i';
  return [shell, '-ic', script, shell, ...run];
}

/** programs.rs `installed_line`: functions count, aliases don't (`"$@"` can't run them). */
export function installedLine(commands: readonly string[], fish: boolean): string {
  return commands
    .map((c) => {
      const word = `'${c.replace(/'/g, "'\\''")}'`;
      const unalias = fish ? '' : `unalias -- ${word} 2>/dev/null; `;
      return `${unalias}command -v ${word} >/dev/null 2>&1 && printf 'herdr-has:%s\\n' ${word};`;
    })
    .join(' ');
}

export function parseInstalled(out: string, commands: readonly string[]): string[] {
  const found = new Set(
    out
      .split('herdr-has:')
      .slice(1)
      .map((s) => s.split(/\s/)[0]),
  );
  return commands.filter((c) => found.has(c));
}

export type Runner = (shell: string, args: string[]) => Promise<string>;

const runShell: Runner = (shell, args) =>
  new Promise((resolve) => {
    // An interactive shell without a terminal may complain on stderr; only stdout's marks count.
    execFile(shell, args, { timeout: 10_000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] } as never, (_err, stdout) =>
      resolve(String(stdout ?? '')),
    );
  });

/** Which agents this machine can start, asked of the shell they start in, at most once a minute (mods.rs `known_agents`). */
export class InstalledAgents {
  private cache: { at: number; commands: string; found: string[] } | null = null;
  private pending: Promise<string[]> | null = null;

  constructor(
    private readonly shell: string,
    private readonly run: Runner = runShell,
    private readonly now: () => number = Date.now,
  ) {}

  async check(commands: readonly string[]): Promise<string[]> {
    const key = commands.join('\n');
    if (this.cache && this.cache.commands === key && this.now() - this.cache.at < 60_000) return this.cache.found;
    if (!this.pending) {
      this.pending = this.run(this.shell, ['-ic', installedLine(commands, fishy(this.shell))])
        .then((out) => {
          const found = parseInstalled(out, commands);
          this.cache = { at: this.now(), commands: key, found };
          return found;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }
}

/** The + menu's agents as choices: installed ones, then two that aren't (new-menu mod), shown greyed. */
export function agentChoices(list: readonly Startable[], installed: readonly string[]): StartChoice[] {
  const have = new Set(installed);
  const all = list.map((s) => ({ kind: 'agent' as const, key: s.key, name: s.name, installed: have.has(s.run[0] as string) }));
  return [...all.filter((a) => a.installed), ...all.filter((a) => !a.installed).slice(0, 2)];
}
