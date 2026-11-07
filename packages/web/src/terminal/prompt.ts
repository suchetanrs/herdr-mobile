/**
 * Reads a blocked agent's question off its screen: Claude Code's permission menus ("Do you want to
 * proceed? ❯ 1. Yes ...") and its AskUserQuestion prompts (tabs, wrapped question, options with
 * descriptions, check marks, multi-select, "Type something", the review step), plus the key presses
 * that answer them. Fixtures of real screens: ./fixtures (captured with `hc read`).
 */

export interface PromptOption {
  /** What to press: "1", "2", ... */
  key: string;
  label: string;
  /** The grey line(s) under it (AskUserQuestion). */
  description?: string;
  /** Has a check mark: chosen before (single) or ticked (multi-select). */
  checked?: boolean;
  /** "Type something": the free-text answer. */
  other?: boolean;
  /** What is typed in it already. */
  text?: string;
  /** Below the menu's divider ("Chat about this"). */
  extra?: boolean;
}

export interface PromptTab {
  label: string;
  /** ☒: answered. */
  answered: boolean;
  /** The last step ("✔ Submit"). */
  submit: boolean;
}

export interface Prompt {
  /** menu: a numbered menu (permissions); ask: an AskUserQuestion question; review: its "Submit" step. */
  kind: 'menu' | 'ask' | 'review';
  question: string | null;
  /** Lines above a menu's question (what it asks about: "Bash command", the command). */
  detail?: string[];
  options: PromptOption[];
  /** Where the terminal's own cursor (❯) is: an index into options, 'next' (the Next/Submit row), or null. */
  cursor: number | 'next' | null;
  multi?: boolean;
  /** Multi-select's row after the options: "Next" (more questions follow) or "Submit". */
  next?: string;
  tabs?: PromptTab[];
  /** The tab on screen (index into tabs), null when it can't be told. */
  tab?: number | null;
  /** The review step's answers so far. */
  review?: Array<{ question: string; answer: string }>;
  warning?: string;
}

export interface Screen {
  lines: readonly string[];
  /** Per line, a char per character of its text: ' ' plain, '#' on a colored background (the current tab). */
  marks?: readonly (string | undefined)[];
  /** Terminal width: a line this long was hard-wrapped mid-word. */
  cols?: number;
}

/** Scrollback lines read above the screen (a question taller than the terminal starts above it). */
export const PROMPT_HISTORY = 60;

const CURSOR = '❯›>▶➜→*';
const OPTION = new RegExp(`^(\\s*)(?:([${CURSOR}])\\s*)?(\\d)[.)]\\s+(.*\\S)\\s*$`, 'u');
const DIVIDER = /^\s*[─━╌┄═]{6,}\s*$/u;
const NEXT_ROW = new RegExp(`^\\s*(?:([${CURSOR}])\\s*)?(Next|Submit)\\s*$`, 'u');
const TAB_BAR = /^\s*(?:←\s+)?(?:[☐☒✔]\s+[^☐☒✔→←]+?\s*)+(?:→\s*)?$/u;
const TAB_ITEM = /([☐☒✔])\s([^☐☒✔→]*?)\s*(?=[☐☒✔→]|$)/gu;
const FOOTER = /(Enter to select|Esc to cancel|to navigate)/;
const TYPE_SOMETHING = /^Type something\.?$/;
const CHECKBOX = /^\[([ ✔✓xX×])\]\s+(.*)$/u;

