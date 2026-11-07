import type { AttentionAlert } from './attention.js';
import type { ConversationClientMessage, ConversationServerMessage } from './conversation.js';
import type { PatchOp } from './patch.js';
import type { TerminalClientMessage, TerminalServerMessage } from './terminal.js';
import type { World } from './world.js';

/**
 * WebSocket text frames are one JSON message each. The stream of world changes
 * and alerts is numbered (`seq`) so a client that reconnects to the same server
 * (`serverId`) can resume from the last `seq` it applied instead of reloading.
 */

// ---- server -> client ----

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  /** Changes when the bridge restarts: a client can only resume within one serverId. */
  serverId: string;
  /** The bridge sends `hb` this often; a client that hears nothing for ~2x should reconnect. */
  heartbeatMs: number;
  /** The web app build the bridge serves now (git sha + build time); a page from another build reloads. */
  build?: string;
}

export interface SnapshotMessage {
  t: 'snapshot';
  seq: number;
  world: World;
  /** Recent alerts, oldest first, so a fresh page can show what it missed. */
  alerts: AttentionAlert[];
}

export interface PatchMessage {
  t: 'patch';
  seq: number;
  ops: PatchOp[];
}

export interface AlertMessage {
  t: 'alert';
  seq: number;
  alert: AttentionAlert;
}

export interface HeartbeatMessage {
  t: 'hb';
  /** The latest seq, so a client can tell it's up to date. */
  seq: number;
  ts: number;
}

export interface ErrorMessage {
  t: 'error';
  code: 'bad_message' | 'version' | 'unauthorized' | 'unavailable' | 'internal';
  message: string;
}

/** Numbered messages: the ones a resume replays. */
export type StreamMessage = PatchMessage | AlertMessage;

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | StreamMessage
  | HeartbeatMessage
  | ErrorMessage
  | TerminalServerMessage
  | ConversationServerMessage;

// ---- client -> server ----

export interface HelloMessage {
  t: 'hello';
  v: number;
  /** Resume after a reconnect; the server answers with the missed messages or a fresh snapshot. */
  resume?: { serverId: string; seq: number };
}

export interface PingMessage {
  t: 'ping';
}

/**
 * The person is looking at these terminals (page visible and focused, agent on screen).
 * Feeds the attention rule ("finished" doesn't alert for what you're watching) and seen sync.
 * A lease: the client repeats it every LOOKING_RENEW_MS while it holds; the bridge forgets it
 * LOOKING_TTL_MS after the last one (a phone that locks may never get `[]` out).
 */
export interface LookingMessage {
  t: 'looking';
  terminalIds: string[];
}

export const LOOKING_RENEW_MS = 4000;
export const LOOKING_TTL_MS = 10_000;
/** Most terminal ids one `looking` may name. */
export const LOOKING_MAX_IDS = 64;

export type ClientMessage = HelloMessage | PingMessage | LookingMessage | TerminalClientMessage | ConversationClientMessage;

const CLIENT_TYPES = new Set([
  'hello',
  'ping',
  'looking',
  'term.open',
  'term.close',
  'term.resync',
  'term.keys',
  'term.send',
  'term.answer',
  'term.history',
  'term.appHistory',
  'conv.open',
  'conv.more',
  'conv.close',
]);

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;
const isOptInt = (x: unknown) => x === undefined || isInt(x);
const isId = (x: unknown) => typeof x === 'string' && x.length >= 1 && x.length <= 64;
const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((k) => typeof k === 'string');

/** Parses one client text frame; null when it isn't a known message. Field checks are shallow on purpose. */
export function parseClientMessage(text: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const t = (v as { t?: unknown }).t;
  if (typeof t !== 'string' || !CLIENT_TYPES.has(t)) return null;
  const m = v as Record<string, unknown>;
  if (t === 'hello' && typeof m.v !== 'number') return null;
  if (t === 'looking' && !(isStrings(m.terminalIds) && m.terminalIds.length <= LOOKING_MAX_IDS)) return null;
  if (t === 'term.open' && !(isInt(m.req) && typeof m.terminalId === 'string' && isOptInt(m.history))) return null;
  if ((t === 'term.close' || t === 'term.resync') && !isInt(m.stream)) return null;
  if ((t === 'term.keys' || t === 'term.answer') && !(isOptInt(m.req) && typeof m.terminalId === 'string' && isStrings(m.keys)))
    return null;
  if (t === 'term.answer' && !isOptInt(m.turn)) return null;
  if (t === 'term.send' && !(isOptInt(m.req) && typeof m.terminalId === 'string' && typeof m.text === 'string')) return null;
  if (t === 'term.send' && m.force !== undefined && typeof m.force !== 'boolean') return null;
  if (t === 'term.send' && m.enter !== undefined && typeof m.enter !== 'boolean') return null;
  if ((t === 'term.send' || t === 'term.keys' || t === 'term.answer') && m.id !== undefined && !isId(m.id)) return null;
  if (t === 'term.history') {
    const c = m.cursor as Record<string, unknown> | null | undefined;
    if (!(isInt(m.req) && isInt(m.stream) && typeof c === 'object' && c !== null && isInt(c.epoch) && isInt(c.line))) return null;
    if (!((m.dir === 'older' || m.dir === 'newer') && isOptInt(m.limit))) return null;
  }
  if (t === 'term.appHistory' && !(isInt(m.req) && isInt(m.stream) && isOptInt(m.lines))) return null;
  if (t === 'conv.open' && !(isInt(m.req) && typeof m.terminalId === 'string' && isOptInt(m.turns))) return null;
  if (t === 'conv.more' && !(isInt(m.req) && isInt(m.stream) && isInt(m.before) && isOptInt(m.turns))) return null;
  if (t === 'conv.close' && !isInt(m.stream)) return null;
  return v as ClientMessage;
}
