/**
 * Terminal history rows (terminal protocol v2): rows of the terminal's main
 * buffer that scrolled off its screen, as text plus style runs, so a client
 * can show them without a terminal emulator. Encoded the same way by the
 * bridge (from its headless mirror) and the web client (from its own xterm),
 * so the two sources join without a seam.
 */

/**
 * One row. `t`: its text, trailing blank cells dropped (a wide character is one
 * string character followed by nothing: the row is `cols` cells, not
 * `t.length`). `s`: style runs as flat pairs `[length, style, length, style, ...]`
 * over `t` (UTF-16 units), styles indexing the page's `styles`; absent when the
 * whole row is in the default style. `w`: the row continues the one above (soft wrap).
 */
export interface HistoryRow {
  t: string;
  s?: number[];
  w?: 1;
}

/** `[fg, bg, flags]`: colors are HISTORY_COLOR_DEFAULT, a palette index 0-255, or HISTORY_COLOR_RGB | 0xRRGGBB. */
export type HistoryStyle = [fg: number, bg: number, flags: number];

export const HISTORY_COLOR_DEFAULT = -1;
export const HISTORY_COLOR_RGB = 0x1000000;

export const HistoryFlag = {
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  INVISIBLE: 64,
  STRIKE: 128,
  OVERLINE: 256,
} as const;

/** The parts of xterm.js's IBufferCell the encoder reads (browser and headless alike). */
export interface CellLike {
  getWidth(): number;
  getChars(): string;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  isBgRGB(): boolean;
  isBgPalette(): boolean;
  getFgColor(): number;
  getBgColor(): number;
}

/** The parts of xterm.js's IBufferLine the encoder reads. */
export interface LineLike {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(x: number, cell?: CellLike): CellLike | undefined;
}

/** Styles of one page: each distinct style once; index 0 is always the default style. */
export class HistoryStyles {
  readonly list: HistoryStyle[] = [[HISTORY_COLOR_DEFAULT, HISTORY_COLOR_DEFAULT, 0]];
  private readonly index = new Map<string, number>([[`${HISTORY_COLOR_DEFAULT},${HISTORY_COLOR_DEFAULT},0`, 0]]);

  of(fg: number, bg: number, flags: number): number {
    const key = `${fg},${bg},${flags}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.list.length;
      this.list.push([fg, bg, flags]);
      this.index.set(key, i);
    }
    return i;
  }
}

const color = (rgb: boolean, palette: boolean, value: number) =>
  rgb ? HISTORY_COLOR_RGB | (value & 0xffffff) : palette ? value & 0xff : HISTORY_COLOR_DEFAULT;

function flagsOf(c: CellLike): number {
  let f = 0;
  if (c.isBold()) f |= HistoryFlag.BOLD;
  if (c.isDim()) f |= HistoryFlag.DIM;
  if (c.isItalic()) f |= HistoryFlag.ITALIC;
  if (c.isUnderline()) f |= HistoryFlag.UNDERLINE;
  if (c.isBlink()) f |= HistoryFlag.BLINK;
  if (c.isInverse()) f |= HistoryFlag.INVERSE;
  if (c.isInvisible()) f |= HistoryFlag.INVISIBLE;
  if (c.isStrikethrough()) f |= HistoryFlag.STRIKE;
  if (c.isOverline()) f |= HistoryFlag.OVERLINE;
  return f;
}

/** A blank cell in this style shows nothing (so trailing ones can go). */
function invisibleBlank(styles: HistoryStyles, style: number): boolean {
  const s = styles.list[style];
  if (!s) return true;
  const shows = HistoryFlag.INVERSE | HistoryFlag.UNDERLINE | HistoryFlag.STRIKE | HistoryFlag.OVERLINE;
  return s[1] === HISTORY_COLOR_DEFAULT && (s[2] & shows) === 0;
}

/** Encodes one buffer line; `cell` is a scratch cell to reuse (buffer.getNullCell()). */
export function encodeHistoryRow(line: LineLike, styles: HistoryStyles, cell?: CellLike): HistoryRow {
  const chars: string[] = [];
  const marks: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x, cell);
    if (!c) break;
    if (c.getWidth() === 0) continue;
    chars.push(c.getChars() || ' ');
    marks.push(
      styles.of(color(c.isFgRGB(), c.isFgPalette(), c.getFgColor()), color(c.isBgRGB(), c.isBgPalette(), c.getBgColor()), flagsOf(c)),
    );
  }
  let n = chars.length;
  while (n > 0 && chars[n - 1] === ' ' && invisibleBlank(styles, marks[n - 1] ?? 0)) n--;
  let t = '';
  const s: number[] = [];
  let styled = false;
  for (let i = 0; i < n; i++) {
    const ch = chars[i] ?? ' ';
    const m = marks[i] ?? 0;
    t += ch;
    if (m !== 0) styled = true;
    const last = s.length - 2;
    if (last >= 0 && s[last + 1] === m) s[last] = (s[last] ?? 0) + ch.length;
    else s.push(ch.length, m);
  }
  const row: HistoryRow = { t };
  if (styled) row.s = s;
  if (line.isWrapped) row.w = 1;
  return row;
}

/** Rows as plain text, soft-wrapped rows joined (copy). */
export function historyText(rows: readonly HistoryRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.w && out.length > 0) out[out.length - 1] += r.t;
    else out.push(r.t);
  }
  return out;
}

/** xterm's 256-color palette above the 16 themed ones, as 0xRRGGBB. */
export function paletteRgb(index: number): number {
  if (index < 16) return 0;
  if (index < 232) {
    const i = index - 16;
    const v = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    return (v(Math.floor(i / 36)) << 16) | (v(Math.floor(i / 6) % 6) << 8) | v(i % 6);
  }
  const g = 8 + (index - 232) * 10;
  return (g << 16) | (g << 8) | g;
}