/** A line without box borders ("│ text │"), keeping its indentation. */
function unbox(l: string): string {
  return l.replace(/^(\s*)[│┃|]\s?/u, '$1').replace(/\s*[│┃|]\s*$/u, '');
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const blank = (l: string | undefined) => !l?.trim();

/**
 * Joins wrapped lines with a space, except after a line that filled the row and ends in a long unbroken
 * run (a path or URL cut mid-word: Ink only cuts words longer than the row).
 */
function joinWrapped(parts: ReadonlyArray<{ text: string; raw: string }>, cols?: number): string {
  let out = '';
  let before = '';
  for (const p of parts) {
    const t = p.text.trim();
    if (!t) continue;
    out = out ? out + (cols && before.length >= cols && /\S{16,}$/.test(before) ? '' : ' ') + t : t;
    before = p.raw;
  }
  return out;
}

interface Row {
  i: number;
  indent: number;
  cursor: boolean;
  key: string;
  label: string;
  /** Column where the label's text starts (descriptions line up with it). */
  col: number;
}

function optionRow(line: string, i: number): Row | null {
  const m = OPTION.exec(line);
  if (!m?.[3] || !m[4]) return null;
  const indent = m[1]?.length ?? 0;
  return {
    i,
    indent,
    cursor: Boolean(m[2]),
    key: m[3],
    label: m[4],
    col: line.length - line.trimStart().length + line.trimStart().indexOf(m[4]),
  };
}

/**
 * Reads the question at the bottom of the screen; null when there's no numbered menu.
 * `lines` may include scrollback above the screen (a tall question pushes its top off it).
 */
export function parsePrompt(input: readonly string[] | Screen): Prompt | null {
  const screen: Screen = Array.isArray(input) ? { lines: input as readonly string[] } : (input as Screen);
  const raw = screen.lines;
  let end = raw.length;
  while (end > 0 && blank(raw[end - 1])) end--;
  const start = Math.max(0, end - 80);
  const lines = raw.slice(start, end).map(unbox);
  const marks = screen.marks?.slice(start, end);

  // The last menu: from the last option "1" on.
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    const r = optionRow(lines[i] ?? '', i);
    if (r?.key === '1') first = i;
  }
  if (first < 0) return null;
  const rows: Row[] = [];
  let nextRow: { i: number; label: string; cursor: boolean } | null = null;
  let dividerAt = -1;
  for (let i = first; i < lines.length; i++) {
    const l = lines[i] ?? '';
    const r = optionRow(l, i);
    if (r) {
      if (Number(r.key) === rows.length + 1) rows.push(r);
      continue;
    }
    const n = NEXT_ROW.exec(l);
    if (n?.[2] && rows.length && !nextRow) nextRow = { i, label: n[2], cursor: Boolean(n[1]) };
    else if (DIVIDER.test(l) && dividerAt < 0) dividerAt = i;
  }
  if (rows.length < 2) return null;

  // What kind: a tab bar above the options (AskUserQuestion), its review step, or a plain menu.
  let tabLine = -1;
  let reviewLine = -1;
  for (let i = first - 1; i >= Math.max(0, first - 60); i--) {
    const l = lines[i] ?? '';
    if (reviewLine < 0 && /^\s*Review your answers\s*$/.test(l)) reviewLine = i;
    if (TAB_BAR.test(l) && /[☐☒]|✔\s+Submit/u.test(l)) {
      tabLine = i;
      break;
    }
    if (DIVIDER.test(l) && !/^\s*╌/u.test(l)) break;
  }
  const kind: Prompt['kind'] = reviewLine >= 0 ? 'review' : tabLine >= 0 ? 'ask' : 'menu';

  // Options, with what's under each (descriptions for questions, the rest of a wrapped label for menus).
  const options: PromptOption[] = [];
  let cursor: Prompt['cursor'] = null;
  let multi = false;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k] as Row;
    const stop = rows[k + 1]?.i ?? lines.length;
    let label = r.label;
    let col = r.col;
    let checked = false;
    const box = kind === 'ask' ? CHECKBOX.exec(label) : null;
    if (box) {
      multi = true;
      checked = box[1] !== ' ';
      label = box[2] ?? '';
      col += label ? r.label.indexOf(label) : 4;
    } else if (kind === 'ask' && / ✔$/u.test(label)) {
      checked = true;
      label = label.replace(/ ✔$/u, '');
    }
    const more: Array<{ text: string; raw: string }> = [];
    for (let i = r.i + 1; i < stop; i++) {
      const l = lines[i] ?? '';
      if (blank(l) || DIVIDER.test(l) || NEXT_ROW.test(l) || FOOTER.test(l) || indentOf(l) < Math.min(col, r.indent + 2)) break;
      more.push({ text: l, raw: raw[start + i] ?? l });
    }
    const o: PromptOption = { key: r.key, label };
    if (kind === 'ask' && more.length) o.description = joinWrapped(more, screen.cols);
    else if (more.length) o.label = joinWrapped([{ text: label, raw: raw[start + r.i] ?? '' }, ...more], screen.cols);
    if (checked) o.checked = true;
    if (dividerAt >= 0 && r.i > dividerAt) o.extra = true;
    if (r.cursor) cursor = k;
    options.push(o);
  }
  if (nextRow?.cursor) cursor = 'next';

  // AskUserQuestion's last option above the divider is the free-text one ("Type something", or what's typed in it).
  if (kind === 'ask') {
    const main = options.filter((o) => !o.extra);
    const other = main[main.length - 1];
    if (other) {
      other.other = true;
      if (!TYPE_SOMETHING.test(other.label)) other.text = other.label;
      other.label = 'Type something';
    }
  }

  const prompt: Prompt = { kind, question: null, options, cursor };
  if (multi) prompt.multi = true;
  if (nextRow) prompt.next = nextRow.label;

  if (tabLine >= 0) {
    const bar = lines[tabLine] ?? '';
    const mark = marks?.[tabLine];
    const tabs: PromptTab[] = [];
    let current: number | null = null;
    for (const m of bar.matchAll(TAB_ITEM)) {
      const label = (m[2] ?? '').trim();
      if (!label) continue;
      const at = m.index ?? 0;
      if (mark && /\S/.test(mark.slice(at, at + 1 + label.length + 1))) current = tabs.length;
      tabs.push({ label, answered: m[1] === '☒', submit: m[1] === '✔' && label === 'Submit' });
    }
    prompt.tabs = tabs;
    if (kind === 'review') current = tabs.findIndex((t) => t.submit);
    // One question alone: its tab is the only one.
    else if (current === null && tabs.filter((t) => !t.submit).length === 1) current = tabs.findIndex((t) => !t.submit);
    prompt.tab = current !== null && current >= 0 ? current : null;
  }

  if (kind === 'ask') {
    const q: Array<{ text: string; raw: string }> = [];
    for (let i = tabLine + 1; i < first; i++) q.push({ text: lines[i] ?? '', raw: raw[start + i] ?? '' });
    prompt.question = joinWrapped(q, screen.cols) || null;
  } else if (kind === 'review') {
    const review: Array<{ question: string; answer: string }> = [];
    let qParts: Array<{ text: string; raw: string }> = [];
    let aParts: Array<{ text: string; raw: string }> = [];
    let into: 'q' | 'a' | null = null;
    const flush = () => {
      if (qParts.length) review.push({ question: joinWrapped(qParts, screen.cols), answer: joinWrapped(aParts, screen.cols) });
      qParts = [];
      aParts = [];
    };
    let ask = -1;
    for (let i = reviewLine + 1; i < first; i++) {
      const line = lines[i] ?? '';
      const l = line.trim();
      const part = (text: string) => ({ text, raw: raw[start + i] ?? '' });
      if (!l) continue;
      if (/^⚠/u.test(l)) prompt.warning = l.replace(/^⚠\s*/u, '');
      else if (/^●\s/u.test(l)) {
        flush();
        qParts.push(part(l.slice(1)));
        into = 'q';
      } else if (/^→\s/u.test(l)) {
        aParts.push(part(l.slice(1)));
        into = 'a';
      } else if (into && indentOf(line) >= 2) (into === 'q' ? qParts : aParts).push(part(l));
      else ask = i;
    }
    flush();
    prompt.review = review;
    prompt.question = ask >= 0 ? (lines[ask] ?? '').trim() : null;
  } else {
    // A menu: the paragraph right above its options (same indent), and what's above that up to a divider.
    let q = first - 1;
    while (q >= 0 && blank(lines[q])) q--;
    if (q >= 0 && !DIVIDER.test(lines[q] ?? '')) {
      const ind = indentOf(lines[q] ?? '');
      let top = q;
      while (
        top - 1 >= 0 &&
        top > q - 3 &&
        !blank(lines[top - 1]) &&
        !DIVIDER.test(lines[top - 1] ?? '') &&
        indentOf(lines[top - 1] ?? '') === ind &&
        !/[?:]\s*$/.test(lines[top - 1] ?? '')
      )
        top--;
      const parts: Array<{ text: string; raw: string }> = [];
      for (let i = top; i <= q; i++) parts.push({ text: lines[i] ?? '', raw: raw[start + i] ?? '' });
      prompt.question = joinWrapped(parts, screen.cols) || null;
      const detail: string[] = [];
      for (let i = top - 1; i >= Math.max(0, top - 14); i--) {
        const l = lines[i] ?? '';
        if (DIVIDER.test(l)) {
          if (/[─━═]/u.test(l)) break;
          continue;
        }
        if (blank(l)) {
          if (detail.length) break;
          continue;
        }
        if (/^[\s╭╰]*[─━]+[╮╯]?\s*$/u.test(l)) break;
        detail.unshift(l.replace(/^[\s╭╰]+|[╮╯\s]+$/gu, '').trim());
      }
      if (detail.length) prompt.detail = detail;
    }
  }
  return prompt;
}

