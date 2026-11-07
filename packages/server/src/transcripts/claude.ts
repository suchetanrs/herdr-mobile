import fs from 'node:fs';
import path from 'node:path';
import type {
  ConversationMeta,
  ConvItem,
  DiffHunk,
  NoticeItem,
  TodoEntry,
  ToolInput,
  ToolItem,
  ToolResult,
  ToolResultUpdate,
} from '@herdr-mobile/protocol';
import {
  type AgentProcess,
  clip,
  clipLines,
  isObj,
  num,
  type ParsedEntry,
  str,
  stripAnsi,
  type TranscriptFormat,
  type TranscriptParser,
  timeOf,
} from './format.js';

/**
 * Claude Code's session transcript: ~/.claude*\/projects/<cwd>/<session>.jsonl,
 * one JSON entry per line. Entries this reads (everything else is skipped):
 *   user        a prompt (string content), tool results (tool_result blocks +
 *               `toolUseResult`), slash commands and their output, notifications
 *   assistant   one content block per entry (text / thinking / tool_use), `usage`
 *   system      compact_boundary, turn_duration, away_summary, local_command, errors
 *   attachment  queued_command (a prompt typed while the agent worked)
 *   custom-title / ai-title / cost-state / permission-mode: session facts
 * Sidechain entries (subagents' own messages) are left out: the Agent tool card
 * shows the subagent's task and report.
 */

/** Size limits for what one item carries to a phone. */
export const CLAUDE_LIMITS = {
  userChars: 32_000,
  assistantChars: 64_000,
  thinkingChars: 24_000,
  output: { head: 120, tail: 40, maxChars: 16_000 },
  readOutput: { head: 40, tail: 0, maxChars: 4_000 },
  agentOutput: { head: 400, tail: 40, maxChars: 24_000 },
  diffLines: 400,
  writePreviewLines: 60,
  jsonChars: 2_000,
  noticeChars: 4_000,
  detailChars: 24_000,
} as const;

type Obj = Record<string, unknown>;

const tag = (s: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s);
  return m ? (m[1] ?? '') : null;
};

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const PASTED = /<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content>/g;

function cleanPrompt(s: string): string {
  return s.replace(SYSTEM_REMINDER, '').replace(PASTED, '$1').trim();
}

/** What a user-role text is. */
type UserText =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'shell'; text: string }
  | { kind: 'output'; text: string }
  | { kind: 'task'; text: string; detail: string | null }
  | { kind: 'message'; text: string; detail: string }
  | { kind: 'interrupt'; text: string }
  | { kind: 'skip' };

function classifyText(raw: string): UserText {
  const s = raw.trimStart();
  if (s.startsWith('[Request interrupted by user')) return { kind: 'interrupt', text: 'Interrupted' };
  if (s.startsWith('<local-command-caveat>')) return { kind: 'skip' };
  const cmd = tag(s, 'command-name');
  if (cmd !== null && (s.startsWith('<command-name>') || s.startsWith('<command-message>'))) {
    const args = (tag(s, 'command-args') ?? '').trim();
    const name = cmd.trim().startsWith('/') ? cmd.trim() : `/${cmd.trim()}`;
    return { kind: 'command', text: args ? `${name} ${args}` : name };
  }
  if (s.startsWith('<local-command-stdout>') || s.startsWith('<local-command-stderr>')) {
    const out = stripAnsi(`${tag(s, 'local-command-stdout') ?? ''}${tag(s, 'local-command-stderr') ?? ''}`).trim();
    return out ? { kind: 'output', text: out } : { kind: 'skip' };
  }
  if (s.startsWith('<bash-input>')) return { kind: 'shell', text: (tag(s, 'bash-input') ?? '').trim() };
  if (s.startsWith('<bash-stdout>') || s.startsWith('<bash-stderr>')) {
    const out = stripAnsi(`${tag(s, 'bash-stdout') ?? ''}\n${tag(s, 'bash-stderr') ?? ''}`).trim();
    return out ? { kind: 'output', text: out } : { kind: 'skip' };
  }
  if (s.startsWith('<task-notification>')) {
    const summary = tag(s, 'summary')?.trim() || 'Background task update';
    const result = tag(s, 'result')?.trim() || null;
    return { kind: 'task', text: summary, detail: result };
  }
  const agentMsg = /<agent-message from="([^"]*)">([\s\S]*?)(?:<\/agent-message>|$)/.exec(s);
  if (agentMsg) {
    const body = (agentMsg[2] ?? '').trim();
    const report = body.startsWith('[Subagent hand-back]');
    return {
      kind: 'message',
      text: report ? 'A subagent reported back' : `Message from ${agentMsg[1] || 'another session'}`,
      detail: body,
    };
  }
  const text = cleanPrompt(raw);
  return text ? { kind: 'prompt', text } : { kind: 'skip' };
}

