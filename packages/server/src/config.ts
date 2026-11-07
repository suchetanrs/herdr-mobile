import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NtfyConfig, ntfyConfigFrom } from './notify/ntfy.js';
import { parseOverrides } from './transcripts/locate.js';
import { isLoopback, peerMatcher, resolveBind } from './transport/listen.js';

/** Connection limits (transport): every one applies before a request is authenticated. */
export interface Limits {
  /** A connection must have sent a request's headers within this (from connect or the previous request). */
  headersTimeoutMs: number;
  /** ... and the whole request within this. */
  requestTimeoutMs: number;
  /** An idle kept-alive connection is closed after this. */
  keepAliveTimeoutMs: number;
  /** How often Node checks the two timeouts above. */
  checkIntervalMs: number;
  /** Open connections on the network listeners, all peers together. */
  maxConnections: number;
  /** Open connections per peer address on the network listeners (loopback isn't limited). */
  maxConnectionsPerPeer: number;
  /** Open WebSockets per peer address on the network listeners. */
  maxWsPerPeer: number;
}

export const DEFAULT_LIMITS: Limits = {
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
  checkIntervalMs: 1_000,
  maxConnections: 512,
  maxConnectionsPerPeer: 32,
  maxWsPerPeer: 8,
};
export interface Config {
  /** The loopback address the HTTP server itself listens on (127.0.0.1). */
  host: string;
  /** HERDR_MOBILE_HOST was set to a non-loopback address (pre-1.3 setting): ignored, warned about at start. */
  legacyHost?: string;
  /**
   * HERDR_MOBILE_BIND: where else to listen (comma-separated: `loopback`, `tailscale`, `lan`, `all`, IPs).
   * Loopback is always included. loadConfig's default is `loopback,tailscale`; unset here = loopback only.
   * `lan`/`all`/LAN IPs are plain HTTP on that network (cleartext token and terminals): opt-in only.
   */
  bind?: string[];
  /** How often interfaces are re-checked for the Tailscale address (and other bind names). */
  bindPollMs?: number;
  /** Test hook: os.networkInterfaces(). */
  ifaces?: () => ReturnType<typeof os.networkInterfaces>;
  /** HERDR_MOBILE_ALLOW_PEERS: only these IPv4 addresses/CIDRs may connect over the network (empty: any). */
  allowPeers?: string[];
  /** Connection limits; missing fields take DEFAULT_LIMITS. */
  limits?: Partial<Limits>;
  /** A device session unused this long expires (default 90 days). */
  sessionIdleMs?: number;
  /** Test hook: where the log goes (default stdout). */
  logStream?: NodeJS.WritableStream;
  port: number;
  /** herdr-core's client socket. */
  socketPath: string;
  /** Ours (token etc.), never Herdr's. */
  configDir: string;
  /** Use this token instead of the stored one (tests, scripted runs). */
  token: string | null;
  doneGraceMs: number;
  heartbeatMs: number;
  logLevel: string;
  home: string;
  /** Diagnostics: also send live terminals that are in no pane (HERDR_MOBILE_INCLUDE_UNPLACED=1). */
  includeUnplaced: boolean;
  /** Write herdr.seen when a client looks at an agent (HERDR_MOBILE_SEEN_SYNC=0 turns it off). */
  seenSync: boolean;
  /** Keep a terminal's core attach this long after its last viewer left. */
  streamGraceMs: number;
  /** How often to ask the core for its machines (tests shorten it). */
  machinePollMs?: number;
  /** The built web app to serve (packages/web/dist). */
  webDir: string;
  /** herdr-app's settings folder, read only (space colors). */
  herdrAppDir: string;
  /** Where ~/.claude and its siblings are, for sessions to resume (HERDR_MOBILE_CLAUDE_HOME; default: home). */
  claudeHome?: string;
  /** Folders transcripts may also be read from, besides the agents' own (HERDR_MOBILE_TRANSCRIPT_ROOTS, ":"-separated). */
  transcriptRoots?: string[];
  /** Test hook: terminal (address or name) -> transcript (HERDR_MOBILE_TRANSCRIPT_OVERRIDE="hm-x=/abs/file.jsonl,..."). */
  transcriptOverrides?: Map<string, string>;
  /** How often an open transcript is also stat-polled (fs.watch is the fast path). */
  transcriptPollMs?: number;
  /**
   * Behind a local HTTPS proxy (`tailscale serve`): trust X-Forwarded-For/-Proto from loopback, so the
   * cookie gets `Secure` and the failed-auth limit sees real client addresses (HERDR_MOBILE_TRUST_PROXY=1).
   */
  trustProxy?: boolean;
  /** Failed sign-ins per address per 10 min before a 10 min block (HERDR_MOBILE_AUTH_MAX_FAILURES, 0 = no limit). */
  authMaxFailures?: number;
  authBlockMs?: number;
  /** Extra host names to answer to besides the bound addresses and localhost (HERDR_MOBILE_ALLOWED_HOSTS). */
  allowedHosts?: string[];
  /** Push alerts through ntfy (HERDR_MOBILE_NTFY_TOPIC/_SERVER/_TOKEN/_CLICK/_PRIVATE); null: off (default). */
  ntfy?: NtfyConfig | null;
  /** How long a client's `looking` holds without renewal (tests shorten it). */
  lookingTtlMs?: number;
  /**
   * Show which Claude login each local agent runs under (HERDR_MOBILE_ACCOUNTS=0 turns it off):
   * scans /proc for `claude` processes and reads only the account name and plan of their .claude.json.
   */
  claudeAccounts?: boolean;
  /** Test hook: /proc. */
  procRoot?: string;
  /** Test hook: which agent commands are installed (default: asked of the user's interactive shell). */
  installedAgents?: { check(commands: readonly string[]): Promise<string[]> };
}

