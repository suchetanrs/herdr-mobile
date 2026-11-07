import fs from 'node:fs';
import path from 'node:path';
import { projectDirName } from '../transcripts/claude.js';

/**
 * What the bridge may ask the core. The core socket can do anything (it's the
 * user's own shell), so this is an allowlist of the methods the bridge uses,
 * with their writes narrowed further: no layout document writes at all, labels
 * only `herdr.seen=<turn>` (seen sync, docs/labels.md), and attaches only
 * read-only (`observe`) or typing ones that are `resumed` at a real size (a
 * resumed attach never takes the terminal's size by attaching). `machine.exec` only runs the
 * desktop's read-only `git -C <dir> rev-parse --show-toplevel --abbrev-ref HEAD` on another
 * machine (naming an unnamed remote space, window.rs `folder_info`).
 *
 * New spaces (the one structural thing the app may do): `terminal.run` only in the exact shape
 * herdr-app's `spawn` uses (window.rs: labels `herdr.space`/`herdr.tab` with fresh ids and
 * `herdr.seen=0`, keep, its env), running the shell, or a launch the spaces module allowed
 * (`allowLaunches`: an installed agent in the interactive shell, or a core template).
 * `terminal.kill`/`terminal.rm` only for terminals the bridge started itself (a space Herdr
 * never adopted is cleaned up). New tabs in an open space (the + in a space) go the same way, with the
 * space's own id and a fresh tab id: plain shell, Claude Code as the + menu starts it, or
 * `claude --resume <uuid>` (optionally `env CLAUDE_CONFIG_DIR=<config>` first) of a session whose
 * transcript is in that folder's project folder of that config. Every run must have been announced
 * by the spaces module (`expectRun`: it checked the space exists, or made the id), once.
 * `templates.list` is read only. `terminal.read` only as `{terminal, lines}` (a
 * full-screen app's history on the person's request, terminal/upstream.ts `appHistory`).
 */
const ALLOWED_METHODS = new Set([
  'hello',
  'server.status',
  'events.subscribe',
  'machine.list',
  'doc.get',
  'terminal.get',
  'terminal.read',
  'terminal.attach',
  'terminal.send',
  'terminal.label',
  'machine.exec',
  'templates.list',
  'terminal.run',
  'terminal.kill',
  'terminal.rm',
]);

/** herdr-app's `HerdrCore::run` env (hc.rs). */
export const SPAWN_ENV: Readonly<Record<string, string>> = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'herdr' };
/** herdr-app's fresh ids (model.rs `fresh_id`): prefix + 32 hex digits. */
export const SPACE_ID = /^sp[0-9a-f]{32}$/;
export const TAB_ID = /^tb[0-9a-f]{32}$/;

const launches = new Set<string>();
const started = new Set<string>();
const madeSpaces = new Set<string>();
const madeTabs = new Set<string>();
/** Runs the spaces module announced, by `<space>/<tab>`: each may happen once. */
const expected = new Map<string, Expected>();
let resumeBase: string[] | null = null;

interface Expected {
  argv: string[];
  /** A resume: the config folder whose projects must hold the session. */
  resumeConfig?: string;
}

/** Claude Code's session ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFIG_DIR = /^\/(?:[^\0]+\/)?\.claude(?:-[A-Za-z0-9._-]{1,64})?$/;

/** The next `terminal.run` for this space/tab, with exactly this argv (the spaces module checked the rest). */
export function expectRun(space: string, tab: string, argv: readonly string[], resumeConfig?: string): void {
  expected.set(`${space}/${tab}`, { argv: [...argv], ...(resumeConfig ? { resumeConfig } : {}) });
  if (expected.size > 32) expected.delete(expected.keys().next().value as string);
}

/** Forgets an announced run that didn't happen. */
export function unexpectRun(space: string, tab: string): void {
  expected.delete(`${space}/${tab}`);
}

/** Claude Code as the + menu starts it (an allowed launch): `--resume <id>` may follow it. */
export function allowResume(argv: readonly string[] | null): void {
  resumeBase = argv ? [...argv] : null;
}

