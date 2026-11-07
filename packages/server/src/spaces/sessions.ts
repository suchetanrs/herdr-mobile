import fs from 'node:fs';
import path from 'node:path';
import type { AgentAccount, ClaudeConfigChoice, ResumableSession, World } from '@herdr-mobile/protocol';
import { SESSIONS_MAX } from '@herdr-mobile/protocol';
import { accountOf, parseEnviron } from '../accounts/scan.js';
import { configDirs, projectDirName, typedText } from '../transcripts/claude.js';

/**
 * Claude Code sessions that can be resumed in a folder, read only.
 *
 * Claude Code keeps a session as `<config>/projects/<folder with every non-alphanumeric as ->/<id>.jsonl`,
 * where `<config>` is `~/.claude` (plain `claude`) or a CLAUDE_CONFIG_DIR (`~/.claude-work`), and
 * `claude --resume <id>` finds it there for that folder. Config folders may share one `projects`
 * folder by a symlink (a second login with the same history): the transcripts are then counted
 * once, and each says which config it belongs to (the one whose `.claude.json` names it the
 * folder's last session, else the default one, else the one that owns the folder).
 * Running sessions come from Claude's registry (`<config>/sessions/<pid>.json` of a live `claude`).
 */

/** Claude Code's session ids. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFIG_NAME = /^\.claude(-[A-Za-z0-9._-]{1,64})?$/;
/** Lines longer than this are tool output or pasted files: skipped when summing a transcript up. */
const LINE_MAX = 2 << 20;
const CHUNK = 1 << 20;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

export interface ClaudeConfig {
  /** ".claude", ".claude-work". */
  id: string;
  dir: string;
  isDefault: boolean;
  /** The real `projects` folder (symlinks followed): configs that share one share sessions. */
  projects: string;
  /** Where its login and per-folder facts are: `~/.claude.json` for the default, else `<dir>/.claude.json`. */
  stateFile: string;
}

/** The config folders in `home` that have a `projects` folder. */
export function claudeConfigs(home: string): ClaudeConfig[] {
  const out: ClaudeConfig[] = [];
  for (const dir of configDirs(home)) {
    const id = path.basename(dir);
    if (!CONFIG_NAME.test(id)) continue;
    let projects: string;
    try {
      projects = fs.realpathSync(path.join(dir, 'projects'));
      if (!fs.statSync(projects).isDirectory()) continue;
    } catch {
      continue;
    }
    const isDefault = id === '.claude';
    out.push({ id, dir, isDefault, projects, stateFile: isDefault ? path.join(home, '.claude.json') : path.join(dir, '.claude.json') });
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.id < b.id ? -1 : 1));
}

export function oneLine(s: string, max = 160): string {
  const t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

interface Summary {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes read so far (whole lines). */
  offset: number;
  prompt: string | null;
  command: string | null;
  title: string | null;
  customTitle: boolean;
  cwd: string | null;
  messages: number;
  lastAssistant: string | null;
}

/** What a transcript says about itself, read once and then only what was appended. */
export class TranscriptSummaries {
  private readonly cache = new Map<string, Summary>();
  /** Bytes read (tests). */
  bytesRead = 0;

  get(file: string): Summary | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) return null;
    } catch {
      this.cache.delete(file);
      return null;
    }
    let s = this.cache.get(file);
    if (s && s.ino === st.ino && s.size === st.size && s.mtimeMs === st.mtimeMs) return s;
    if (!s || s.ino !== st.ino || st.size < s.offset) {
      s = {
        ino: st.ino,
        size: 0,
        mtimeMs: 0,
        offset: 0,
        prompt: null,
        command: null,
        title: null,
        customTitle: false,
        cwd: null,
        messages: 0,
        lastAssistant: null,
      };
    }
    this.readFrom(file, s, st.size);
    s.size = st.size;
    s.mtimeMs = st.mtimeMs;
    this.cache.set(file, s);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value as string);
    return s;
  }

  private readFrom(file: string, s: Summary, size: number): void {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      let pos = s.offset;
      let rest: Buffer = Buffer.alloc(0);
      let skipping = false;
      const buf = Buffer.alloc(CHUNK);
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        this.bytesRead += n;
        let data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl === -1) break;
          if (!skipping) this.line(s, data.subarray(start, nl));
          skipping = false;
          start = nl + 1;
          s.offset = pos - (data.length - start);
        }
        data = data.subarray(start);
        if (data.length > LINE_MAX) {
          skipping = true;
          data = Buffer.alloc(0);
        }
        rest = Buffer.from(data);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private line(s: Summary, raw: Buffer): void {
    if (raw.length < 2 || raw.length > LINE_MAX) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!e || typeof e !== 'object') return;
    if (s.cwd === null && typeof e.cwd === 'string' && e.isSidechain !== true) s.cwd = e.cwd;
    switch (e.type) {
      case 'custom-title':
        if (typeof e.customTitle === 'string' && e.customTitle.trim()) {
          s.title = oneLine(e.customTitle, 120);
          s.customTitle = true;
        }
        return;
      case 'ai-title':
      case 'summary': {
        const t = typeof e.aiTitle === 'string' ? e.aiTitle : typeof e.summary === 'string' ? e.summary : '';
        if (t.trim() && !s.customTitle) s.title = oneLine(t, 120);
        return;
      }
      case 'user': {
        const typed = typedText(e);
        if (!typed) return;
        s.messages++;
        if (typed.kind === 'prompt') s.prompt ??= oneLine(typed.text);
        else s.command ??= oneLine(typed.text);
        return;
      }
      case 'assistant': {
        if (e.isSidechain === true) return;
        const m = e.message as Record<string, unknown> | undefined;
        const id = m && typeof m.id === 'string' ? m.id : null;
        // One reply is written as several entries (one per content block) sharing its message id.
        if (id === null || id !== s.lastAssistant) s.messages++;
        s.lastAssistant = id;
        return;
      }
    }
  }
}

