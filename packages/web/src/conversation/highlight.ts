import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cmake from 'highlight.js/lib/languages/cmake';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// The languages agents mostly write; anything else shows as plain text (no auto-detection: it's slow and guessy).
const LANGS = {
  bash,
  c,
  cmake,
  cpp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  python,
  ruby,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'fish', 'console'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['html', 'svg', 'urdf', 'xacro', 'launch', 'sdf'], { languageName: 'xml' });
hljs.registerAliases(['toml', 'cfg', 'conf'], { languageName: 'ini' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['md'], { languageName: 'markdown' });
hljs.registerAliases(['hpp', 'cc', 'cxx', 'h++'], { languageName: 'cpp' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['patch'], { languageName: 'diff' });
hljs.registerAliases(['jsonl', 'jsonc'], { languageName: 'json' });

const MAX = 40_000;

/**
 * Highlighted HTML for `code` (highlight.js escapes the text itself), or null
 * when the language isn't known or the code is too big to be worth it.
 */
export function highlight(code: string, lang: string | null | undefined, max = MAX): string | null {
  const name = lang?.trim().toLowerCase().split(/[\s{]/)[0];
  if (!name || code.length > max || !hljs.getLanguage(name)) return null;
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** A language for a file path's extension ("a/b.py" -> "py"), for previews of files. */
export function langOfPath(p: string): string | null {
  const base = p.split('/').pop() ?? '';
  if (/^(Dockerfile|Containerfile)$/i.test(base)) return 'dockerfile';
  if (/^(Makefile|GNUmakefile)$/.test(base)) return 'makefile';
  if (base === 'CMakeLists.txt') return 'cmake';
  if (base === '.env.example') return 'bash';
  const ext = base.includes('.') ? base.split('.').pop() : null;
  return ext && hljs.getLanguage(ext) ? ext : null;
}

/**
 * Splits highlight.js HTML into lines: the spans still open at a line's end are closed there and reopened on
 * the next line, so each line is whole HTML. (Its text is already escaped; tags are only `<span class>`.)
 */
export function htmlLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === '\n') {
      out.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      if (part.startsWith('<span')) open.push(part);
      else if (part === '</span>') open.pop();
      line += part;
    }
  }
  out.push(line + '</span>'.repeat(open.length));
  return out;
}

/** A language's display name ("py" -> "Python"). */
export const langLabel = (lang: string) => hljs.getLanguage(lang)?.name ?? lang;
