import type { Token, Tokens } from 'marked';
import { parseMarkdown } from './Markdown';

/**
 * A reply's markdown as text to speak: code (fenced and inline) left out, markdown symbols gone, links read as
 * their text, headings and list items as sentences of their own. Blocks are separated by a blank line and each
 * ends with punctuation, so the sentence splitter keeps them apart.
 */
export function markdownToSpeech(markdown: string): string {
  const out: string[] = [];
  for (const t of parseMarkdown(markdown)) block(t, out);
  return out.filter(Boolean).join('\n\n');
}

const ENDS = /[.!?…:;]["'”’)\]]*$/;

function sentence(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return ENDS.test(s) ? s : `${s}.`;
}

function inline(tokens: readonly Token[] | undefined): string {
  return (tokens ?? []).map(inlineToken).join('');
}

function inlineToken(t: Token): string {
  switch (t.type) {
    case 'text': {
      const tt = t as Tokens.Text;
      return tt.tokens?.length ? inline(tt.tokens) : tt.text;
    }
    case 'escape':
      return (t as Tokens.Escape).text;
    case 'strong':
    case 'em':
    case 'del':
      return inline((t as Tokens.Strong).tokens);
    case 'codespan':
      return '';
    case 'br':
      return ' ';
    case 'link': {
      const l = t as Tokens.Link;
      const text = inline(l.tokens);
      // A bare URL: say "link" rather than spell it out.
      return text === l.href || /^(https?:|mailto:)/i.test(text) ? 'link' : text;
    }
    case 'image':
      return (t as Tokens.Image).text;
    case 'html':
      return (t as Tokens.HTML).text.replace(/<[^>]*>/g, '');
    case 'checkbox':
      return '';
    default:
      return 'tokens' in t && Array.isArray(t.tokens) ? inline(t.tokens as Token[]) : (t.raw ?? '');
  }
}

function block(t: Token, out: string[]): void {
  switch (t.type) {
    case 'space':
    case 'def':
    case 'hr':
    case 'code':
      return;
    case 'paragraph':
    case 'heading':
      out.push(sentence(inline((t as Tokens.Paragraph).tokens)));
      return;
    case 'text': {
      const tt = t as Tokens.Text;
      out.push(sentence(tt.tokens ? inline(tt.tokens) : tt.text));
      return;
    }
    case 'blockquote':
      for (const x of (t as Tokens.Blockquote).tokens) block(x, out);
      return;
    case 'list':
      for (const it of (t as Tokens.List).items) for (const x of it.tokens) block(x, out);
      return;
    case 'table': {
      const tb = t as Tokens.Table;
      for (const row of [tb.header, ...tb.rows])
        out.push(
          sentence(
            row
              .map((c) => inline(c.tokens).trim())
              .filter(Boolean)
              .join(', '),
          ),
        );
      return;
    }
    case 'html':
      out.push(sentence((t as Tokens.HTML).text.replace(/<[^>]*>/g, '')));
      return;
    default:
      if ('tokens' in t && Array.isArray(t.tokens)) for (const x of t.tokens as Token[]) block(x, out);
  }
}