/** A unified-diff `lines` array, limited to `budget` lines in total. */
function hunksOf(patch: unknown, budget: { left: number }): DiffHunk[] | null {
  if (!Array.isArray(patch)) return null;
  const out: DiffHunk[] = [];
  for (const h of patch) {
    if (!isObj(h) || !Array.isArray(h.lines) || budget.left <= 0) continue;
    const lines = (h.lines as unknown[]).filter((l): l is string => typeof l === 'string');
    const take = lines.slice(0, budget.left);
    budget.left -= take.length;
    out.push({ oldStart: num(h.oldStart) ?? 0, newStart: num(h.newStart) ?? 0, lines: take });
  }
  return out;
}

/** Old -> new text as one hunk without line numbers (what an Edit asked for). */
function replaceHunk(oldS: string, newS: string, budget: { left: number }): DiffHunk {
  const lines = [...(oldS ? oldS.split('\n').map((l) => `-${l}`) : []), ...(newS ? newS.split('\n').map((l) => `+${l}`) : [])];
  const take = lines.slice(0, Math.max(0, budget.left));
  budget.left -= take.length;
  return { oldStart: 0, newStart: 0, lines: take };
}

const firstLine = (s: string, max = 160) => {
  const l = s.trim().split('\n')[0] ?? '';
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

function todoStatus(v: unknown): TodoEntry['status'] {
  return v === 'completed' || v === 'in_progress' ? v : 'pending';
}

/** The typed input of a tool call, by the tool's name. */
export function toolInput(name: string, input: unknown): ToolInput {
  const i = isObj(input) ? input : {};
  const s = (k: string) => str(i[k]);
  switch (name) {
    case 'Bash': {
      const command = s('command') ?? '';
      return {
        type: 'bash',
        summary: firstLine(command),
        command: clip(command, 8000).text,
        description: s('description'),
        background: i.run_in_background === true,
      };
    }
    case 'Edit':
    case 'MultiEdit': {
      const file = s('file_path') ?? '';
      const budget = { left: CLAUDE_LIMITS.diffLines };
      const edits = name === 'MultiEdit' && Array.isArray(i.edits) ? (i.edits as unknown[]).filter(isObj) : [i];
      const hunks = edits.map((e) => replaceHunk(str(e.old_string) ?? '', str(e.new_string) ?? '', budget));
      return { type: 'edit', summary: file, path: file, hunks, replaceAll: i.replace_all === true };
    }
    case 'Write': {
      const file = s('file_path') ?? '';
      const content = s('content') ?? '';
      const lines = content.split('\n');
      return {
        type: 'write',
        summary: file,
        path: file,
        lines: lines.length,
        preview: clip(lines.slice(0, CLAUDE_LIMITS.writePreviewLines).join('\n'), 6000).text,
      };
    }
    case 'Read':
    case 'NotebookRead': {
      const file = s('file_path') ?? s('notebook_path') ?? '';
      return { type: 'read', summary: file, path: file, offset: num(i.offset), limit: num(i.limit) };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = s('pattern') ?? '';
      const where = s('path') ?? s('glob');
      return { type: 'search', summary: where ? `${pattern} · ${where}` : pattern, pattern, path: where };
    }
    case 'TodoWrite': {
      const todos = (Array.isArray(i.todos) ? (i.todos as unknown[]) : []).filter(isObj).map((t) => ({
        text: str(t.content) ?? str(t.activeForm) ?? '',
        status: todoStatus(t.status),
      }));
      const done = todos.filter((t) => t.status === 'completed').length;
      return { type: 'todo', summary: `${done}/${todos.length} done`, todos };
    }
    case 'Task':
    case 'Agent': {
      const description = s('description') ?? 'Subagent';
      return {
        type: 'agent',
        summary: description,
        description,
        agentType: s('subagent_type'),
        prompt: clip(s('prompt') ?? '', 8000).text,
        background: i.run_in_background === true,
      };
    }
    case 'WebFetch':
      return { type: 'web', summary: s('url') ?? '', url: s('url') };
    case 'WebSearch':
      return { type: 'web', summary: s('query') ?? '', query: s('query') };
    case 'AskUserQuestion': {
      const questions = (Array.isArray(i.questions) ? (i.questions as unknown[]) : []).filter(isObj).map((q) => ({
        question: str(q.question) ?? '',
        options: (Array.isArray(q.options) ? (q.options as unknown[]) : [])
          .map((o) => (isObj(o) ? str(o.label) : str(o)))
          .filter((o): o is string => Boolean(o)),
      }));
      return { type: 'question', summary: questions[0]?.question ?? 'Question', questions };
    }
    default: {
      const json = JSON.stringify(i, null, 2) ?? '{}';
      const first = Object.values(i).find((v): v is string => typeof v === 'string');
      return { type: 'other', summary: first ? firstLine(first) : '', json: clip(json, CLAUDE_LIMITS.jsonChars).text };
    }
  }
}

function blockText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  let images = 0;
  const parts: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') images++;
  }
  return { text: parts.join('\n'), images };
}

