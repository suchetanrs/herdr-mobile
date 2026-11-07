import type { DiffHunk, ToolInput, ToolItem, ToolResult } from '@herdr-mobile/protocol';
import { memo, type ReactNode, useMemo, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { highlight, langOfPath } from './highlight';
import { Markdown } from './Markdown';

/** A path as the agent's folder sees it ("src/a.ts" inside it, "~/x" under home). */
export function shortPath(p: string, cwd: string | null): string {
  if (cwd && p.startsWith(`${cwd.replace(/\/$/, '')}/`)) return p.slice(cwd.replace(/\/$/, '').length + 1);
  const home = /^\/home\/[^/]+\//.exec(p)?.[0] ?? (/^\/Users\/[^/]+\//.exec(p)?.[0] || null);
  return home ? `~/${p.slice(home.length)}` : p;
}

const ICON: Record<ToolInput['type'], IconName> = {
  bash: 'terminal',
  edit: 'pencil',
  write: 'file-plus',
  read: 'file-text',
  search: 'search',
  todo: 'list-checks',
  agent: 'bot',
  web: 'globe',
  question: 'circle-help',
  other: 'wrench',
};

/** Claude Code's own names for what a tool did. */
function verb(t: ToolItem): string {
  switch (t.name) {
    case 'Edit':
    case 'MultiEdit':
      return 'Update';
    case 'TodoWrite':
      return 'Todos';
    case 'Task':
      return 'Agent';
    case 'AskUserQuestion':
      return 'Question';
    default:
      return t.name.startsWith('mcp__') ? t.name.split('__').slice(1).join(' · ') : t.name;
  }
}

function diffCounts(hunks: readonly DiffHunk[] | null | undefined): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of hunks ?? [])
    for (const l of h.lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  return { add, del };
}

