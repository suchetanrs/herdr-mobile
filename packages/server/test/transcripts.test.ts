import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConvItem, NoticeItem, ToolItem } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeFormat } from '../src/transcripts/claude.js';
import { ConversationHub } from '../src/transcripts/hub.js';
import { readBackward } from '../src/transcripts/jsonl.js';
import { type Located, TranscriptLocator } from '../src/transcripts/locate.js';
import { readPage, TranscriptTail } from '../src/transcripts/tail.js';
import { terminal } from './helpers/fixtures.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';
import { entry, jsonl } from './helpers/transcript.js';

const parseAll = (entries: unknown[]) => {
  const p = claudeFormat.createParser();
  const items: ConvItem[] = [];
  const results: Array<{ id: string }> = [];
  for (const e of entries) {
    const out = p.push(e);
    items.push(...out.items);
    results.push(...out.results);
  }
  return { items, results, meta: p.meta() };
};

describe('Claude Code transcript parser', () => {
  it('turns prompts, replies, thinking and tool calls into items', () => {
    const { items, results, meta } = parseAll([
      entry.title('fix the bug'),
      entry.prompt('Fix the failing test <system-reminder>noise</system-reminder>'),
      entry.thinking('Let me look.'),
      entry.text('Looking at **it**.'),
      entry.tool('toolu_1', 'Bash', { command: 'npm test\n# again', description: 'Run tests' }),
      entry.result('toolu_1', 'ok', { stdout: '\u001b[32mPASS\u001b[0m 3 tests', stderr: '', interrupted: false, isImage: false }),
      entry.cost(0.42),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'assistant', 'tool']);
    expect(items[0]).toMatchObject({ kind: 'user', source: 'prompt', text: 'Fix the failing test', images: 0 });
    expect(items[1]).toMatchObject({ kind: 'thinking', text: 'Let me look.', durationMs: 1200 });
    expect(items[2]).toMatchObject({ kind: 'assistant', text: 'Looking at **it**.', model: 'claude-opus-5-5' });
    expect(items[3]).toMatchObject({
      kind: 'tool',
      id: 'toolu_1',
      name: 'Bash',
      input: { type: 'bash', summary: 'npm test', command: 'npm test\n# again', description: 'Run tests' },
    });
    expect(results).toEqual([{ id: 'toolu_1', result: { isError: false, text: 'PASS 3 tests' } }]);
    expect(meta).toEqual({ title: 'fix the bug', model: 'claude-opus-5-5', contextTokens: 1502, costUsd: 0.42 });
  });

  it('reads edits as diffs, todos, subagents and errors', () => {
    const { items, results } = parseAll([
      entry.tool('e1', 'Edit', { file_path: '/p/a.ts', old_string: 'a\nb', new_string: 'a\nc' }),
      entry.result('e1', 'updated', {
        filePath: '/p/a.ts',
        oldString: 'a\nb',
        newString: 'a\nc',
        structuredPatch: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [' a', '-b', '+c'] }],
      }),
      entry.tool('w1', 'Write', { file_path: '/p/new.md', content: '# hi\nthere' }),
      entry.result('w1', 'created', { type: 'create', filePath: '/p/new.md', content: '# hi\nthere', structuredPatch: [] }),
      entry.tool('t1', 'TodoWrite', {
        todos: [
          { content: 'one', status: 'completed', activeForm: 'Doing one' },
          { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
        ],
      }),
      entry.tool('a1', 'Agent', { description: 'Survey', subagent_type: 'Explore', prompt: 'Look around' }),
      entry.result('a1', [{ type: 'text', text: 'Found 3 things' }], { agentId: 'x', status: 'completed' }),
      entry.tool('b2', 'Bash', { command: 'false' }),
      entry.result('b2', 'Exit code 1', 'Error: Exit code 1', true),
      entry.tool('m1', 'mcp__slack__read', { channel: 'C1', limit: 5 }),
    ]);
    const tool = (id: string) => items.find((i) => i.id === id) as ToolItem;
    expect(tool('e1').input).toMatchObject({ type: 'edit', path: '/p/a.ts', hunks: [{ lines: ['-a', '-b', '+a', '+c'] }] });
    expect(tool('w1').input).toMatchObject({ type: 'write', path: '/p/new.md', lines: 2, preview: '# hi\nthere' });
    expect(tool('t1').input).toMatchObject({
      type: 'todo',
      summary: '1/2 done',
      todos: [{ text: 'one', status: 'completed' }, { status: 'in_progress' }],
    });
    expect(tool('a1').input).toMatchObject({ type: 'agent', description: 'Survey', agentType: 'Explore', prompt: 'Look around' });
    expect(tool('m1').input).toMatchObject({ type: 'other', summary: 'C1' });
    const r = Object.fromEntries((results as Array<{ id: string; result: unknown }>).map((x) => [x.id, x.result]));
    expect(r.e1).toMatchObject({ isError: false, hunks: [{ oldStart: 10, newStart: 10, lines: [' a', '-b', '+c'] }] });
    expect(r.w1).toMatchObject({ created: true });
    expect(r.a1).toMatchObject({ text: 'Found 3 things' });
    expect(r.b2).toMatchObject({ isError: true, text: 'Exit code 1' });
  });

  it('shows commands, outputs, interruptions, notifications and compaction; hides context the agent adds', () => {
    const boundary = entry.system('compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 229_768 } });
    const { items } = parseAll([
      entry.prompt('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
      entry.prompt('<local-command-stdout>Set model to \u001b[1mopus\u001b[22m</local-command-stdout>'),
      entry.prompt('<local-command-caveat>Caveat: ...</local-command-caveat>'),
      entry.meta('<system-reminder>The user named this session</system-reminder>'),
      entry.meta('Another Claude session sent a message:\n<agent-message from="abc">\n[Subagent hand-back] all done\n</agent-message>'),
      { ...entry.prompt(''), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      entry.prompt(
        '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Agent "Build" finished</summary>\n</task-notification>',
      ),
      boundary,
      {
        ...entry.prompt('This session is being continued from a previous conversation.\n\nSummary:\n1. Did things'),
        isCompactSummary: true,
      },
      entry.system('turn_duration', { durationMs: 42_000 }),
      entry.system('stop_hook_summary', { hookErrors: [] }),
      entry.system('away_summary', { content: 'We built it. (disable recaps in /config)' }),
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'something-new', whatever: true },
      'not an object',
      null,
      { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
    ]);
    const shown = items.map((i) => (i.kind === 'notice' ? `${i.notice}:${i.text}` : `${i.kind}:${(i as { text: string }).text}`));
    expect(shown).toEqual([
      'user:/model opus',
      'output:Set model to opus',
      'message:A subagent reported back',
      'interrupt:Interrupted',
      'task:Agent "Build" finished',
      'compact:Conversation compacted automatically at 230k tokens',
      'compact:Conversation compacted automatically at 230k tokens',
      'turn:',
      'recap:We built it.',
    ]);
    expect(items[0]).toMatchObject({ source: 'command' });
    // The summary re-sends the marker (same id) with the summary to expand.
    expect(items[6]?.id).toBe(items[5]?.id);
    expect((items[6] as NoticeItem).detail).toBe('Summary:\n1. Did things');
    expect(items[7]).toMatchObject({ notice: 'turn', durationMs: 42_000 });
  });

  it('knows where turns start', () => {
    expect(claudeFormat.isTurnStart(entry.prompt('hi'))).toBe(true);
    expect(claudeFormat.isTurnStart(entry.prompt('<command-name>/clear</command-name>'))).toBe(true);
    expect(claudeFormat.isTurnStart(entry.meta('<system-reminder>x</system-reminder>'))).toBe(false);
    expect(claudeFormat.isTurnStart(entry.result('t', 'x', null))).toBe(false);
    expect(claudeFormat.isTurnStart(entry.prompt('<task-notification><summary>x</summary></task-notification>'))).toBe(false);
    expect(claudeFormat.isTurnStart(entry.text('hi'))).toBe(false);
  });
});

describe('transcript files', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir('tr');
  });
  afterEach(() => rmDir(dir));

  const conversation = (turns: number) => {
    const out: unknown[] = [];
    for (let i = 0; i < turns; i++) {
      out.push(entry.prompt(`question ${i}`), entry.tool(`tool${i}`, 'Bash', { command: `echo ${i}` }));
      out.push(entry.result(`tool${i}`, `${i}`, { stdout: `${i}`, stderr: '' }), entry.text(`answer ${i}`));
    }
    return out;
  };

  it('reads lines backward across chunk edges, with offsets', async () => {
    const file = path.join(dir, 'a.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => `{"i":${i},"pad":"${'é'.repeat(i * 7)}"}`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const fh = await fsp.open(file, 'r');
    const seen: Array<{ offset: number; text: string }> = [];
    await readBackward(
      fh,
      fs.statSync(file).size,
      (l) => {
        seen.push(l);
        return true;
      },
      97,
    );
    await fh.close();
    expect(seen.map((l) => l.text)).toEqual(lines.slice().reverse());
    const buf = fs.readFileSync(file);
    for (const l of seen) expect(buf.toString('utf8', l.offset, l.offset + Buffer.byteLength(l.text))).toBe(l.text);
  });

  it('pages back turn by turn; pages join up into the whole conversation', async () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, jsonl(...conversation(10)));
    const fh = await fsp.open(file, 'r');
    const opts = { turns: 3, maxBytes: 1e6, maxItems: 1000 };
    const first = await readPage(fh, claudeFormat, fs.statSync(file).size, opts);
    expect(first.items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual([
      'question 7',
      'question 8',
      'question 9',
    ]);
    expect((first.items.find((i) => i.id === 'tool9') as ToolItem).result).toMatchObject({ text: '9' });
    const all: ConvItem[] = [...first.items];
    let before = first.before;
    while (before !== null) {
      const p = await readPage(fh, claudeFormat, before, opts);
      all.unshift(...p.items);
      before = p.before;
    }
    await fh.close();
    expect(all.filter((i) => i.kind === 'user')).toHaveLength(10);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    expect(all.filter((i) => i.kind === 'tool' && i.result)).toHaveLength(10);
  });

  it('hands out results whose tool call is on an older page', async () => {
    const file = path.join(dir, 'r.jsonl');
    fs.writeFileSync(
      file,
      jsonl(entry.prompt('go'), entry.tool('x', 'Bash', { command: 'sleep 9' }), entry.result('x', 'done', { stdout: 'done', stderr: '' })),
    );
    const fh = await fsp.open(file, 'r');
    // A page too small for the whole turn: only the result line fits.
    const p = await readPage(fh, claudeFormat, fs.statSync(file).size, { turns: 1, maxBytes: 10, maxItems: 100 });
    await fh.close();
    expect(p.items).toEqual([]);
    expect(p.results).toEqual([{ id: 'x', result: { isError: false, text: 'done' } }]);
    expect(p.before).not.toBeNull();
  });

  it('tails appends within a second, whole lines only, and starts over when the file is replaced', async () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, jsonl(...conversation(2)));
    const tail = new TranscriptTail(file, claudeFormat, { pollMs: 200 });
    await tail.start();
    const got: ConvItem[] = [];
    let replaced = 0;
    const page = await tail.join(
      { onBatch: (b) => got.push(...b.items), onReplaced: () => replaced++ },
      { turns: 1, maxBytes: 1e6, maxItems: 100 },
    );
    expect(page.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);

    const t0 = Date.now();
    fs.appendFileSync(file, jsonl(entry.prompt('live one')));
    await until(() => got.length === 1, 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(got[0]).toMatchObject({ kind: 'user', text: 'live one' });

    // Half a line: nothing until the rest arrives.
    const line = JSON.stringify(entry.text('streamed in two writes'));
    fs.appendFileSync(file, line.slice(0, 20));
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(1);
    fs.appendFileSync(file, `${line.slice(20)}\n`);
    await until(() => got.length === 2, 1000);
    expect(got[1]).toMatchObject({ kind: 'assistant', text: 'streamed in two writes' });

    fs.writeFileSync(`${file}.new`, jsonl(entry.prompt('fresh')));
    fs.renameSync(`${file}.new`, file);
    await until(() => replaced === 1, 1500);
    const again = await tail.current({ turns: 2, maxBytes: 1e6, maxItems: 100 });
    expect(again.items).toMatchObject([{ kind: 'user', text: 'fresh' }]);
    tail.stop();
  });

  it('waits for a transcript that does not exist yet', async () => {
    const file = path.join(dir, 'later.jsonl');
    const tail = new TranscriptTail(file, claudeFormat, { pollMs: 50 });
    await tail.start();
    const got: ConvItem[] = [];
    const page = await tail.join({ onBatch: (b) => got.push(...b.items), onReplaced: () => {} });
    expect(page).toMatchObject({ items: [], before: null });
    fs.writeFileSync(file, jsonl(entry.prompt('first message')));
    await until(() => got.length === 1, 1000);
    tail.stop();
  });
});