interface StateFacts {
  stamp: string;
  account: AgentAccount | null;
  /** folder -> the last session Claude ran there with this config. */
  last: Map<string, string>;
}

/** The two things read from a config's `.claude.json`: its login, and each folder's last session. */
class StateFiles {
  private readonly cache = new Map<string, StateFacts>();

  get(file: string): StateFacts | null {
    let stamp: string;
    try {
      const st = fs.statSync(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
    const have = this.cache.get(file);
    if (have?.stamp === stamp) return have;
    const facts: StateFacts = { stamp, account: null, last: new Map() };
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      facts.account = accountOf(j);
      const projects = j.projects;
      if (projects && typeof projects === 'object') {
        for (const [folder, p] of Object.entries(projects as Record<string, unknown>)) {
          const id = p && typeof p === 'object' ? (p as Record<string, unknown>).lastSessionId : null;
          if (typeof id === 'string' && SESSION_ID.test(id)) facts.last.set(folder, id);
        }
      }
    } catch {
      // Unreadable or mid-write: no login shown, no hints.
    }
    this.cache.set(file, facts);
    return facts;
  }
}

export interface RunningSession {
  pid: number;
  /** The Herdr terminal it runs in (HC_TERMINAL_ID of its process), if any. */
  terminal: string | null;
}

export interface SessionsOptions {
  /** The folder that holds ~/.claude and its siblings (the home folder; tests: a fixture). */
  home: string;
  /** /proc (tests: a fixture); none: running sessions are found by `kill(pid, 0)` only. */
  procRoot?: string;
  /** The core socket the bridge uses (a `claude` in another core's terminal isn't placed by its id). */
  coreSocket?: string;
}

/** A folder's sessions, the configs that can resume them, and which ones are running now. */
export class ClaudeSessions {
  readonly summaries = new TranscriptSummaries();
  private readonly states = new StateFiles();

  constructor(private readonly opts: SessionsOptions) {}

  configs(): ClaudeConfig[] {
    return claudeConfigs(this.opts.home);
  }

  /** The configs that can see sessions of `folder`, with their logins. */
  choices(configs: ClaudeConfig[]): ClaudeConfigChoice[] {
    return configs.map((c) => {
      const a = this.states.get(c.stateFile)?.account;
      const label = a ? (a.plan ? `${a.name} · ${a.plan}` : a.name) : `~/${c.id}`;
      return { id: c.id, label, isDefault: c.isDefault };
    });
  }