/** A tool result, read by its shape (`toolUseResult` holds the structured part). */
export function toolResult(block: Obj, extra: unknown): ToolResult {
  const isError = block.is_error === true;
  const body = blockText(block.content);
  const r = isObj(extra) ? extra : null;
  const out: ToolResult = { isError, text: '' };
  if (body.images) out.images = body.images;
  if (r && (typeof r.stdout === 'string' || typeof r.stderr === 'string')) {
    const so = clipLines(stripAnsi(str(r.stdout) ?? ''), CLAUDE_LIMITS.output);
    const se = clipLines(stripAnsi(str(r.stderr) ?? ''), { ...CLAUDE_LIMITS.output, head: 40 });
    out.text = so.text;
    if (se.text.trim()) out.stderr = se.text;
    if (r.interrupted === true) out.interrupted = true;
    if (so.truncated || se.truncated) out.truncated = true;
    // A failed command's message lives in the block (exit code ...), not in stdout.
    if (isError && !out.text && !out.stderr) out.text = clipLines(stripAnsi(body.text), CLAUDE_LIMITS.output).text;
    return out;
  }
  if (r && Array.isArray(r.structuredPatch)) {
    out.hunks = hunksOf(r.structuredPatch, { left: CLAUDE_LIMITS.diffLines });
    if (r.type === 'create') out.created = true;
    out.text = isError ? clip(body.text, CLAUDE_LIMITS.noticeChars).text : '';
    return out;
  }
  if (r && isObj(r.file)) {
    out.lines = num(r.file.numLines);
    const c = clipLines(body.text, CLAUDE_LIMITS.readOutput);
    out.text = c.text;
    if (c.truncated) out.truncated = true;
    return out;
  }
  const limits =
    r && (typeof r.agentId === 'string' || typeof r.totalDurationMs === 'number') ? CLAUDE_LIMITS.agentOutput : CLAUDE_LIMITS.output;
  const c = clipLines(stripAnsi(body.text || (typeof extra === 'string' ? extra : '')), limits);
  out.text = c.text;
  if (c.truncated) out.truncated = true;
  return out;
}

const userText = (t: UserText, id: string, ts: number | null, images = 0): ConvItem | null => {
  switch (t.kind) {
    case 'skip':
      return null;
    case 'prompt':
    case 'command':
    case 'shell': {
      const c = clip(t.text, CLAUDE_LIMITS.userChars);
      return {
        kind: 'user',
        id,
        ts,
        text: c.text,
        source: t.kind === 'prompt' ? 'prompt' : t.kind,
        images,
        ...(c.truncated ? { truncated: true } : {}),
      };
    }
    case 'output':
      return { kind: 'notice', id, ts, notice: 'output', text: clipLines(t.text, CLAUDE_LIMITS.output).text };
    case 'interrupt':
      return { kind: 'notice', id, ts, notice: 'interrupt', text: t.text };
    case 'task':
      return {
        kind: 'notice',
        id,
        ts,
        notice: 'task',
        text: firstLine(t.text, 300),
        detail: t.detail ? clip(t.detail, CLAUDE_LIMITS.detailChars).text : null,
      };
    case 'message':
      return { kind: 'notice', id, ts, notice: 'message', text: t.text, detail: clip(t.detail, CLAUDE_LIMITS.detailChars).text };
  }
};

class ClaudeParser implements TranscriptParser {
  private readonly facts: ConversationMeta = {};
  private customTitle = false;
  private lastCompact: NoticeItem | null = null;
  private anon = 0;

  meta(): ConversationMeta {
    return { ...this.facts };
  }

  push(entry: unknown): ParsedEntry {
    const none: ParsedEntry = { items: [], results: [] };
    if (!isObj(entry)) return none;
    try {
      return this.read(entry) ?? none;
    } catch {
      // A shape we don't know: skip it rather than lose the stream.
      return none;
    }
  }