describe('transcript locator', () => {
  let home: string;
  let projects: string;
  beforeEach(() => {
    home = tmpDir('home');
    projects = path.join(home, '.claude-work', 'projects', '-p');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, 's1.jsonl'), '');
    fs.mkdirSync(path.join(home, 'secret'));
    fs.writeFileSync(path.join(home, 'secret', 'keys.jsonl'), '');
  });
  afterEach(() => rmDir(home));

  const label = (transcript: string, agent = 'claude') => ({ 'agent-resume': JSON.stringify({ agent, session: 's1', transcript }) });

  it('serves label paths under ~/.claude*/projects only', () => {
    const loc = new TranscriptLocator({ home });
    const ok = path.join(projects, 's1.jsonl');
    expect(loc.locate(terminal('t1', { labels: label(ok) }))?.source).toEqual({ format: 'claude', session: 's1', path: ok });
    // A new session's file that isn't written yet is fine; files elsewhere are not.
    expect(loc.locate(terminal('t2', { labels: label(path.join(projects, 'new.jsonl')) }))?.source.path).toBe(
      path.join(projects, 'new.jsonl'),
    );
    expect(loc.locate(terminal('t3', { labels: label(path.join(home, 'secret', 'keys.jsonl')) }))).toBeNull();
    expect(loc.locate(terminal('t4', { labels: label(`${projects}/../../../secret/keys.jsonl`) }))).toBeNull();
    expect(loc.locate(terminal('t5', { labels: label(path.join(projects, 'notes.txt')) }))).toBeNull();
    expect(loc.locate(terminal('t6', { labels: label('relative/s1.jsonl') }))).toBeNull();
    expect(loc.locate(terminal('t7', { labels: label(ok, 'codex') }))).toBeNull();
    expect(loc.locate(terminal('t8', { labels: { 'agent-resume': 'not json' } }))).toBeNull();
    // A symlink inside the root that points out of it.
    fs.symlinkSync(path.join(home, 'secret', 'keys.jsonl'), path.join(projects, 'link.jsonl'));
    expect(loc.locate(terminal('t9', { labels: label(path.join(projects, 'link.jsonl')) }))).toBeNull();
  });

  it("falls back to Claude Code's registry of running sessions", () => {
    fs.mkdirSync(path.join(home, '.claude-work', 'sessions'));
    fs.writeFileSync(
      path.join(home, '.claude-work', 'sessions', '777.json'),
      JSON.stringify({ pid: 777, sessionId: 's1abcdefg', cwd: '/p' }),
    );
    fs.writeFileSync(path.join(projects, 's1abcdefg.jsonl'), '');
    const loc = new TranscriptLocator({ home });
    const t = terminal('t1', { foreground: { name: 'claude', pid: 777, cwd: '/p', argv: ['claude'] } });
    expect(loc.locate(t)?.source).toEqual({ format: 'claude', session: 's1abcdefg', path: path.join(projects, 's1abcdefg.jsonl') });
    expect(loc.locate(terminal('t2', { foreground: { name: 'bash', pid: 777 } }))).toBeNull();
  });

  it('takes test overrides by name, still inside the allowed roots', () => {
    const extra = tmpDir('extra');
    fs.writeFileSync(path.join(extra, 'synthetic.jsonl'), '');
    const loc = new TranscriptLocator({
      home,
      extraRoots: [extra],
      overrides: new Map([
        ['hm-conv', path.join(extra, 'synthetic.jsonl')],
        ['t2', '/etc/passwd.jsonl'],
      ]),
    });
    expect(loc.locate(terminal('t1', { name: 'hm-conv' }))?.source.path).toBe(path.join(extra, 'synthetic.jsonl'));
    expect(loc.locate(terminal('t2'))).toBeNull();
    rmDir(extra);
  });
});

