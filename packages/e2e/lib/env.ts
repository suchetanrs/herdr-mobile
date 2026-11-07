import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** Scratch for the e2e instance (gitignored): its token, transcript, logs, pid. */
export const WORK = path.join(REPO, '.test-tmp/e2e');
export const STATE_FILE = path.join(WORK, 'state.json');
/** Diagnostics reports sent to the e2e bridge. */
export const DIAG_FILE = path.join(WORK, 'diag.jsonl');
export const PID_FILE = path.join(WORK, 'bridge.pid');
export const LOG_FILE = path.join(WORK, 'bridge.log');
export const CONV_DIR = path.join(WORK, 'conv');
export const CONV_FILE = path.join(CONV_DIR, 'session.jsonl');

/** The user's production service (systemd), read-only checks only. */
export const SERVICE_URL = process.env.E2E_SERVICE_URL ?? 'http://127.0.0.1:8787';
export const SERVICE_UNIT = 'herdr-mobile.service';
/** The e2e instance: same build, loopback only, unplaced terminals shown, seen sync off. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8788);
export const E2E_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_TOKEN = 'e2e-token-0123456789abcdefghijklmnopqrstuvwxyz';
/** Wrong-token attempts before the e2e instance answers 429 (short block so the suite can see it end). */
export const E2E_MAX_FAILURES = 5;
export const E2E_BLOCK_MS = 2500;

export const SHELL_NAME = 'hm-e2e-sh';
export const CONV_NAME = 'hm-e2e-conv';
export const ASK_NAME = 'hm-e2e-ask';
export const HIST_NAME = 'hm-e2e-hist';
/** `less --mouse` at the end of a numbered file: a full-screen app with its own history. */
export const APP_NAME = 'hm-e2e-app';
export const APP_LINES = 300;
/** Numbered lines the history terminal prints before its shell starts. */
export const HIST_LINES = 20_000;

export interface State {
  shell: string;
  conv: string;
  /** scripts/fake-ask.py: blocked on a numbered menu until answered. */
  ask: string;
  /** Printed HIST_LINES colored, numbered lines ("hist 00001" ...), then a shell. */
  hist: string;
  app: string;
  shellSize: string;
}

/** A sign-in link (the token in the fragment), opening `hash` (a `#/...` route) once signed in. */
export function signInLink(base: string, token: string, hash = ''): string {
  return `${base}/#token=${encodeURIComponent(token)}${hash ? `&${hash.replace(/^#/, '')}` : ''}`;
}

/** The production service's token: HERDR_MOBILE_TOKEN wins over the file, as in the bridge (its env file may set it). */
export function serviceToken(): string {
  if (process.env.HERDR_MOBILE_TOKEN) return process.env.HERDR_MOBILE_TOKEN;
  return fs.readFileSync(path.join(os.homedir(), '.config/herdr-mobile/token'), 'utf8').trim();
}

export function readState(): State {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State;
}

export const hc = (...args: string[]) => execFileSync('hc', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// biome-ignore lint/suspicious/noExplicitAny: hc's JSON output
export const hcJson = (...args: string[]): any => JSON.parse(hc(...args, '--json'));
export const screenText = (addr: string): string => hcJson('read', addr).text as string;
export const sizeOf = (addr: string): string => {
  const t = hcJson('get', addr);
  return `${t.cols}x${t.rows}`;
};

/** A throwaway terminal (no pane, no parent, no notifications, no herdr.* labels). */
export function throwaway(name: string, argv: string[], cwd: string): string {
  const out = hc('run', '--bg', '--no-parent', '--no-notify', '--json', '--name', name, '--cwd', cwd, '--', ...argv);
  return JSON.parse(out).address as string;
}

export function removeTerminal(addr: string): void {
  for (const cmd of ['kill', 'rm']) {
    try {
      hc(cmd, addr);
    } catch {}
  }
}

export async function until<T>(fn: () => T | Promise<T>, ms = 10_000, step = 50): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
}

/** Up (public health); with `core`, also herdr-core connected (the full report: the token as a local tool). */
async function healthy(url: string, core = false): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, core ? { headers: { authorization: `Bearer ${E2E_TOKEN}` } } : {});
    return r.ok && (!core || ((await r.json()) as { core?: { connected: boolean } }).core?.connected === true);
  } catch {
    return false;
  }
}

/** Starts the e2e bridge from the production build (packages/server/dist) and waits until it answers. */
export async function startInstance(): Promise<number> {
  fs.mkdirSync(WORK, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(REPO, 'packages/server/dist/main.js')], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      HERDR_MOBILE_HOST: '127.0.0.1',
      HERDR_MOBILE_BIND: 'loopback',
      HERDR_MOBILE_PORT: String(E2E_PORT),
      HERDR_MOBILE_CONFIG_DIR: path.join(WORK, 'cfg'),
      HERDR_MOBILE_DIAG_FILE: DIAG_FILE,
      HERDR_MOBILE_TOKEN: E2E_TOKEN,
      HERDR_MOBILE_INCLUDE_UNPLACED: '1',
      HERDR_MOBILE_SEEN_SYNC: '0',
      HERDR_MOBILE_TRANSCRIPT_ROOTS: CONV_DIR,
      HERDR_MOBILE_TRANSCRIPT_OVERRIDE: `${CONV_NAME}=${CONV_FILE}`,
      HERDR_MOBILE_AUTH_MAX_FAILURES: String(E2E_MAX_FAILURES),
      HERDR_MOBILE_AUTH_BLOCK_MS: String(E2E_BLOCK_MS),
    },
  });
  child.unref();
  fs.closeSync(log);
  const pid = child.pid ?? 0;
  fs.writeFileSync(PID_FILE, String(pid));
  if (!(await until(() => healthy(E2E_URL, true), 15_000))) throw new Error(`e2e bridge did not start; see ${LOG_FILE}`);
  return pid;
}

/** Stops the e2e bridge by its saved pid (never by pattern) and waits for the port to free up. */
export async function stopInstance(): Promise<void> {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return;
  }
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    const gone = await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 8000);
    if (!gone) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  fs.rmSync(PID_FILE, { force: true });
  await until(async () => !(await healthy(E2E_URL)), 5000);
}
