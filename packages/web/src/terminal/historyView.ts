import {
  HISTORY_COLOR_DEFAULT,
  HISTORY_COLOR_RGB,
  HistoryFlag,
  type HistoryRow,
  type HistoryStyle,
  paletteRgb,
} from '@herdr-mobile/protocol';
import type { HistoryChange, HistoryChunk, HistoryEdge } from './history';

const hex = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;

function colorCss(c: number, fallback: string): string {
  if (c === HISTORY_COLOR_DEFAULT) return fallback;
  if (c >= HISTORY_COLOR_RGB) return hex(c);
  if (c < 16) return `var(--th-c${c})`;
  return hex(paletteRgb(c));
}

/** Inline CSS for a style, or '' for the default one (theme colors come from the container's variables). */
export function styleCss(s: HistoryStyle | undefined): string {
  if (!s) return '';
  const [fg, bg, f] = s;
  if (fg === HISTORY_COLOR_DEFAULT && bg === HISTORY_COLOR_DEFAULT && f === 0) return '';
  const inverse = (f & HistoryFlag.INVERSE) !== 0;
  let color = fg === HISTORY_COLOR_DEFAULT ? '' : colorCss(fg, '');
  let back = bg === HISTORY_COLOR_DEFAULT ? '' : colorCss(bg, '');
  if (inverse) {
    const c = back || 'var(--th-bg)';
    back = color || 'var(--th-fg)';
    color = c;
  }
  const css: string[] = [];
  if (f & HistoryFlag.INVISIBLE) css.push('color:transparent');
  else if (color) css.push(`color:${color}`);
  if (back) css.push(`background:${back}`);
  if (f & HistoryFlag.BOLD) css.push('font-weight:bold');
  if (f & HistoryFlag.ITALIC) css.push('font-style:italic');
  if (f & HistoryFlag.DIM) css.push('opacity:.5');
  const deco: string[] = [];
  if (f & HistoryFlag.UNDERLINE) deco.push('underline');
  if (f & HistoryFlag.STRIKE) deco.push('line-through');
  if (f & HistoryFlag.OVERLINE) deco.push('overline');
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
  return css.join(';');
}

/** One row as a DOM element: text runs in their styles. */
export function rowElement(row: HistoryRow, css: readonly string[]): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'th-row';
  if (!row.s) {
    el.textContent = row.t;
    return el;
  }
  let at = 0;
  for (let i = 0; i + 1 < row.s.length; i += 2) {
    const len = row.s[i] ?? 0;
    const text = row.t.slice(at, at + len);
    at += len;
    const style = css[row.s[i + 1] ?? 0] ?? '';
    if (!style) {
      el.append(text);
      continue;
    }
    const span = document.createElement('span');
    span.style.cssText = style;
    span.textContent = text;
    el.append(span);
  }
  if (at < row.t.length) el.append(row.t.slice(at));
  return el;
}

function chunkElement(chunk: HistoryChunk): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'th-chunk';
  const css = chunk.styles.map(styleCss);
  for (const r of chunk.rows) el.append(rowElement(r, css));
  el.style.setProperty('--rows', String(chunk.rows.length));
  return el;
}

/** Rows per block of the history's DOM (each block is skipped by layout while off screen). */
const CHUNK_ROWS = 256;

const EDGE_TEXT: Record<HistoryEdge, string> = {
  start: 'Start of history (herdr-core keeps about 5 MB per terminal)',
  trimmed: 'Older lines weren’t kept',
  cap: `Showing the latest lines (memory cap)`,
};

/**
 * The DOM of the history above the live grid (inside the pane's scroller, so it scrolls natively with
 * momentum): reserved space for rows that can still load (so loading never moves what's on screen), a
 * status row ("Loading earlier…" / where history starts), the rows, and a note while a full-screen app runs.
 */
export class HistoryView {
  readonly el: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly alt: HTMLDivElement;
  private readonly altText: HTMLSpanElement;
  private readonly altRead: HTMLButtonElement;
  private readonly app: HTMLDivElement;
  private reserved = 0;
  /** The person asked to read the full-screen app's own history. */
  onReadApp: (() => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'term-history';
    this.el.hidden = true;
    this.spacer = document.createElement('div');
    this.spacer.className = 'th-spacer';
    this.status = document.createElement('div');
    this.status.className = 'th-status';
    this.body = document.createElement('div');
    this.body.className = 'th-body';
    this.alt = document.createElement('div');
    this.alt.className = 'th-alt';
    this.alt.hidden = true;
    this.altText = document.createElement('span');
    this.altText.className = 'th-alt-text';
    this.altRead = document.createElement('button');
    this.altRead.type = 'button';
    this.altRead.className = 'th-alt-read';
    this.altRead.addEventListener('click', () => this.onReadApp?.());
    this.alt.append(this.altText, this.altRead);
    this.app = document.createElement('div');
    this.app.className = 'th-app';
    this.setAppState('idle');
    this.el.append(this.spacer, this.status, this.body, this.alt, this.app);
  }