// ---- answering: which keys, in order ----

export type Step = { keys: string[] } | { paste: string };

/** The options the answer bar shows white: the checked ones, else the one under the terminal's cursor, else the first. */
export function highlighted(p: Prompt): Set<number> {
  const on = new Set<number>();
  p.options.forEach((o, i) => {
    if (o.checked) on.add(i);
  });
  if (on.size) return on;
  if (typeof p.cursor === 'number' && p.options[p.cursor]) on.add(p.cursor);
  else if (p.cursor !== 'next' && p.options.length) on.add(0);
  return on;
}

/** The cursor's row among the menu's rows (options above the divider, then the Next/Submit row). */
function cursorRow(p: Prompt): number | null {
  if (p.cursor === 'next') return p.options.filter((o) => !o.extra).length;
  return typeof p.cursor === 'number' ? p.cursor : null;
}

function arrows(from: number, to: number): string[] {
  return Array.from({ length: Math.abs(to - from) }, () => (to > from ? 'down' : 'up'));
}

/** True when what's typed now goes into the "Type something" field (the cursor is on it). */
export function typingIntoOther(p: Prompt | null): boolean {
  if (p?.kind !== 'ask' || typeof p.cursor !== 'number') return false;
  return Boolean(p.options[p.cursor]?.other);
}