/** A tab the bridge added to an open space: it may end its terminal and name that tab (only those). */
export function markStartedTab(address: string, tabId: string): void {
  started.add(address);
  madeTabs.add(tabId);
}

/** The exact argv vectors `terminal.run` may start besides the shell (replaces the previous list). */
export function allowLaunches(argvs: readonly (readonly string[])[]): void {
  launches.clear();
  for (const a of argvs) launches.add(JSON.stringify(a));
}

/** A terminal the bridge started (for a space it made): it may end it again, and name that space (only those). */
export function markStarted(address: string, spaceId: string): void {
  started.add(address);
  madeSpaces.add(spaceId);
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

const positive = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x > 0;

export function checkCall(method: string, params: unknown): void {
  if (!ALLOWED_METHODS.has(method)) throw new PolicyError(`${method} is not allowed from herdr-mobile`);
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === 'terminal.attach' && p.observe !== true) {
    if (p.resumed !== true || !positive(p.cols) || !positive(p.rows)) {
      throw new PolicyError('herdr-mobile only attaches to type when resumed at the terminal size');
    }
  }
  // A full-screen app's history on request (term.appHistory): lines only, within herdr-core's cap.
  if (method === 'terminal.read') {
    const keys = Object.keys(p).sort().join(',');
    if (keys !== 'lines,terminal' || typeof p.terminal !== 'string' || !positive(p.lines) || (p.lines as number) > 1000) {
      throw new PolicyError('herdr-mobile only reads a terminal as {terminal, lines <= 1000}');
    }
  }
  if (method === 'machine.exec') {
    const argv = p.argv;
    const fixed = ['git', '-C', null, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'];
    const ok =
      Array.isArray(argv) &&
      argv.length === fixed.length &&
      argv.every((a, i) => (fixed[i] === null ? typeof a === 'string' && a.startsWith('/') : a === fixed[i])) &&
      typeof p.on === 'string' &&
      p.on !== '' &&
      Object.keys(p).every((k) => k === 'on' || k === 'argv' || k === 'timeout');
    if (!ok) throw new PolicyError('herdr-mobile only runs `git rev-parse` on other machines');
  }
  if (method === 'terminal.run') checkRun(p);
  if (method === 'terminal.kill' || method === 'terminal.rm') {
    if (Object.keys(p).some((k) => k !== 'terminal') || typeof p.terminal !== 'string' || !started.has(p.terminal)) {
      throw new PolicyError('herdr-mobile only ends terminals it started');
    }
  }
  if (method === 'terminal.label') {
    const labels = (p.labels ?? {}) as Record<string, unknown>;
    if (Object.hasOwn(labels, 'herdr.pinned')) throw new PolicyError('herdr-mobile never writes herdr.pinned');
    const keys = Object.keys(labels);
    const seen = labels['herdr.seen'];
    if (keys.length !== 1 || keys[0] !== 'herdr.seen' || typeof seen !== 'string' || !/^\d{1,15}$/.test(seen)) {
      throw new PolicyError('herdr-mobile only writes herdr.seen=<turn> labels');
    }
  }
}

function checkRun(p: Record<string, unknown>): void {
  const fail = (why: string) => {
    throw new PolicyError(`herdr-mobile only starts a new space's or tab's terminal: ${why}`);
  };
  const keys = new Set(['argv', 'cwd', 'env', 'labels', 'keep', 'size']);
  for (const k of Object.keys(p)) if (!keys.has(k)) fail(`no ${k}`);
  if (p.keep !== true) fail('keep it');
  const env = p.env as Record<string, unknown> | undefined;
  if (!env || typeof env !== 'object' || JSON.stringify(env) !== JSON.stringify(SPAWN_ENV)) fail("herdr-app's env only");
  const labels = (p.labels ?? {}) as Record<string, unknown>;
  const names = Object.keys(labels).sort();
  if (
    names.join() !== 'herdr.seen,herdr.space,herdr.tab' ||
    labels['herdr.seen'] !== '0' ||
    typeof labels['herdr.space'] !== 'string' ||
    !SPACE_ID.test(labels['herdr.space']) ||
    typeof labels['herdr.tab'] !== 'string' ||
    !TAB_ID.test(labels['herdr.tab'])
  ) {
    fail('new herdr.space/herdr.tab ids and herdr.seen=0 only');
  }
  const key = `${labels['herdr.space']}/${labels['herdr.tab']}`;
  const want = expected.get(key);
  if (!want) fail('a space or tab the bridge is making');
  expected.delete(key);
  if (typeof p.cwd !== 'string' || !p.cwd.startsWith('/') || p.cwd.includes('\0') || p.cwd.length > 4096) fail('an absolute folder');
  if (p.size !== undefined) {
    const s = p.size as Record<string, unknown>;
    if (
      !s ||
      Object.keys(s).sort().join() !== 'cols,rows' ||
      !positive(s.cols) ||
      !positive(s.rows) ||
      (s.cols as number) > 1000 ||
      (s.rows as number) > 1000
    ) {
      fail('a plain size');
    }
  }
  const argv = p.argv;
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) fail('argv strings');
  const a = argv as string[];
  if (JSON.stringify(a) !== JSON.stringify(want?.argv)) fail('what the bridge announced');
  if (a.length > 0 && !launches.has(JSON.stringify(a)) && !isResume(a, p.cwd as string, want?.resumeConfig)) {
    fail('the shell, an offered agent, or resuming a Claude session of that folder');
  }
}