  /**
   * The element to keep still while the history changes, for a view whose top is at `y` (client px): the row
   * there, or the first row when the view is above the rows; null below them.
   */
  anchorAt(y: number): Element | null {
    const first = this.body.firstElementChild;
    if (!first) return null;
    if (first.getBoundingClientRect().top >= y) return first.firstElementChild ?? first;
    for (let c = first; c; c = c.nextElementSibling as Element) {
      const r = c.getBoundingClientRect();
      if (r.bottom <= y) continue;
      const n = c.childElementCount;
      if (n === 0 || r.height <= 0) return c;
      const i = Math.min(n - 1, Math.max(0, Math.floor(((y - r.top) / r.height) * n)));
      return c.children[i] ?? c;
    }
    return null;
  }

  /** The top of the loaded rows' area (where "Loading earlier…" sits). */
  get statusElement(): HTMLDivElement {
    return this.status;
  }

  setEnabled(on: boolean): void {
    this.el.hidden = !on;
  }

  /** Cell metrics from xterm (rows line up with the grid below). */
  setMetrics(fontPx: number, rowPx: number, cellPx: number, cols: number, letterSpacing: number): void {
    const s = this.el.style;
    s.setProperty('--th-font', `${fontPx}px`);
    // Layout works in 1/64 px: a row height on that grid makes N rows exactly as tall as the space reserved for
    // them, so a page that lands (and later renders) never nudges what's on screen.
    s.setProperty('--th-row', `${Math.max(1, Math.round(rowPx * 64)) / 64}px`);
    s.setProperty('--th-ls', `${letterSpacing}px`);
    s.width = `${Math.ceil(cellPx * cols)}px`;
  }

  setColors(c: { background: string; foreground: string; ansi: readonly string[] }): void {
    const s = this.el.style;
    s.setProperty('--th-bg', c.background);
    s.setProperty('--th-fg', c.foreground);
    c.ansi.forEach((v, i) => {
      s.setProperty(`--th-c${i}`, v);
    });
  }

  apply(changes: readonly HistoryChange[]): void {
    for (const ch of changes) {
      switch (ch.kind) {
        case 'clear':
          this.body.replaceChildren();
          break;
        case 'prepend':
          this.body.prepend(chunkElement(ch.chunk));
          break;
        case 'append': {
          // Rows that scroll off a few at a time join the last block (blocks stay a few hundred rows).
          const last = this.body.lastElementChild as HTMLDivElement | null;
          const n = last?.childElementCount ?? 0;
          if (last && n + ch.chunk.rows.length <= CHUNK_ROWS) {
            const css = ch.chunk.styles.map(styleCss);
            for (const r of ch.chunk.rows) last.append(rowElement(r, css));
            last.style.setProperty('--rows', String(n + ch.chunk.rows.length));
          } else this.body.append(chunkElement(ch.chunk));
          break;
        }
        case 'trimFront':
          this.trim(ch.count, true);
          break;
        case 'trimBack':
          this.trim(ch.count, false);
          break;
      }
    }
  }

  /** Space for rows that can still load above (their exact height: loading them moves nothing below). */
  setReserved(rows: number): void {
    if (rows === this.reserved) return;
    this.reserved = rows;
    this.spacer.style.setProperty('--rows', String(rows));
  }

  setStatus(loading: boolean, edge: HistoryEdge | null, more: boolean): void {
    const text = loading || more ? 'Loading earlier…' : edge ? EDGE_TEXT[edge] : '';
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.dataset.state = loading || more ? 'loading' : edge ? 'edge' : 'none';
    this.status.hidden = !text;
  }

  setAlt(on: boolean): void {
    if (this.alt.hidden === !on) return;
    this.alt.hidden = !on;
    if (!on) {
      this.app.replaceChildren();
      this.setAppState('idle');
    }
  }

  /** The full-screen app's note: what reading its history does, and how the last read went. */
  setAppState(state: 'idle' | 'reading' | 'read' | 'failed', detail = ''): void {
    const text: Record<typeof state, string> = {
      idle: 'Full-screen app: its earlier output lives inside the app.',
      reading: 'Reading… herdr-core scrolls the app up and back (its live view pauses for a moment).',
      read: `The app’s earlier output${detail ? ` (${detail})` : ''}:`,
      failed: detail || 'Couldn’t read it.',
    };
    this.altText.textContent = text[state];
    this.altRead.textContent = state === 'idle' ? 'Read earlier output' : 'Read again';
    this.altRead.hidden = state === 'reading';
    this.alt.dataset.state = state;
  }

  /** The app's earlier output (plain text), right above its screen. */
  setAppRows(lines: readonly string[]): void {
    const el = chunkElement({ start: 0, rows: lines.map((t) => ({ t })), styles: [] });
    this.app.replaceChildren(el);
  }

  private trim(count: number, front: boolean): void {
    let left = count;
    while (left > 0) {
      const chunk = (front ? this.body.firstElementChild : this.body.lastElementChild) as HTMLDivElement | null;
      if (!chunk) return;
      const n = chunk.childElementCount;
      if (n <= left) {
        chunk.remove();
        left -= n;
        continue;
      }
      for (let i = 0; i < left; i++) (front ? chunk.firstElementChild : chunk.lastElementChild)?.remove();
      chunk.style.setProperty('--rows', String(n - left));
      left = 0;
    }
  }
}
