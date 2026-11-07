import type { HistoryCursor, HistoryMark, HistoryRow, HistoryStyle, TermHistoryPage } from '@herdr-mobile/protocol';

/**
 * The Terminal view's history (rows of the main buffer that scrolled off the screen), shown above the live
 * grid: a window `[start, end)` of absolute row numbers (the bridge's numbering, see HistoryMark), filled from
 * three sources that join without gaps or doubles:
 *  - rows that scroll off the screen here, copied from this page's own xterm (it keeps a little scrollback);
 *  - `newer` pages from the bridge when more scrolled off than xterm kept (a burst) or after a resync;
 *  - `older` pages from the bridge as the person scrolls up (load on demand).
 * Pure state: the pane feeds it xterm's numbers and bridge pages, and draws what it says.
 */

export interface HistoryChunk {
  start: number;
  rows: HistoryRow[];
  styles: HistoryStyle[];
}

/** What the top of the history says once nothing older can come. */
export type HistoryEdge = 'start' | 'trimmed' | 'cap';

/** A change for the view, in order. */
export type HistoryChange =
  | { kind: 'clear' }
  | { kind: 'prepend'; chunk: HistoryChunk }
  | { kind: 'append'; chunk: HistoryChunk }
  | { kind: 'trimFront'; count: number }
  | { kind: 'trimBack'; count: number };

export interface HistoryRequest {
  cursor: HistoryCursor;
  dir: 'older' | 'newer';
  limit: number;
}

/** Rows kept on the page (each is a DOM row): about 1.5x what herdr-core keeps at 200 columns. */
export const HISTORY_CAP = 5000;
/** Rows per `older` page. */
export const OLDER_PAGE = 300;
/** Most rows per `newer` page (the protocol's maximum). */
export const NEWER_PAGE = 1000;

interface Anchor {
  /** Absolute number of this xterm's normal-buffer row 0 is `offset + trimmed`. */
  offset: number;
}

export class HistoryModel {
  epoch: number | null = null;
  start = 0;
  end = 0;
  /** The bridge's oldest held row (as last heard). */
  serverLo = 0;
  edge: HistoryEdge | null = null;
  loadingOlder = false;
  private loadingNewer = false;
  private chunks: HistoryChunk[] = [];
  private anchor: Anchor | null = null;
  private count = 0;

  constructor(readonly cap = HISTORY_CAP) {}

  get rows(): number {
    return this.count;
  }

  get enabled(): boolean {
    return this.epoch !== null && this.anchor !== null;
  }

  /** Rows the bridge could still give above `start` (within the cap). */
  get olderAvailable(): number {
    if (!this.enabled) return 0;
    return Math.max(0, Math.min(this.start - this.serverLo, this.cap - this.count));
  }

  /** Nothing older will come: why (the view's top marker). */
  get topEdge(): HistoryEdge | null {
    if (!this.enabled) return null;
    if (this.start > this.serverLo && this.count >= this.cap) return 'cap';
    if (this.start <= this.serverLo) return this.edge ?? 'start';
    return null;
  }

  /** The stream reset (or opened): no numbering until the snapshot is parsed. In-flight pages are dropped. */
  detach(): void {
    this.anchor = null;
    this.loadingOlder = false;
    this.loadingNewer = false;
  }

  /** History is off (an older bridge, or xterm without the hook). */
  disable(): HistoryChange[] {
    this.detach();
    this.epoch = null;
    return this.clear();
  }

  /**
   * The snapshot after `mark` is parsed: this xterm has `baseY` history rows and has trimmed `trimmed` rows so
   * far. Keeps what's shown when the numbering continues (same epoch), else starts over.
   */
  attach(mark: HistoryMark, baseY: number, trimmed: number): HistoryChange[] {
    const out: HistoryChange[] = [];
    this.anchor = { offset: mark.end - baseY - trimmed };
    const localLo = mark.end - baseY;
    this.serverLo = mark.end - mark.kept;
    if (mark.epoch !== this.epoch || this.end > mark.end || this.end < this.serverLo) {
      this.epoch = mark.epoch;
      this.edge = null;
      out.push(...this.clear());
      this.start = this.end = localLo;
    }
    return out;
  }

  /** Absolute number of xterm's normal-buffer row 0 and of its first screen row. */
  local(baseY: number, trimmed: number): { lo: number; hi: number } | null {
    if (!this.anchor) return null;
    const lo = this.anchor.offset + trimmed;
    return { lo, hi: lo + baseY };
  }

  /**
   * After xterm parsed more: rows that left the screen. Returns the changes to draw, the local rows to copy
   * (`copy`: absolute range, read from xterm), or a `newer` request when xterm no longer has them.
   */
  sync(baseY: number, trimmed: number): { changes: HistoryChange[]; copy?: [number, number]; request?: HistoryRequest } {
    const changes: HistoryChange[] = [];
    const l = this.local(baseY, trimmed);
    if (!l || this.epoch === null) return { changes };
    if (l.hi < this.end) {
      // Rows came back onto the screen (it got taller).
      const drop = Math.min(this.count, this.end - l.hi);
      if (drop > 0) changes.push(...this.trimBack(drop));
      this.end = l.hi;
      if (this.start > this.end) this.start = this.end;
      return { changes };
    }
    if (l.hi === this.end || this.loadingNewer) return { changes };
    if (this.end >= l.lo) return { changes, copy: [this.end, l.hi] };
    this.loadingNewer = true;
    return {
      changes,
      request: { cursor: { epoch: this.epoch, line: this.end }, dir: 'newer', limit: Math.min(NEWER_PAGE, l.hi - this.end) },
    };
  }

