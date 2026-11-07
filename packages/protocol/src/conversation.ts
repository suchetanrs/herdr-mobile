/**
 * Conversation channel (conversation protocol v1, carried inside bridge protocol v1):
 * an agent's own transcript (Claude Code's session JSONL today) as typed chat items,
 * live.
 *
 * Lifecycle of a stream (ids are per connection, like terminal streams):
 *   conv.open -> conv.opened with the source and the newest page of items
 *   (the last few turns), then conv.items as the transcript grows.
 *   conv.more -> conv.page: older items, before a cursor the server handed out.
 *   conv.reset: the transcript changed under the stream (the agent started a new
 *   session: /clear, restart; or the file was replaced). Throw everything away and
 *   show the page it carries.
 *   conv.closed: the stream is over (`no_transcript`, `gone`, `closed`, `unavailable`).
 *
 * Items are upserts keyed by `id`: an item the client already has is replaced in
 * place, a new one goes at the end (or, from conv.page, at the start). A tool's
 * result can arrive on its own (`results`): merge it into the tool item with that
 * id, or keep it until that item arrives (older page).
 *
 * The bridge reads transcripts only; input still goes through the terminal
 * (`term.send`), so the agent's own permissions apply.
 */

/** Bumped when a conversation message or item changes incompatibly; sent in `conv.opened`. */
export const CONVERSATION_PROTOCOL_VERSION = 1;

export const CONVERSATION_LIMITS = {
  /** Default and largest number of turns in one page. */
  defaultTurns: 4,
  maxTurns: 50,
} as const;

/** Where a conversation comes from. Formats other than Claude Code plug in on the server. */
export interface ConversationSource {
  /** The transcript format: "claude" (Claude Code). Later: "codex", "pi", ... */
  format: string;
  /** The agent's session id, when the format has one. */
  session: string | null;
  /** The transcript file (absolute, on the bridge's machine). */
  path: string;
}

/** Facts about the session that change as it goes. Every field is optional. */
export interface ConversationMeta {
  title?: string | null;
  model?: string | null;
  /** Tokens in the context at the last request (input + cache read + cache write). */
  contextTokens?: number | null;
  /** The session's cost so far, as the agent reports it. */
  costUsd?: number | null;
  permissionMode?: string | null;
}

interface ItemBase {
  /** Stable id: the same entry always yields the same id. Tool items use the tool call id. */
  id: string;
  /** ms since the epoch; null when the entry had no timestamp. */
  ts: number | null;
}

/** What the person typed (or a slash command / shell command they ran). */
export interface UserItem extends ItemBase {
  kind: 'user';
  text: string;
  /** `prompt`: typed text; `command`: a slash command ("/model opus"); `shell`: a `!` command. */
  source: 'prompt' | 'command' | 'shell';
  /** Images attached to the message. */
  images: number;
  truncated?: boolean;
}

/** The agent's reply text, markdown. */
export interface AssistantItem extends ItemBase {
  kind: 'assistant';
  text: string;
  model?: string | null;
  truncated?: boolean;
}

/** The agent's reasoning. Some models only record that it thought (empty text). */
export interface ThinkingItem extends ItemBase {
  kind: 'thinking';
  text: string;
  durationMs?: number | null;
  truncated?: boolean;
}

/** One line of a unified diff hunk: ' ' context, '-' removed, '+' added. */
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

export interface TodoEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * What a tool call asked for, by tool. `summary` is always there: one line for
 * the card header (a command, a path, a pattern).
 */
export type ToolInput =
  | { type: 'bash'; summary: string; command: string; description?: string | null; background?: boolean }
  | { type: 'edit'; summary: string; path: string; hunks: DiffHunk[]; replaceAll?: boolean }
  | { type: 'write'; summary: string; path: string; lines: number; preview: string }
  | { type: 'read'; summary: string; path: string; offset?: number | null; limit?: number | null }
  | { type: 'search'; summary: string; pattern: string; path?: string | null }
  | { type: 'todo'; summary: string; todos: TodoEntry[] }
  | { type: 'agent'; summary: string; description: string; agentType?: string | null; prompt: string; background?: boolean }
  | { type: 'web'; summary: string; url?: string | null; query?: string | null }
  | { type: 'question'; summary: string; questions: Array<{ question: string; options: string[] }> }
  | { type: 'other'; summary: string; json: string };

/** What came back, by what the result looks like (independent of the tool's name). */
export interface ToolResult {
  isError: boolean;
  /** Plain text output (stdout, the tool's message, an agent's report), clipped. */
  text: string;
  stderr?: string | null;
  /** Edit/Write results carry the applied change. */
  hunks?: DiffHunk[] | null;
  /** Write: the file is new. */
  created?: boolean;
  interrupted?: boolean;
  /** Read: lines read. */
  lines?: number | null;
  /** Images in the result. */
  images?: number;
  truncated?: boolean;
}

export interface ToolItem extends ItemBase {
  kind: 'tool';
  /** The tool's name as the agent calls it ("Bash", "Edit", "mcp__x__y"). */
  name: string;
  input: ToolInput;
  /** Absent while the tool runs (or waits for the person's approval). */
  result?: ToolResult | null;
}