  /**
   * The resumable sessions of `folder`, newest first (at most SESSIONS_MAX), each once even when
   * several configs share the transcripts. `world` marks the ones running in a terminal it shows.
   */
  list(folder: string, world: World, configs = this.configs()): ResumableSession[] {
    const running = this.running(configs);
    const byStore = new Map<string, ClaudeConfig[]>();
    for (const c of configs) byStore.set(c.projects, [...(byStore.get(c.projects) ?? []), c]);
    const files: Array<{ id: string; file: string; mtimeMs: number; owners: ClaudeConfig[] }> = [];
    for (const [store, owners] of byStore) {
      const dir = path.join(store, projectDirName(folder));
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.jsonl') || !SESSION_ID.test(n.slice(0, -6))) continue;
        const file = path.join(dir, n);
        try {
          const st = fs.statSync(file);
          if (st.isFile()) files.push({ id: n.slice(0, -6), file, mtimeMs: st.mtimeMs, owners });
        } catch {}
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: ResumableSession[] = [];
    for (const f of files) {
      if (out.length >= SESSIONS_MAX) break;
      const s = this.summaries.get(f.file);
      // Nothing typed into it yet (Claude's own picker leaves these out too), or another folder's
      // that encodes the same (`a/b-c` and `a/b/c`).
      if (!s || (s.prompt === null && s.command === null)) continue;
      if (s.cwd !== null && s.cwd !== folder) continue;
      const run = running.get(f.id);
      const shown = run?.terminal && world.terminals[run.terminal]?.spaceId ? run.terminal : null;
      out.push({
        id: f.id,
        title: s.title,
        prompt: s.prompt ?? s.command ?? '',
        modifiedMs: Math.round(f.mtimeMs),
        messages: s.messages,
        config: this.ownerOf(f.id, folder, f.owners).id,
        openIn: shown ?? this.openInWorld(f.file, world),
        runningElsewhere: Boolean(run) && !shown,
      });
    }
    // A session found open through the world's transcript is open there, not elsewhere.
    for (const s of out) if (s.openIn) s.runningElsewhere = false;
    return out;
  }

  /** The config `id` names, when `session` of `folder` exists in its projects. */
  resolve(folder: string, session: string, configId: string | undefined, configs = this.configs()): ClaudeConfig | null {
    if (!SESSION_ID.test(session)) return null;
    const has = (c: ClaudeConfig) => {
      try {
        return fs.statSync(path.join(c.projects, projectDirName(folder), `${session}.jsonl`)).isFile();
      } catch {
        return false;
      }
    };
    if (configId !== undefined) {
      const c = configs.find((x) => x.id === configId);
      return c && has(c) ? c : null;
    }
    const owners = configs.filter(has);
    return owners.length ? this.ownerOf(session, folder, owners) : null;
  }

  /** Whether `session` runs now (Claude's registry, a live `claude` process). */
  isRunning(session: string, configs = this.configs()): boolean {
    return this.running(configs).has(session);
  }

  private ownerOf(session: string, folder: string, owners: ClaudeConfig[]): ClaudeConfig {
    if (owners.length > 1) {
      const named = owners.find((c) => this.states.get(c.stateFile)?.last.get(folder) === session);
      if (named) return named;
    }
    return (
      owners.find((c) => c.isDefault) ?? owners.find((c) => c.projects === path.join(c.dir, 'projects')) ?? (owners[0] as ClaudeConfig)
    );
  }

  /** A shown terminal whose `claude` writes this transcript (its agent-resume label or registry). */
  private openInWorld(file: string, world: World): string | null {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return null;
    }
    for (const t of Object.values(world.terminals)) {
      if (t.machine === null && t.spaceId && t.program === 'claude' && t.transcript === real) return t.id;
    }
    return null;
  }

  /** session id -> its live `claude` process, from every config's registry (each read once). */
  private running(configs: ClaudeConfig[]): Map<string, RunningSession> {
    const out = new Map<string, RunningSession>();
    const seen = new Set<string>();
    for (const c of configs) {
      let dir: string;
      try {
        dir = fs.realpathSync(path.join(c.dir, 'sessions'));
      } catch {
        continue;
      }
      if (seen.has(dir)) continue;
      seen.add(dir);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!/^\d{1,10}\.json$/.test(n)) continue;
        let info: Record<string, unknown>;
        try {
          info = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        } catch {
          continue;
        }
        const pid = info.pid;
        const sid = info.sessionId;
        if (typeof pid !== 'number' || `${pid}.json` !== n || typeof sid !== 'string' || !SESSION_ID.test(sid)) continue;
        if (!this.isClaude(pid)) continue;
        out.set(sid, { pid, terminal: this.terminalOf(pid) });
      }
    }
    return out;
  }

  private isClaude(pid: number): boolean {
    const proc = this.opts.procRoot ?? (process.platform === 'linux' ? '/proc' : null);
    if (proc) {
      try {
        return fs.readFileSync(path.join(proc, String(pid), 'comm'), 'utf8').trim() === 'claude';
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private terminalOf(pid: number): string | null {
    const proc = this.opts.procRoot ?? (process.platform === 'linux' ? '/proc' : null);
    if (!proc) return null;
    try {
      const env = parseEnviron(fs.readFileSync(path.join(proc, String(pid), 'environ')));
      const id = env.get('HC_TERMINAL_ID');
      const socket = env.get('HC_TERMINAL_SOCKET');
      // Another core's terminal ids aren't ours.
      if (this.opts.coreSocket && socket && path.resolve(socket) !== path.resolve(this.opts.coreSocket)) return null;
      return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }
}