  private read(e: Obj): ParsedEntry | null {
    switch (e.type) {
      case 'user':
        return e.isSidechain === true ? null : this.user(e);
      case 'assistant':
        return e.isSidechain === true ? null : this.assistant(e);
      case 'system':
        return e.isSidechain === true ? null : this.system(e);
      case 'attachment':
        return this.attachment(e);
      case 'custom-title': {
        const t = str(e.customTitle);
        if (t) {
          this.facts.title = t;
          this.customTitle = true;
        }
        return null;
      }
      case 'ai-title':
      case 'summary': {
        const t = str(e.aiTitle) ?? str(e.summary);
        if (t && !this.customTitle) this.facts.title = t;
        return null;
      }
      case 'cost-state': {
        const c = num(e.totalCostUSD);
        if (c !== null) this.facts.costUsd = c;
        return null;
      }
      case 'permission-mode': {
        const m = str(e.permissionMode);
        if (m) this.facts.permissionMode = m;
        return null;
      }
      default:
        return null;
    }
  }

  private idOf(e: Obj): string {
    return str(e.uuid) ?? `anon-${++this.anon}-${str(e.timestamp) ?? ''}`;
  }

  private user(e: Obj): ParsedEntry | null {
    const msg = isObj(e.message) ? e.message : null;
    if (!msg) return null;
    const id = this.idOf(e);
    const ts = timeOf(e.timestamp);
    const content = msg.content;
    const items: ConvItem[] = [];
    const results: ToolResultUpdate[] = [];

    if (e.isCompactSummary === true) {
      const text = blockText(content).text;
      const detail = clip(text.replace(/^This session is being continued[^\n]*\n+/, ''), CLAUDE_LIMITS.detailChars).text;
      const marker: NoticeItem = this.lastCompact
        ? { ...this.lastCompact, detail }
        : { kind: 'notice', id, ts, notice: 'compact', text: 'Conversation compacted', detail };
      this.lastCompact = null;
      return { items: [marker], results };
    }

    if (Array.isArray(content)) {
      for (const b of content) {
        if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          results.push({ id: b.tool_use_id, result: toolResult(b, e.toolUseResult) });
        }
      }
      if (results.length > 0) return { items, results };
    }

