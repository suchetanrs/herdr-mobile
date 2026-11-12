/**
 * Claude Code's `/model` and `/effort` menus as they appear on its screen (Claude Code 2.1.322, real screens in
 * packages/server/test/claude-fixtures). Pure: rows of text in, what the menu shows out.
 *
 * /model:  "Select model" header, rows `❯ 5.  Haiku 5.5 ✔     Fastest for quick answers` (❯ = cursor, ✔ = in use),
 *          a `▸ More models` row that Enter expands (`▾`, more numbered rows below it), footer
 *          "Enter to set as default · s to use this session only · Esc to cancel".
 * /effort: "Effort" header, a slider row `──────────▲──────` over `low     medium     high     xhigh      max`,
 *          footer "←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel".
 * In both, `s` applies the choice to this session only; Enter would also make it the default for new sessions
 * (Claude's settings), so the bridge never presses Enter on a choice.
 */

export interface ModelRow {
  kind: 'option';
  label: string;
  detail: string;
  current: boolean;
}
export interface MoreRow {
  kind: 'more';
  expanded: boolean;
}
export interface ModelMenu {
  /** Rows the cursor moves through, top to bottom. */
  rows: Array<ModelRow | MoreRow>;
  /** Index of the cursor's row in `rows`, -1 when none is marked. */
  cursor: number;
}

export interface EffortMenu {
  levels: string[];
  /** Index in `levels` of the slider's mark. */
  cursor: number;
}

const OPTION = /^\s*(?:(❯)\s+)?(\d+)\.\s+(\S.*?)\s*$/u;
const MORE = /^\s*(?:(❯)\s+)?([▸▾])\s+More models\s*$/u;
const FOOTER = /Esc to cancel\s*$/;

/** The /model menu on screen, or null when it isn't open (or not fully drawn). */
export function parseModelMenu(screen: readonly string[]): ModelMenu | null {
  const head = screen.findLastIndex((l) => /^\s*Select model\s*$/.test(l));
  if (head < 0) return null;
  const foot = screen.findIndex((l, i) => i > head && FOOTER.test(l));
  if (foot < 0) return null;
  const rows: ModelMenu['rows'] = [];
  let cursor = -1;
  for (const line of screen.slice(head + 1, foot)) {
    const more = MORE.exec(line);
    if (more) {
      if (more[1]) cursor = rows.length;
      rows.push({ kind: 'more', expanded: more[2] === '▾' });
      continue;
    }
    const m = OPTION.exec(line);
    if (!m) continue;
    const [name = '', ...rest] = (m[3] ?? '').split(/\s{2,}/);
    const current = /\s✔$/u.test(name);
    if (m[1]) cursor = rows.length;
    rows.push({ kind: 'option', label: name.replace(/\s*✔$/u, ''), detail: rest.join('  '), current });
  }
  return rows.some((r) => r.kind === 'option') ? { rows, cursor } : null;
}

/** The /effort menu on screen, or null when it isn't open. */
export function parseEffortMenu(screen: readonly string[]): EffortMenu | null {
  const head = screen.findLastIndex((l) => /^\s*Effort\s*$/.test(l));
  if (head < 0) return null;
  const foot = screen.findIndex((l, i) => i > head && FOOTER.test(l) && /session only/.test(l));
  if (foot < 0) return null;
  for (let i = head + 1; i < foot - 1; i++) {
    const slider = screen[i] as string;
    const mark = slider.indexOf('▲');
    if (mark < 0 || !slider.includes('─')) continue;
    const words = [...(screen[i + 1] as string).matchAll(/\S+(?: \S+)*/g)].filter((w) => /^[a-z]+$/.test(w[0]));
    if (words.length === 0) return null;
    let best = 0;
    words.forEach((w, j) => {
      const centre = (x: RegExpExecArray | RegExpMatchArray) => (x.index ?? 0) + (x[0].length - 1) / 2;
      if (Math.abs(centre(w) - mark) < Math.abs(centre(words[best] as RegExpMatchArray) - mark)) best = j;
    });
    return { levels: words.map((w) => w[0]), cursor: best };
  }
  return null;
}

// The message box's rules: a line of ─ across the screen; the top one may carry the session's name near its right
// end (`──────── my-branch ─`, sessions started with --name or renamed).
const RULE = /^─{20,}(?: +\S.*? +─+)?\s*$/u;
// The prompt line: ❯ (or > in older versions), then a space (Claude draws a no-break space) or nothing.
const PROMPT = /^[❯>](?:[ \u00a0]|$)/u;
const MENU_TOP = /^▔{10,}\s*$/u;

export interface MessageBox {
  /** Rows of the top rule, the prompt line, the bottom rule. */
  top: number;
  prompt: number;
  bottom: number;
}

/**
 * Where Claude's message box is on screen: the last prompt line under a rule, down to the next rule (a draft may
 * span several rows). Anything below it (status lines, "auto mode on", background tasks) is ignored. Null when
 * the box isn't on screen.
 */
