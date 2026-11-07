import type { ConversationMeta, ConvItem, ToolResultUpdate } from '@herdr-mobile/protocol';

/** What one transcript entry turned into. */
export interface ParsedEntry {
  items: ConvItem[];
  results: ToolResultUpdate[];
}

/**
 * Reads one transcript's entries in file order. It may keep state between
 * entries (session facts for `meta`, the last compaction marker to attach its
 * summary to), so use one parser per pass over a file region.
 */
export interface TranscriptParser {
  /** One parsed JSONL line (any JSON value: unknown shapes must be ignored, never thrown on). */
  push(entry: unknown): ParsedEntry;
  /** Session facts seen so far (only fields this parser learned). */
  meta(): ConversationMeta;
}

/** The running agent process a format may be able to map to its transcript. */
export interface AgentProcess {
  pid: number;
  /** The foreground program's name ("claude"). */
  name: string;
  cwd: string | null;
}

/**
 * One agent's transcript format. Claude Code is the first; Codex, pi, ... plug
 * in by implementing this and registering in formats.ts.
 */
export interface TranscriptFormat {
  /** ConversationSource.format, e.g. "claude". */
  readonly id: string;
  /** The `agent` values of the agent-resume label this format reads ("claude"). */
  readonly agents: readonly string[];
  /** Folders its transcripts live under (the bridge serves nothing outside them). */
  roots(home: string): string[];
  createParser(): TranscriptParser;
  /** Does this entry start a new turn (a prompt the person typed)? Pages start at turn starts. */
  isTurnStart(entry: unknown): boolean;
  /** Fallback when a terminal has no agent-resume label: the transcript of this running process, if the format can tell. */
  locateProcess?(proc: AgentProcess, home: string): { session: string; path: string } | null;
}

// ---- helpers formats share ----

// CSI, OSC (BEL or ST terminated) and two-byte escapes.
const ESC = '\u001b';
const BEL = '\u0007';
const ANSI = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`, 'g');

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function timeOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Text clipped to `maxChars`, at a line end when one is near. */
export function clip(s: string, maxChars: number): { text: string; truncated: boolean } {
  if (s.length <= maxChars) return { text: s, truncated: false };
  let cut = s.lastIndexOf('\n', maxChars);
  if (cut < maxChars * 0.8) cut = maxChars;
  return { text: s.slice(0, cut), truncated: true };
}

/**
 * Long output keeps its head and its tail (where errors and summaries are),
 * with a marker line for what was left out.
 */
export function clipLines(s: string, opts: { head: number; tail: number; maxChars: number }): { text: string; truncated: boolean } {
  const lines = s.split('\n');
  let truncated = false;
  let out = s;
  if (lines.length > opts.head + opts.tail + 1) {
    const skipped = lines.length - opts.head - opts.tail;
    out = [...lines.slice(0, opts.head), `… ${skipped} more lines …`, ...lines.slice(-opts.tail)].join('\n');
    truncated = true;
  }
  const c = clip(out, opts.maxChars);
  return { text: c.text, truncated: truncated || c.truncated };
}