    const { text, images } = blockText(content);
    if (e.isMeta === true) {
      // Context Claude Code adds for the model (reminders, skill bodies, image notes); only teammates' messages show.
      const t = classifyText(text);
      const item = t.kind === 'message' ? userText(t, id, ts) : null;
      return item ? { items: [item], results } : null;
    }
    const t = classifyText(text);
    const item = userText(t.kind === 'skip' && images > 0 ? { kind: 'prompt', text: '' } : t, id, ts, images);
    if (item) items.push(item);
    return { items, results };
  }

  private assistant(e: Obj): ParsedEntry | null {
    const msg = isObj(e.message) ? e.message : null;
    if (!msg || !Array.isArray(msg.content)) return null;
    const id = this.idOf(e);
    const ts = timeOf(e.timestamp);
    const model = str(msg.model);
    const items: ConvItem[] = [];
    if (e.isApiErrorMessage === true || model === '<synthetic>') {
      const text = blockText(msg.content).text.trim();
      if (!text || text === 'No response requested.') return null;
      return { items: [{ kind: 'notice', id, ts, notice: 'error', text: clip(text, CLAUDE_LIMITS.noticeChars).text }], results: [] };
    }
    if (model) this.facts.model = model;
    const usage = isObj(msg.usage) ? msg.usage : null;
    if (usage) {
      const ctx =
        (num(usage.input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0);
      if (ctx > 0) this.facts.contextTokens = ctx;
    }
    const blocks = msg.content as unknown[];
    blocks.forEach((b, i) => {
      if (!isObj(b)) return;
      const bid = blocks.length > 1 ? `${id}:${i}` : id;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const c = clip(b.text, CLAUDE_LIMITS.assistantChars);
        items.push({ kind: 'assistant', id: bid, ts, text: c.text, model, ...(c.truncated ? { truncated: true } : {}) });
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        const c = clip(str(b.thinking) ?? '', CLAUDE_LIMITS.thinkingChars);
        items.push({
          kind: 'thinking',
          id: bid,
          ts,
          text: c.text,
          durationMs: num(e.thinkingDurationMs),
          ...(c.truncated ? { truncated: true } : {}),
        });
      } else if ((b.type === 'tool_use' || b.type === 'server_tool_use') && typeof b.id === 'string') {
        const name = str(b.name) ?? 'tool';
        const tool: ToolItem = { kind: 'tool', id: b.id, ts, name, input: toolInput(name, b.input) };
        items.push(tool);
      }
    });
    return { items, results: [] };
  }

  private system(e: Obj): ParsedEntry | null {
    const id = this.idOf(e);
    const ts = timeOf(e.timestamp);
    const content = str(e.content) ?? '';
    const notice = (n: NoticeItem['notice'], text: string, more: Partial<NoticeItem> = {}): ParsedEntry => ({
      items: [{ kind: 'notice', id, ts, notice: n, text: clip(text, CLAUDE_LIMITS.noticeChars).text, ...more }],
      results: [],
    });
    switch (e.subtype) {
      case 'compact_boundary': {
        const m = isObj(e.compactMetadata) ? e.compactMetadata : {};
        const pre = num(m.preTokens);
        const how = m.trigger === 'manual' ? 'manually' : 'automatically';
        const text = `Conversation compacted ${how}${pre ? ` at ${Math.round(pre / 1000)}k tokens` : ''}`;
        const p = notice('compact', text);
        this.lastCompact = p.items[0] as NoticeItem;
        return p;
      }
      case 'turn_duration':
        return notice('turn', '', { durationMs: num(e.durationMs) });
      case 'away_summary':
        return content ? notice('recap', content.replace(/\s*\(disable recaps in \/config\)\s*$/, '')) : null;
      case 'local_command': {
        const t = classifyText(content);
        const item = userText(t, id, ts);
        return item ? { items: [item], results: [] } : null;
      }
      case 'informational':
        return content ? notice('info', content) : null;
      case 'agents_killed':
        return notice('info', 'Background agents stopped');
      case 'api_error':
        return notice('error', content || 'API error, retrying');
      case 'stop_hook_summary': {
        const errs = Array.isArray(e.hookErrors) ? (e.hookErrors as unknown[]).filter((x) => typeof x === 'string') : [];
        return errs.length ? notice('error', `Stop hook failed: ${errs.join('\n')}`) : null;
      }
      default:
        return content && (e.level === 'error' || e.level === 'warning') ? notice(e.level === 'error' ? 'error' : 'info', content) : null;
    }
  }

  private attachment(e: Obj): ParsedEntry | null {
    if (e.isSidechain === true) return null;
    const a = isObj(e.attachment) ? e.attachment : null;
    if (a?.type !== 'queued_command') return null;
    const prompt = str(a.prompt);
    if (!prompt) return null;
    const item = userText(classifyText(prompt), this.idOf(e), timeOf(e.timestamp));
    return item ? { items: [item], results: [] } : null;
  }
}

/** Claude Code names the project folder after the cwd with every non-alphanumeric character as "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** ~/.claude and its siblings (~/.claude-work, ...: CLAUDE_CONFIG_DIR setups). */
function configDirs(home: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n === '.claude' || n.startsWith('.claude-'))
    .map((n) => path.join(home, n))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

export const claudeFormat: TranscriptFormat = {
  id: 'claude',
  agents: ['claude'],
  roots(home) {
    return configDirs(home).map((d) => path.join(d, 'projects'));
  },
  createParser() {
    return new ClaudeParser();
  },
  isTurnStart(entry) {
    if (!isObj(entry) || entry.type !== 'user' || entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true)
      return false;
    const msg = isObj(entry.message) ? entry.message : null;
    if (!msg) return false;
    if (Array.isArray(msg.content) && msg.content.some((b) => isObj(b) && b.type === 'tool_result')) return false;
    const t = classifyText(blockText(msg.content).text);
    return t.kind === 'prompt' || t.kind === 'command' || t.kind === 'shell';
  },
  locateProcess(proc: AgentProcess, home: string) {
    if (proc.name !== 'claude') return null;
    // Claude Code keeps a registry of its running interactive sessions: sessions/<pid>.json.
    for (const dir of configDirs(home)) {
      let info: unknown;
      try {
        info = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${proc.pid}.json`), 'utf8'));
      } catch {
        continue;
      }
      if (!isObj(info) || info.pid !== proc.pid) continue;
      const session = str(info.sessionId);
      if (!session || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(session)) continue;
      const cwd = str(info.cwd) ?? proc.cwd;
      const projects = path.join(dir, 'projects');
      if (cwd) {
        const p = path.join(projects, projectDirName(cwd), `${session}.jsonl`);
        if (fs.existsSync(p)) return { session, path: p };
      }
      try {
        for (const d of fs.readdirSync(projects)) {
          const p = path.join(projects, d, `${session}.jsonl`);
          if (fs.existsSync(p)) return { session, path: p };
        }
      } catch {
        // no projects folder
      }
    }
    return null;
  },
};
