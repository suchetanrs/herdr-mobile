import { marked, type Token, type Tokens } from 'marked';
import { memo, type ReactNode, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { copyText } from '../lib/copy';
import { highlight } from './highlight';

/**
 * Markdown to React elements, never to HTML: marked only tokenizes, and every
 * token becomes a React node (raw HTML in the text shows as text). Links open
 * in a new tab and only for http(s)/mailto; images show as links (nothing
 * remote loads by itself).
 */

const SAFE_URL = /^(https?:|mailto:)/i;

export function CodeBlock({ code, lang }: { code: string; lang?: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {html !== null ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output; it escapes the code text itself.
        <pre className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>{code}</pre>
      )}
    </div>
  );
}

function inline(tokens: readonly Token[] | undefined, key = ''): ReactNode[] {
  return (tokens ?? []).map((t, i) => inlineToken(t, `${key}${i}`));
}

function inlineToken(t: Token, key: string): ReactNode {
  switch (t.type) {
    case 'text': {
      const tt = t as Tokens.Text;
      return tt.tokens?.length ? <span key={key}>{inline(tt.tokens, `${key}.`)}</span> : tt.text;
    }
    case 'escape':
      return (t as Tokens.Escape).text;
    case 'strong':
      return <strong key={key}>{inline((t as Tokens.Strong).tokens, `${key}.`)}</strong>;
    case 'em':
      return <em key={key}>{inline((t as Tokens.Em).tokens, `${key}.`)}</em>;
    case 'del':
      return <del key={key}>{inline((t as Tokens.Del).tokens, `${key}.`)}</del>;
    case 'codespan':
      return <code key={key}>{(t as Tokens.Codespan).text}</code>;
    case 'br':
      return <br key={key} />;
    case 'link': {
      const l = t as Tokens.Link;
      if (!SAFE_URL.test(l.href)) return <span key={key}>{inline(l.tokens, `${key}.`)}</span>;
      return (
        <a key={key} href={l.href} target="_blank" rel="noopener noreferrer" title={l.title ?? undefined}>
          {inline(l.tokens, `${key}.`)}
        </a>
      );
    }
    case 'image': {
      const im = t as Tokens.Image;
      const label = `🖼 ${im.text || im.href}`;
      return SAFE_URL.test(im.href) ? (
        <a key={key} href={im.href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      );
    }
    case 'html':
      return (t as Tokens.HTML).text;
    case 'checkbox':
      return <input key={key} type="checkbox" checked={(t as Tokens.Checkbox).checked} readOnly disabled />;
    default:
      return 'tokens' in t && Array.isArray(t.tokens) ? <span key={key}>{inline(t.tokens as Token[], `${key}.`)}</span> : (t.raw ?? '');
  }
}

function block(t: Token, key: string): ReactNode {
  switch (t.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens, `${key}.`)}</p>;
    case 'text': {
      // Text directly in a (tight) list item.
      const tt = t as Tokens.Text;
      return <span key={key}>{tt.tokens ? inline(tt.tokens, `${key}.`) : tt.text}</span>;
    }
    case 'heading': {
      const h = t as Tokens.Heading;
      const Tag = `h${Math.min(6, Math.max(1, h.depth))}` as 'h1';
      return <Tag key={key}>{inline(h.tokens, `${key}.`)}</Tag>;
    }
    case 'code': {
      const c = t as Tokens.Code;
      return <CodeBlock key={key} code={c.text} lang={c.lang} />;
    }
    case 'blockquote':
      return <blockquote key={key}>{blocks((t as Tokens.Blockquote).tokens, `${key}.`)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const l = t as Tokens.List;
      const items = l.items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positions in a parsed document.
        <li key={i} className={it.task ? 'task' : undefined}>
          {it.tokens.map((x, j) => (x.type === 'checkbox' ? inlineToken(x, `${key}.${i}.${j}`) : block(x, `${key}.${i}.${j}`)))}
        </li>
      ));
      return l.ordered ? (
        <ol key={key} start={typeof l.start === 'number' ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const align = (a: string | null) => (a ? { textAlign: a as 'left' } : undefined);
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {tb.header.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns.
                  <th key={i} style={align(tb.align[i] ?? null)}>
                    {inline(c.tokens, `${key}.h${i}.`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows.
                <tr key={r}>
                  {row.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns.
                    <td key={i} style={align(tb.align[i] ?? null)}>
                      {inline(c.tokens, `${key}.${r}.${i}.`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      return (
        <p key={key} className="md-raw">
          {(t as Tokens.HTML).text}
        </p>
      );
    default:
      return 'tokens' in t && Array.isArray(t.tokens) ? <div key={key}>{blocks(t.tokens as Token[], `${key}.`)}</div> : null;
  }
}

function blocks(tokens: readonly Token[], key = ''): ReactNode[] {
  return tokens.map((t, i) => block(t, `${key}${i}`));
}

export function parseMarkdown(text: string): Token[] {
  try {
    return marked.lexer(text, { gfm: true, breaks: false });
  } catch {
    return [{ type: 'paragraph', raw: text, text, tokens: [{ type: 'text', raw: text, text }] } as Token];
  }
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const tokens = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md${className ? ` ${className}` : ''}`}>{blocks(tokens)}</div>;
});