/**
 * Everything else worth a line: compaction, interruptions, notifications, a
 * command's output, API errors, turn ends.
 */
export interface NoticeItem extends ItemBase {
  kind: 'notice';
  notice: 'compact' | 'interrupt' | 'task' | 'message' | 'output' | 'error' | 'turn' | 'recap' | 'info';
  text: string;
  /** Longer text shown when expanded (a compaction summary, a teammate's message). */
  detail?: string | null;
  /** turn: how long the turn took. */
  durationMs?: number | null;
}

export type ConvItem = UserItem | AssistantItem | ThinkingItem | ToolItem | NoticeItem;

/** A result for a tool item the client may not have yet. */
export interface ToolResultUpdate {
  id: string;
  result: ToolResult;
}

// ---- client -> server ----

export interface ConvOpen {
  t: 'conv.open';
  req: number;
  terminalId: string;
  /** Turns in the first page (default CONVERSATION_LIMITS.defaultTurns). */
  turns?: number;
}

export interface ConvMore {
  t: 'conv.more';
  req: number;
  stream: number;
  /** The `before` cursor of the oldest page the client has. */
  before: number;
  turns?: number;
}

export interface ConvClose {
  t: 'conv.close';
  stream: number;
}

export type ConversationClientMessage = ConvOpen | ConvMore | ConvClose;

// ---- server -> client ----

export interface ConversationPage {
  items: ConvItem[];
  /** Results of tool calls older than this page (keep them for when that page loads). */
  results?: ToolResultUpdate[];
  /** Cursor for older items (conv.more); null: this page starts at the beginning. */
  before: number | null;
}

export interface ConvOpened extends ConversationPage {
  t: 'conv.opened';
  req: number;
  stream: number;
  terminalId: string;
  source: ConversationSource;
  meta: ConversationMeta;
  /** CONVERSATION_PROTOCOL_VERSION. */
  v: number;
}

export interface ConvPage extends ConversationPage {
  t: 'conv.page';
  req: number;
  stream: number;
}

export interface ConvItems {
  t: 'conv.items';
  stream: number;
  items: ConvItem[];
  results?: ToolResultUpdate[];
  meta?: ConversationMeta;
}

export interface ConvReset extends ConversationPage {
  t: 'conv.reset';
  stream: number;
  reason: 'session' | 'replaced';
  source: ConversationSource;
  meta: ConversationMeta;
}

export interface ConvClosed {
  t: 'conv.closed';
  stream: number;
  reason: 'no_transcript' | 'gone' | 'closed' | 'unavailable';
}

export interface ConvError {
  t: 'conv.error';
  req?: number;
  stream?: number;
  code: 'not_found' | 'no_transcript' | 'bad_request' | 'unavailable' | 'too_many';
  message: string;
}

export type ConversationServerMessage = ConvOpened | ConvPage | ConvItems | ConvReset | ConvClosed | ConvError;

/**
 * Upserts `items` into `list` (keyed by id): known ids are replaced in place,
 * new ones appended (or prepended with `at: 'start'`, keeping their order).
 * Returns a new array. Pending results are merged into the tool items they belong to.
 */
export function mergeItems(
  list: readonly ConvItem[],
  items: readonly ConvItem[],
  opts: { at?: 'start' | 'end'; pending?: Map<string, ToolResult> } = {},
): ConvItem[] {
  const index = new Map<string, number>();
  list.forEach((it, i) => {
    index.set(it.id, i);
  });
  const out = list.slice();
  const fresh: ConvItem[] = [];
  const freshIndex = new Map<string, number>();
  // A result we already merged survives a re-sent tool call without one.
  const keep = (old: ConvItem | undefined, it: ConvItem): ConvItem =>
    old?.kind === 'tool' && it.kind === 'tool' && !it.result && old.result ? { ...it, result: old.result } : it;
  for (let it of items) {
    const pend = it.kind === 'tool' && !it.result ? opts.pending?.get(it.id) : undefined;
    if (pend && it.kind === 'tool') {
      it = { ...it, result: pend };
      opts.pending?.delete(it.id);
    }
    const at = index.get(it.id);
    const atFresh = freshIndex.get(it.id);
    if (at !== undefined) out[at] = keep(out[at], it);
    else if (atFresh !== undefined) fresh[atFresh] = keep(fresh[atFresh], it);
    else {
      freshIndex.set(it.id, fresh.length);
      fresh.push(it);
    }
  }
  return opts.at === 'start' ? [...fresh, ...out] : [...out, ...fresh];
}

/** Applies results: merged into their tool items, else kept in `pending` for an item that hasn't arrived. */
export function mergeResults(
  list: readonly ConvItem[],
  results: readonly ToolResultUpdate[],
  pending: Map<string, ToolResult>,
): ConvItem[] {
  if (results.length === 0) return list as ConvItem[];
  const byId = new Map(results.map((r) => [r.id, r.result]));
  let hit = 0;
  const out = list.map((it) => {
    const r = it.kind === 'tool' ? byId.get(it.id) : undefined;
    if (!r) return it;
    hit++;
    byId.delete(it.id);
    return { ...it, result: r } as ConvItem;
  });
  for (const [id, r] of byId) pending.set(id, r);
  return hit > 0 ? out : (list as ConvItem[]);
}