/** `<claude as the + menu starts it> --resume <uuid>`, maybe with `env CLAUDE_CONFIG_DIR=<config>` before the program. */
function isResume(argv: string[], cwd: string, config: string | undefined): boolean {
  const base = resumeBase;
  if (!base || base.length < 5 || !config || !CONFIG_DIR.test(config) || path.normalize(config) !== config) return false;
  const wrapper = base.slice(0, 4);
  if (JSON.stringify(argv.slice(0, 4)) !== JSON.stringify(wrapper)) return false;
  let rest = argv.slice(4);
  if (rest[0] === 'env') {
    if (rest[1] !== `CLAUDE_CONFIG_DIR=${config}`) return false;
    rest = rest.slice(2);
  } else if (path.basename(config) !== '.claude') {
    return false;
  }
  const id = rest.at(-1) ?? '';
  if (JSON.stringify(rest) !== JSON.stringify([...base.slice(4), '--resume', id]) || !UUID.test(id)) return false;
  try {
    return fs.statSync(path.join(config, 'projects', projectDirName(cwd), `${id}.jsonl`)).isFile();
  } catch {
    return false;
  }
}

/**
 * What the bridge may ask the Herdr window over its control socket (`herdr-app status`/`do`):
 * whether it is open, and naming a space the bridge just made (`space.rename`), nothing else.
 */
export function checkAppRequest(msg: unknown): void {
  const m = (msg ?? {}) as Record<string, unknown>;
  const keys = Object.keys(m).sort().join();
  if (keys === 'status' && m.status === true) return;
  const args = (m.args ?? {}) as Record<string, unknown>;
  if (
    keys === 'args,do' &&
    m.do === 'tab.rename' &&
    Object.keys(args).sort().join() === 'id,name' &&
    typeof args.id === 'string' &&
    madeTabs.has(args.id) &&
    typeof args.name === 'string' &&
    args.name.length <= 64
  ) {
    return;
  }
  if (
    keys === 'args,do' &&
    m.do === 'space.rename' &&
    Object.keys(args).sort().join() === 'id,name' &&
    typeof args.id === 'string' &&
    madeSpaces.has(args.id) &&
    typeof args.name === 'string' &&
    args.name.length <= 64
  ) {
    return;
  }
  throw new PolicyError('herdr-mobile only asks Herdr whether it is open and names the spaces and tabs it made');
}