export function messageBox(screen: readonly string[]): MessageBox | null {
  for (let i = screen.length - 1; i > 0; i--) {
    if (!PROMPT.test(screen[i] as string) || !RULE.test(screen[i - 1] as string)) continue;
    const bottom = screen.findIndex((l, j) => j > i && RULE.test(l));
    return bottom < 0 ? null : { top: i - 1, prompt: i, bottom };
  }
  return null;
}

/** Either menu (or another of Claude's "Esc to cancel" menus) is open. */
export function menuOpen(screen: readonly string[]): boolean {
  if (screen.slice(-12).some((l) => FOOTER.test(l))) return true;
  // Claude draws its menus in place of the message box: a menu's top edge or footer below the box means one is open
  // (the box's rows may linger from an earlier paint).
  const box = messageBox(screen);
  return screen.slice(box ? box.bottom + 1 : -30).some((l) => FOOTER.test(l) || MENU_TOP.test(l));
}

/**
 * What is typed in Claude's message box, "" when nothing is; null when the box isn't on screen. `solid` is the same
 * screen with faint text blanked (see ScreenMirror.screenNow): Claude greys its hints ("Try …") and its suggestion
 * of what to say next, which aren't typed text. Without it, only the fresh session's "Try …" hint counts as nothing.
 */
export function promptText(screen: readonly string[], solid?: readonly string[]): string | null {
  const box = messageBox(screen);
  if (!box) return null;
  const rows = solid && solid.length === screen.length ? solid : screen;
  const text = rows
    .slice(box.prompt, box.bottom)
    .map((l, k) => (k === 0 ? l.slice(1) : l))
    .join('\n')
    .trim();
  return /^Try "[^"\n]*"$/.test(text) ? '' : text;
}

/** Claude's answer to the last `/command` on screen (the `⎿` line under `❯ /command`), null when there is none yet. */
export function commandResult(screen: readonly string[], command: 'model' | 'effort'): string | null {
  const at = screen.findLastIndex((l) => new RegExp(`^❯ /${command}\\s*$`).test(l));
  if (at < 0) return null;
  const m = /^\s*⎿\s+(.*\S)\s*$/u.exec(screen[at + 1] ?? '');
  return m ? (m[1] as string).replaceAll('`', '') : null;
}

/** Whether `said` (a model name in Claude's words) is the model of `row`. */
function names(said: string, row: Pick<ModelRow, 'label' | 'detail'>): boolean {
  if (said === row.label) return true;
  // "Default (recommended)" names its model in the description ("Opus 5.5 · Best for …").
  if (!/^Default\b/.test(row.label)) return false;
  return said.startsWith('Default') || said === row.detail.split(' · ')[0];
}

/** Whether Claude's confirmation says the model is now `row` for this session. */
export function modelConfirmed(message: string, row: Pick<ModelRow, 'label' | 'detail'>): boolean {
  const m = /^(?:Set model to (.+?) for this session only|Kept model as (.+?))\.?$/.exec(message);
  const said = m?.[1] ?? m?.[2];
  return said ? names(said, row) : false;
}

export interface SwitchQuestion {
  /** The model "1. Yes, switch to <model>" names. */
  model: string;
  /** The cursor is on "Yes". */
  onYes: boolean;
  /** Claude's explanation (cost of re-reading the conversation). */
  note: string;
}

/**
 * The question Claude asks after a model is picked in a conversation that already has history ("Switch model? /
 * Your next response will be slower … / ❯ 1. Yes, switch to Haiku 4.5 / 2. No, go back"); null when not shown.
 */
export function parseSwitchQuestion(screen: readonly string[]): SwitchQuestion | null {
  const head = screen.findLastIndex((l) => /^\s*Switch model\?\s*$/.test(l));
  if (head < 0) return null;
  const note: string[] = [];
  for (const line of screen.slice(head + 1)) {
    const yes = /^\s*(?:(❯)\s+)?1\.\s+Yes, switch to (.+?)\s*$/u.exec(line);
    if (yes) return { model: yes[2] as string, onYes: Boolean(yes[1]), note: note.join(' ') };
    if (line.trim()) note.push(line.trim());
  }
  return null;
}

/** Whether Claude's "Switch model?" question is about `row`. */
export function switchIsFor(q: SwitchQuestion, row: Pick<ModelRow, 'label' | 'detail'>): boolean {
  return names(q.model, row);
}

/** Whether Claude's confirmation says the effort level is now `level` for this session. */
export function effortConfirmed(message: string, level: string): boolean {
  return message.startsWith(`Set effort level to ${level} (this session only)`);
}

/** Arrow keys that take the cursor from `from` to `to`. */
export function moves(from: number, to: number, back: string, forward: string): string[] {
  return Array.from({ length: Math.abs(to - from) }, () => (to < from ? back : forward));
}