/** A tap on option i (not the free-text one): its number. Single-select picks it, multi-select ticks or unticks it. */
export function pickSteps(p: Prompt, i: number): Step[] {
  const o = p.options[i];
  return o ? [{ keys: [o.key] }] : [];
}

/**
 * The free-text answer: put the cursor on "Type something", clear what's there, paste the text (a paste,
 * so digits in it never pick options), then Enter for a single-select question. Multi-select ticks it by
 * typing alone, and Enter there would untick it.
 */
export function otherSteps(p: Prompt, text: string): Step[] {
  const i = p.options.findIndex((o) => o.other);
  const o = p.options[i];
  if (!o) return [];
  const steps: Step[] = [];
  if (p.multi) {
    const from = cursorRow(p);
    if (from === null) return [];
    const move = arrows(from, i);
    if (move.length) steps.push({ keys: move });
  } else steps.push({ keys: [o.key] });
  steps.push({ keys: ['ctrl+u'] });
  if (text) steps.push({ paste: text });
  if (!p.multi && text) steps.push({ keys: ['enter'] });
  return steps;
}

/** Multi-select's Next / Submit row: arrows down to it, Enter. */
export function nextSteps(p: Prompt): Step[] {
  const from = cursorRow(p);
  if (!p.next || from === null) return [];
  const to = p.options.filter((o) => !o.extra).length;
  return [{ keys: [...arrows(from, to), 'enter'] }];
}

/** Go to another tab: ←/→ (from the free-text field, ↑ first: there ←/→ move the caret). */
export function tabSteps(p: Prompt, target: number): Step[] {
  if (!p.tabs || p.tab === null || p.tab === undefined || target === p.tab || !p.tabs[target]) return [];
  const keys: string[] = typingIntoOther(p) ? ['up'] : [];
  for (let i = 0; i < Math.abs(target - p.tab); i++) keys.push(target > p.tab ? 'right' : 'left');
  return [{ keys }];
}