export function Diff({ hunks, path }: { hunks: readonly DiffHunk[]; path?: string }) {
  const lang = path ? langOfPath(path) : null;
  return (
    <div className="diff">
      {hunks.map((h, hi) => {
        let oldN = h.oldStart;
        let newN = h.newStart;
        const numbered = h.oldStart > 0 || h.newStart > 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: hunks in order.
          <div key={hi} className="diff-hunk">
            {hi > 0 && <div className="diff-gap">⋯</div>}
            {h.lines.map((l, i) => {
              const sign = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
              const text = sign === ' ' && l[0] !== ' ' ? l : l.slice(1);
              const left = sign === '+' ? '' : numbered ? oldN++ : '';
              const right = sign === '-' ? '' : numbered ? newN++ : '';
              const html = lang ? highlight(text, lang) : null;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines in order.
                <div key={i} className={`diff-line${sign === '+' ? ' add' : sign === '-' ? ' del' : ''}`}>
                  <span className="diff-n">{sign === '-' ? left : right}</span>
                  <span className="diff-sign">{sign === ' ' ? '' : sign}</span>
                  {html !== null ? (
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output (escaped).
                    <span className="diff-text hljs" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                  ) : (
                    <span className="diff-text">{text || ' '}</span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Output({ result, lang }: { result: ToolResult; lang?: string | null }) {
  const html = useMemo(() => (lang && result.text ? highlight(result.text, lang) : null), [lang, result.text]);
  if (!result.text && !result.stderr) return <div className="tool-empty">{result.isError ? 'Failed' : 'No output'}</div>;
  return (
    <>
      {result.text &&
        (html !== null ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output (escaped).
          <pre className={`tool-out hljs${result.isError ? ' err' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className={`tool-out${result.isError ? ' err' : ''}`}>{result.text}</pre>
        ))}
      {result.stderr && <pre className="tool-out err">{result.stderr}</pre>}
      {result.truncated && <div className="tool-note">Clipped: the terminal has all of it.</div>}
    </>
  );
}

/** The first line of a result, for the collapsed card (like Claude Code's "⎿ ..."). */
function previewOf(t: ToolItem): string | null {
  const r = t.result;
  if (!r) return null;
  if (r.interrupted) return 'Interrupted';
  const counts = diffCounts(r.hunks);
  if (t.input.type === 'edit') return counts.add || counts.del ? null : r.isError ? firstLine(r.text) : null;
  if (t.input.type === 'write') return r.isError ? firstLine(r.text) : null;
  if (t.input.type === 'read') return r.isError ? firstLine(r.text) : r.lines != null ? `${r.lines} lines` : null;
  if (t.input.type === 'todo' || t.input.type === 'agent') return r.isError ? firstLine(r.text) : null;
  const text = r.text.trim() || r.stderr?.trim() || '';
  if (!text) return r.isError ? 'Failed' : null;
  const lines = text.split('\n');
  const first = firstLine(text);
  return lines.length > 1 ? `${first}  +${lines.length - 1} lines` : first;
}

function firstLine(s: string): string {
  const l = s.trim().split('\n')[0] ?? '';
  return l.length > 200 ? `${l.slice(0, 199)}…` : l;
}

function Todos({ input }: { input: Extract<ToolInput, { type: 'todo' }> }) {
  return (
    <ul className="todos">
      {input.todos.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the list as written.
        <li key={i} className={t.status}>
          <span className="todo-box" aria-hidden="true">
            {t.status === 'completed' ? <Icon name="check" size={11} /> : t.status === 'in_progress' ? <span className="todo-dot" /> : null}
          </span>
          <span>{t.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Body({ t }: { t: ToolItem }): ReactNode {
  const { input, result } = t;
  switch (input.type) {
    case 'bash':
      return (
        <>
          {input.description && <div className="tool-desc">{input.description}</div>}
          <pre className="tool-cmd">
            <span className="tool-prompt">$ </span>
            {input.command}
          </pre>
          {result && <Output result={result} />}
        </>
      );
    case 'edit': {
      const hunks = result?.hunks?.length ? result.hunks : input.hunks;
      return (
        <>
          <Diff hunks={hunks} path={input.path} />
          {result?.isError && <Output result={result} />}
        </>
      );
    }
    case 'write':
      return (
        <>
          {result?.hunks?.length ? (
            <Diff hunks={result.hunks} path={input.path} />
          ) : (
            <Diff hunks={[{ oldStart: 0, newStart: 1, lines: input.preview.split('\n').map((l) => `+${l}`) }]} path={input.path} />
          )}
          {input.lines > input.preview.split('\n').length && (
            <div className="tool-note">{input.lines - input.preview.split('\n').length} more lines</div>
          )}
          {result?.isError && <Output result={result} />}
        </>
      );
    case 'read':
      return result ? <Output result={result} lang={langOfPath(input.path)} /> : null;
    case 'todo':
      return <Todos input={input} />;
    case 'agent':
      return (
        <>
          <details className="tool-prompt-block">
            <summary>Task given{input.agentType ? ` to ${input.agentType}` : ''}</summary>
            <Markdown text={input.prompt} className="md-sm" />
          </details>
          {result && (result.isError ? <Output result={result} /> : result.text ? <Markdown text={result.text} className="md-sm" /> : null)}
        </>
      );
    case 'question':
      return (
        <>
          {input.questions.map((q, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: as asked.
            <div key={i} className="tool-q">
              <div>{q.question}</div>
              <div className="tool-q-opts">
                {q.options.map((o) => (
                  <span key={o} className="chip">
                    {o}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {result && <Output result={result} />}
        </>
      );
    case 'search':
    case 'web':
      return result ? <Output result={result} /> : null;
    default:
      return (
        <>
          <pre className="tool-cmd">{input.json}</pre>
          {result && <Output result={result} />}
        </>
      );
  }
}

/**
 * A tool call: one compact line (what it did, how it went, the first line of
 * its output) that expands into the detail: the command and its output, the
 * edit as a diff, the todo list, the subagent's report.
 */
export const ToolCard = memo(function ToolCard({
  t,
  cwd,
  waiting,
}: {
  t: ToolItem;
  cwd: string | null;
  /** The agent is blocked on this call (asking for permission). */
  waiting?: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const r = t.result;
  const running = !r;
  const failed = Boolean(r?.isError);
  const counts = diffCounts(r?.hunks?.length ? r.hunks : t.input.type === 'edit' ? t.input.hunks : null);
  const isOpen = open ?? (t.input.type === 'todo' || Boolean(waiting));
  const summary =
    t.input.type === 'edit' || t.input.type === 'write' || t.input.type === 'read' ? shortPath(t.input.path, cwd) : t.input.summary;
  const preview = isOpen ? null : previewOf(t);
  const hasBody = !(t.input.type === 'search' || t.input.type === 'web' || t.input.type === 'read') || Boolean(r?.text || r?.stderr);
  const status = waiting ? 'waiting' : running ? 'running' : failed ? 'failed' : 'ok';
  return (
    <div className={`tool tool-${t.input.type} is-${status}${isOpen ? ' open' : ''}`}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={isOpen}
        disabled={!hasBody}
        onClick={() => setOpen(!isOpen)}
        title={t.input.summary}
      >
        <span className="tool-icon">
          <Icon name={ICON[t.input.type]} size={13} />
        </span>
        <span className="tool-name">{verb(t)}</span>
        <span className="tool-summary">{summary}</span>
        {t.input.type === 'write' && !running && <span className="tool-badge add">+{t.input.lines}</span>}
        {(counts.add > 0 || counts.del > 0) && t.input.type === 'edit' && (
          <span className="tool-badge">
            <span className="add">+{counts.add}</span> <span className="del">−{counts.del}</span>
          </span>
        )}
        <span className="tool-state" title={status}>
          {status === 'running' ? (
            <Icon name="spinner" size={12} spin />
          ) : status === 'waiting' ? (
            <span className="tool-wait">Needs you</span>
          ) : status === 'failed' ? (
            <Icon name="x" size={12} />
          ) : null}
        </span>
        {hasBody && <Icon name="chevron-right" size={12} className="tool-chev" />}
      </button>
      {preview && (
        <div className={`tool-preview${failed ? ' err' : ''}`}>
          <Icon name="corner-down-right" size={11} />
          <span>{preview}</span>
        </div>
      )}
      {isOpen && hasBody && (
        <div className="tool-body">
          <Body t={t} />
        </div>
      )}
    </div>
  );
});