describe('conversation hub', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir('hub');
  });
  afterEach(() => rmDir(dir));

  it('follows a terminal to its new session and closes when the terminal goes', async () => {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, jsonl(entry.prompt('old session')));
    fs.writeFileSync(b, jsonl(entry.prompt('after /clear')));
    let where: Located | null | 'gone' = { format: claudeFormat, source: { format: 'claude', session: 'a', path: a } };
    const hub = new ConversationHub({ locate: () => where, pollMs: 50, graceMs: 50 });
    const events: string[] = [];
    const { page } = await hub.open(
      't1',
      {
        onBatch: (bt) => events.push(`batch:${bt.items.length}`),
        onReset: (reason, source, p) =>
          events.push(`reset:${reason}:${path.basename(source.path)}:${(p.items[0] as { text: string }).text}`),
        onClosed: (reason) => events.push(`closed:${reason}`),
      },
      4,
    );
    expect(page.items).toMatchObject([{ text: 'old session' }]);
    where = { format: claudeFormat, source: { format: 'claude', session: 'b', path: b } };
    hub.refresh();
    await until(() => events.length === 1);
    expect(events).toEqual(['reset:session:b.jsonl:after /clear']);
    fs.appendFileSync(a, jsonl(entry.text('ignored: old file')));
    fs.appendFileSync(b, jsonl(entry.text('new reply')));
    await until(() => events.length === 2);
    expect(events[1]).toBe('batch:1');
    // The agent quit (label gone): keep showing what there was.
    where = null;
    hub.refresh();
    where = 'gone';
    hub.refresh();
    expect(events[2]).toBe('closed:gone');
    expect(hub.openCount).toBe(0);
    hub.stop();
  });

  it('refuses terminals without a transcript', async () => {
    const hub = new ConversationHub({ locate: (id) => (id === 'tx' ? 'gone' : null) });
    const sub = { onBatch() {}, onReset() {}, onClosed() {} };
    await expect(hub.open('tx', sub, 4)).rejects.toMatchObject({ code: 'not_found' });
    await expect(hub.open('t1', sub, 4)).rejects.toMatchObject({ code: 'no_transcript' });
    hub.stop();
  });
});