/** herdr-core's default endpoint: $XDG_RUNTIME_DIR/herdr-core/<session>.sock (docs/security.md). */
export function defaultSocketPath(env: NodeJS.ProcessEnv): string {
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  return path.join(runtime, 'herdr-core', `${env.HC_SESSION || 'default'}.sock`);
}

function int(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${v}"`);
  return n;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Unset: loopback + Tailscale (encrypted). Anything naming a LAN must be asked for. */
function bindFrom(v: string | undefined): string[] {
  const spec = list(v);
  if (spec.length === 0) return ['loopback', 'tailscale'];
  resolveBind(spec, {}); // throws on a bad entry
  return spec;
}

/** The token from the environment: it's a password to every terminal, so a short one is refused. */
function tokenFrom(v: string | undefined): string | null {
  if (!v) return null;
  if (v.length < 32) throw new Error('HERDR_MOBILE_TOKEN must be at least 32 characters (or unset: one is generated)');
  return v;
}

/** Defaults, overridden by HERDR_MOBILE_* env vars. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || os.homedir();
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const host = env.HERDR_MOBILE_HOST || '127.0.0.1';
  const allowPeers = list(env.HERDR_MOBILE_ALLOW_PEERS);
  peerMatcher(allowPeers); // throws on a bad entry
  return {
    host: isLoopback(host) ? host : '127.0.0.1',
    ...(isLoopback(host) ? {} : { legacyHost: host }),
    bind: bindFrom(env.HERDR_MOBILE_BIND),
    allowPeers,
    port: int(env.HERDR_MOBILE_PORT, 8787, 'HERDR_MOBILE_PORT'),
    socketPath: env.HERDR_MOBILE_CORE_SOCKET || defaultSocketPath(env),
    configDir: env.HERDR_MOBILE_CONFIG_DIR || path.join(xdgConfig, 'herdr-mobile'),
    token: tokenFrom(env.HERDR_MOBILE_TOKEN),
    doneGraceMs: int(env.HERDR_MOBILE_DONE_GRACE_MS, 1200, 'HERDR_MOBILE_DONE_GRACE_MS'),
    heartbeatMs: int(env.HERDR_MOBILE_HEARTBEAT_MS, 15_000, 'HERDR_MOBILE_HEARTBEAT_MS'),
    logLevel: env.HERDR_MOBILE_LOG_LEVEL || 'info',
    home,
    includeUnplaced: env.HERDR_MOBILE_INCLUDE_UNPLACED === '1',
    seenSync: env.HERDR_MOBILE_SEEN_SYNC !== '0',
    streamGraceMs: int(env.HERDR_MOBILE_STREAM_GRACE_MS, 10_000, 'HERDR_MOBILE_STREAM_GRACE_MS'),
    webDir: env.HERDR_MOBILE_WEB_DIR || fileURLToPath(new URL('../../web/dist', import.meta.url)),
    herdrAppDir: env.HERDR_MOBILE_HERDR_APP_DIR || path.join(xdgConfig, 'herdr-app'),
    ...(env.HERDR_MOBILE_CLAUDE_HOME && path.isAbsolute(env.HERDR_MOBILE_CLAUDE_HOME) ? { claudeHome: env.HERDR_MOBILE_CLAUDE_HOME } : {}),
    transcriptRoots: (env.HERDR_MOBILE_TRANSCRIPT_ROOTS ?? '').split(':').filter((p) => path.isAbsolute(p)),
    transcriptOverrides: parseOverrides(env.HERDR_MOBILE_TRANSCRIPT_OVERRIDE),
    transcriptPollMs: int(env.HERDR_MOBILE_TRANSCRIPT_POLL_MS, 500, 'HERDR_MOBILE_TRANSCRIPT_POLL_MS'),
    trustProxy: env.HERDR_MOBILE_TRUST_PROXY === '1',
    authMaxFailures: int(env.HERDR_MOBILE_AUTH_MAX_FAILURES, 30, 'HERDR_MOBILE_AUTH_MAX_FAILURES'),
    authBlockMs: int(env.HERDR_MOBILE_AUTH_BLOCK_MS, 10 * 60_000, 'HERDR_MOBILE_AUTH_BLOCK_MS'),
    allowedHosts: list(env.HERDR_MOBILE_ALLOWED_HOSTS),
    ntfy: ntfyConfigFrom(env),
    claudeAccounts: env.HERDR_MOBILE_ACCOUNTS !== '0',
  };
}