  /** Rows copied from xterm for `[from, from + rows.length)` (as `sync` asked). */
  appendLocal(from: number, rows: HistoryRow[], styles: HistoryStyle[]): HistoryChange[] {
    if (from !== this.end || rows.length === 0) return [];
    return this.append({ start: from, rows, styles });
  }

  /** The next `older` page to ask for, if one is due (the pane decides when the person is near the top). */
  olderRequest(): HistoryRequest | null {
    if (!this.enabled || this.loadingOlder || this.epoch === null) return null;
    const n = Math.min(OLDER_PAGE, this.olderAvailable);
    if (n <= 0) return null;
    this.loadingOlder = true;
    return { cursor: { epoch: this.epoch, line: this.start }, dir: 'older', limit: n };
  }

  /** A page from the bridge (either direction). Pages of another epoch, or that no longer fit, are dropped. */
  page(dir: 'older' | 'newer', p: TermHistoryPage, local: { lo: number; hi: number } | null): HistoryChange[] {
    if (dir === 'older') this.loadingOlder = false;
    else this.loadingNewer = false;
    if (p.epoch !== this.epoch || !this.anchor) return [];
    this.serverLo = Math.max(0, p.start - p.older);
    if (p.edge) this.edge = p.edge;
    const pEnd = p.start + p.rows.length;
    if (dir === 'older') {
      // Only the rows right above what's shown, never past the cap.
      if (pEnd !== this.start) return [];
      let rows = p.rows;
      const room = this.cap - this.count;
      if (rows.length > room) rows = rows.slice(rows.length - room);
      if (rows.length === 0) return [];
      const chunk = { start: this.start - rows.length, rows, styles: p.styles };
      this.chunks.unshift(chunk);
      this.start = chunk.start;
      this.count += rows.length;
      return [{ kind: 'prepend', chunk }];
    }
    const out: HistoryChange[] = [];
    // The bridge no longer has some rows we missed (a big burst): what's shown can't be joined; start at the page.
    if (p.start > this.end) {
      out.push(...this.clear());
      this.start = this.end = p.start;
      this.edge = 'trimmed';
    }
    if (p.start > this.end) return out;
    // Never past what has left this xterm's screen (the bridge may be ahead).
    const limit = local ? local.hi : this.end;
    const from = this.end - p.start;
    const to = Math.min(p.rows.length, limit - p.start);
    if (to > from) out.push(...this.append({ start: this.end, rows: p.rows.slice(from, to), styles: p.styles }));
    return out;
  }

  /** A request failed (stale, offline): stop waiting; `stale` means start over from a fresh mark. */
  failed(dir: 'older' | 'newer'): void {
    if (dir === 'older') this.loadingOlder = false;
    else this.loadingNewer = false;
  }

  /** Plain text of every row shown (soft wraps joined). */
  text(): string[] {
    const out: string[] = [];
    for (const c of this.chunks)
      for (const r of c.rows) {
        if (r.w && out.length > 0) out[out.length - 1] += r.t;
        else out.push(r.t);
      }
    return out;
  }

  /** Every row, oldest first (tests). */
  allRows(): HistoryRow[] {
    return this.chunks.flatMap((c) => c.rows);
  }

  private append(chunk: HistoryChunk): HistoryChange[] {
    const out: HistoryChange[] = [{ kind: 'append', chunk }];
    this.chunks.push(chunk);
    this.count += chunk.rows.length;
    this.end = chunk.start + chunk.rows.length;
    if (this.count > this.cap) out.push(...this.trimFront(this.count - this.cap));
    return out;
  }

  private trimFront(n: number): HistoryChange[] {
    let left = n;
    while (left > 0 && this.chunks.length > 0) {
      const c = this.chunks[0] as HistoryChunk;
      if (c.rows.length <= left) {
        left -= c.rows.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = { start: c.start + left, rows: c.rows.slice(left), styles: c.styles };
        left = 0;
      }
    }
    const done = n - left;
    this.count -= done;
    this.start += done;
    // Dropped for room: the bridge may still have them, but they'd only be dropped again.
    return done > 0 ? [{ kind: 'trimFront', count: done }] : [];
  }

  private trimBack(n: number): HistoryChange[] {
    let left = n;
    while (left > 0 && this.chunks.length > 0) {
      const c = this.chunks[this.chunks.length - 1] as HistoryChunk;
      if (c.rows.length <= left) {
        left -= c.rows.length;
        this.chunks.pop();
      } else {
        this.chunks[this.chunks.length - 1] = { start: c.start, rows: c.rows.slice(0, c.rows.length - left), styles: c.styles };
        left = 0;
      }
    }
    const done = n - left;
    this.count -= done;
    return done > 0 ? [{ kind: 'trimBack', count: done }] : [];
  }

  private clear(): HistoryChange[] {
    this.chunks = [];
    this.count = 0;
    this.loadingOlder = false;
    this.loadingNewer = false;
    return [{ kind: 'clear' }];
  }
}
