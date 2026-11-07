import {
  encodeHistoryRow,
  type HistoryCursor,
  type HistoryMark,
  type HistoryRow,
  type HistoryStyle,
  HistoryStyles,
} from '@herdr-mobile/protocol';
import serializePkg from '@xterm/addon-serialize';
import unicodePkg from '@xterm/addon-unicode11';
import headlessPkg from '@xterm/headless';
import type { KeyModes } from './keys.js';

// CommonJS packages: named imports don't work under NodeNext.
const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;
const { Unicode11Addon } = unicodePkg;

export interface MirrorOptions {
  cols: number;
  rows: number;
  /** Scrollback lines kept (and the most a snapshot can carry). */
  scrollback: number;
}

/** A page of main-buffer history rows (see TermHistoryPage). */
export interface HistoryPage {
  epoch: number;
  start: number;
  rows: HistoryRow[];
  styles: HistoryStyle[];
  older: number;
  end: number;
  edge?: 'start' | 'trimmed';
}

/** xterm's CircularList, reached through the private `_core` (pinned @xterm/headless 6). */
interface TrimmableList {
  onTrim(listener: (n: number) => void): { dispose(): void };
}

/**
 * A headless xterm fed the same bytes the viewers get. It answers "what does
 * the screen look like right now" for a viewer that joins a shared stream late
 * or fell behind, without asking the core for another attach.
 *
 * Everything goes through xterm's write queue in order: a snapshot or resize
 * requested after some bytes sees exactly those bytes and nothing later.
 */
export class ScreenMirror {
  private readonly term: InstanceType<typeof Terminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private disposed = false;
  /**
   * History numbering: row `i` of the main buffer is absolute row `trimmed + i`. A new epoch starts when the
   * numbering can't continue (a reset, or a width change that re-wraps rows).
   */
  private epoch = 1;
  private trimmed = 0;
  private trimList: TrimmableList | null = null;
  private trimSub: { dispose(): void } | null = null;

  constructor(opts: MirrorOptions) {
    this.term = new Terminal({
      cols: Math.max(1, opts.cols),
      rows: Math.max(1, opts.rows),
      scrollback: opts.scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as never);
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = '11';
    this.hookTrim();
  }

  /** Counts rows dropped off the top of the main buffer (its list is replaced on reset). */
  private hookTrim(): void {
    const list = (this.term as unknown as { _core?: { buffers?: { normal?: { lines?: TrimmableList } } } })._core?.buffers?.normal?.lines;
    if (list === this.trimList) return;
    this.trimSub?.dispose();
    this.trimList = list && typeof list.onTrim === 'function' ? list : null;
    this.trimSub =
      this.trimList?.onTrim((n) => {
        this.trimmed += n;
      }) ?? null;
  }

  /** History numbering works (the private hook is there). */
  get hasHistory(): boolean {
    return this.trimList !== null;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  get modes(): KeyModes {
    return { applicationCursorKeys: this.term.modes.applicationCursorKeysMode, bracketedPaste: this.term.modes.bracketedPasteMode };
  }

  /** Queues `bytes`; `parsed` runs once xterm has processed them. */
  write(bytes: Uint8Array, parsed?: () => void): void {
    if (!this.disposed) this.term.write(bytes, parsed);
  }

  /** Resizes after everything written so far. */
  resize(cols: number, rows: number): void {
    if (this.disposed || cols < 1 || rows < 1) return;
    this.term.write('', () => {
      if (this.disposed) return;
      const rewrap = cols !== this.term.cols;
      this.term.resize(cols, rows);
      this.hookTrim();
      // A new width re-wraps the rows: their numbers change.
      if (rewrap) this.newEpoch();
    });
  }

  private newEpoch(): void {
    this.epoch++;
    this.trimmed = 0;
  }

  /** Starts over (a fresh first paint follows). */
  reset(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.write('', () => {
      if (this.disposed) return;
      this.term.reset();
      this.term.clear();
      if (cols >= 1 && rows >= 1) this.term.resize(cols, rows);
      this.hookTrim();
      this.newEpoch();
    });
  }

  /**
   * The screen as bytes a fresh xterm.js can replay (scrollback, screen, modes,
   * cursor), as of every byte written before this call.
   */
  snapshot(scrollback: number): Promise<{ data: string; cols: number; rows: number; history?: HistoryMark }> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('mirror disposed'));
        return;
      }
      this.term.write('', () => {
        if (this.disposed) {
          reject(new Error('mirror disposed'));
          return;
        }
        const snap = { data: this.serializer.serialize({ scrollback }), cols: this.term.cols, rows: this.term.rows };
        resolve(this.hasHistory ? { ...snap, history: this.mark() } : snap);
      });
    });
  }

  /** Whether the screen is a full-screen app's (alternate buffer), and its rows down to the last non-blank one. */
  screenNow(): Promise<{ alt: boolean; rows: string[] }> {
    return new Promise((resolve) => {
      this.term.write('', () => {
        if (this.disposed) {
          resolve({ alt: false, rows: [] });
          return;
        }
        const b = this.term.buffer.active;
        const rows: string[] = [];
        for (let y = 0; y < this.term.rows; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
        while (rows.length > 0 && rows[rows.length - 1]?.trim() === '') rows.pop();
        resolve({ alt: b.type === 'alternate', rows });
      });
    });
  }

  private mark(): HistoryMark {
    const b = this.term.buffer;
    return { epoch: this.epoch, end: this.trimmed + b.normal.baseY, kept: b.normal.baseY, alt: b.active.type === 'alternate' };
  }

  /**
   * Main-buffer history rows as of every byte written before this call: up to `limit` rows just before
   * `cursor.line` (older) or from it on (newer). `stale` when the cursor belongs to an earlier epoch.
   */
  history(cursor: HistoryCursor, dir: 'older' | 'newer', limit: number): Promise<HistoryPage | 'stale'> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('mirror disposed'));
        return;
      }
      this.term.write('', () => {
        if (this.disposed) {
          reject(new Error('mirror disposed'));
          return;
        }
        if (!this.hasHistory || cursor.epoch !== this.epoch) {
          resolve('stale');
          return;
        }
        const normal = this.term.buffer.normal;
        const lo = this.trimmed;
        const hi = this.trimmed + normal.baseY;
        const n = Math.max(0, limit);
        let from: number;
        let to: number;
        if (dir === 'older') {
          to = Math.min(Math.max(cursor.line, lo), hi);
          from = Math.max(lo, to - n);
        } else {
          from = Math.min(Math.max(cursor.line, lo), hi);
          to = Math.min(hi, from + n);
        }
        const styles = new HistoryStyles();
        const cell = normal.getNullCell();
        const rows: HistoryRow[] = [];
        for (let a = from; a < to; a++) {
          const line = normal.getLine(a - lo);
          rows.push(line ? encodeHistoryRow(line, styles, cell) : { t: '' });
        }
        const page: HistoryPage = { epoch: this.epoch, start: from, rows, styles: styles.list, older: from - lo, end: hi };
        if (from === lo) page.edge = lo > 0 ? 'trimmed' : 'start';
        resolve(page);
      });
    });
  }

  /** Resolves once every byte written so far is parsed (tests). */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.trimSub?.dispose();
    this.term.dispose();
  }
}
