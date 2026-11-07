import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import type { ConversationMeta, ConvItem, ToolResultUpdate } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';
import type { TranscriptFormat } from './format.js';
import { parseLine, readBackward, readForward } from './jsonl.js';

export interface PageOptions {
  /** Turns (prompts the person typed) to include, counting back from `end`. */
  turns: number;
  /** Stop reading back after this many bytes even mid-turn. */
  maxBytes: number;
  /** Keep at most this many items (the newest). */
  maxItems: number;
}

export const DEFAULT_PAGE: PageOptions = { turns: 4, maxBytes: 3 * 1024 * 1024, maxItems: 600 };

export interface Page {
  items: ConvItem[];
  /** Results for tool calls older than this page. */
  results: ToolResultUpdate[];
  /** Offset to read older entries from; null at the start of the file. */
  before: number | null;
  meta: ConversationMeta;
}

export interface Batch {
  items: ConvItem[];
  results: ToolResultUpdate[];
}

/** Pairs results with the tool items of the same batch; returns what's left. */
export function pairResults(items: ConvItem[], results: ToolResultUpdate[]): ToolResultUpdate[] {
  if (results.length === 0) return results;
  const at = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.kind === 'tool') at.set(it.id, i);
  });
  const left: ToolResultUpdate[] = [];
  for (const r of results) {
    const i = at.get(r.id);
    const it = i === undefined ? undefined : items[i];
    if (i !== undefined && it?.kind === 'tool') items[i] = { ...it, result: r.result };
    else left.push(r);
  }
  return left;
}

/** The items of the last `turns` turns that end at `end` (a line boundary). */
export async function readPage(fh: FileHandle, format: TranscriptFormat, end: number, opts: PageOptions): Promise<Page> {
  const picked: Array<{ offset: number; entry: unknown }> = [];
  let bytes = 0;
  let turns = 0;
  await readBackward(fh, end, (line) => {
    if (picked.length > 0 && bytes + line.text.length > opts.maxBytes) return false;
    bytes += line.text.length + 1;
    const entry = parseLine(line.text);
    picked.push({ offset: line.offset, entry });
    if (format.isTurnStart(entry)) turns++;
    return turns < opts.turns;
  });
  picked.reverse();
  const parser = format.createParser();
  const items: ConvItem[] = [];
  const offsets: number[] = [];
  let results: ToolResultUpdate[] = [];
  for (const { offset, entry } of picked) {
    const out = parser.push(entry);
    for (const it of out.items) {
      items.push(it);
      offsets.push(offset);
    }
    results.push(...out.results);
  }
  results = pairResults(items, results);
  let first = picked[0]?.offset ?? end;
  if (items.length > opts.maxItems) {
    const cut = items.length - opts.maxItems;
    items.splice(0, cut);
    first = offsets[cut] ?? first;
  }
  return { items, results, before: first > 0 ? first : null, meta: parser.meta() };
}

/** Offset just after the last newline at or before `size`. */
async function lineBoundary(fh: FileHandle, size: number): Promise<number> {
  let pos = size;
  const buf = Buffer.allocUnsafe(64 * 1024);
  while (pos > 0) {
    const len = Math.min(buf.length, pos);
    const { bytesRead } = await fh.read(buf, 0, len, pos - len);
    const i = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (i >= 0) return pos - len + i + 1;
    pos -= len;
  }
  return 0;
}

/**
 * Read-only, and never through a symlink at the transcript's own name: the locator checked the real
 * path when it could, but a file that didn't exist yet could later be planted as a link elsewhere.
 */
const READ_NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

/** What a facts scan found up to `end` of one file (by path + inode), so the next start scans only what's new. */
const factsCache = new Map<string, { end: number; latest: Map<string, unknown> }>();

/** Short session-fact lines ("custom-title", "cost-state", ...): only these are parsed in a facts scan. */
const FACT_LINE = /^\{"type":"(custom-title|ai-title|summary|cost-state|permission-mode)"/;

/**
 * Session facts (title, cost, mode) from anywhere in the file: they can be far
 * behind the first page. Scans back from `end`, parsing only fact lines, and
 * stops once the newest of each kind is known.
 */
export async function sessionFacts(fh: FileHandle, format: TranscriptFormat, end: number, cacheKey?: string): Promise<ConversationMeta> {
  const latest = new Map<string, unknown>();
  const cached = cacheKey ? factsCache.get(cacheKey) : undefined;
  const from = cached && cached.end <= end ? cached.end : 0;
  await readBackward(fh, end, (line) => {
    // Lines before `from` were scanned last time (a 19 MB transcript without some fact would be read whole again).
    if (line.offset < from) return false;
    if (line.text.length > 4096) return true;
    const kind = FACT_LINE.exec(line.text)?.[1];
    if (kind && !latest.has(kind)) latest.set(kind, parseLine(line.text));
    return latest.size < 5;
  });
  if (from > 0 && cached) for (const [k, v] of cached.latest) if (!latest.has(k)) latest.set(k, v);
  if (cacheKey) {
    if (factsCache.size >= 64 && !factsCache.has(cacheKey)) factsCache.delete(factsCache.keys().next().value as string);
    factsCache.set(cacheKey, { end, latest });
  }
  const parser = format.createParser();
  // Oldest first, so a custom title wins over an automatic one like it does in the file.
  for (const k of ['summary', 'ai-title', 'custom-title', 'cost-state', 'permission-mode']) if (latest.has(k)) parser.push(latest.get(k));
  return parser.meta();
}

export interface TailListener {
  onBatch(batch: Batch, meta: ConversationMeta | null): void;
  /** The file was replaced or truncated: what was sent no longer holds. */
  onReplaced(): void;
}

export interface TailOptions {
  logger?: Logger;
  /** Stat the file this often too (fs.watch can miss events). */
  pollMs?: number;
}

/**
 * Follows one transcript file: inotify (fs.watch) for low latency plus a stat
 * poll as a safety net; reads only the bytes past `offset`, whole lines only.
 * Handles the file appearing late (a new session), and being replaced or
 * truncated (listeners are told to start over). Every read and every join is
 * serialized, so a joiner's first page and the batches after it never overlap
 * or leave a gap.
 */
export class TranscriptTail {
  private offset = 0;
  private ino = -1;
  private readonly listeners = new Set<TailListener>();
  private chain: Promise<unknown> = Promise.resolve();
  private parser;
  private meta: ConversationMeta = {};
  private watcher: fs.FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private kicked = false;
  private started = false;
  private stopped = false;
  private readonly log: Logger;

  constructor(
    readonly path: string,
    readonly format: TranscriptFormat,
    private readonly opts: TailOptions = {},
  ) {
    this.log = opts.logger ?? silentLogger;
    this.parser = format.createParser();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Bytes consumed so far (tests). */
  get position(): number {
    return this.offset;
  }

  start(): Promise<void> {
    if (this.started) return this.chain.then(() => {});
    this.started = true;
    this.poll = setInterval(() => this.kick(), this.opts.pollMs ?? 500);
    this.poll.unref?.();
    return this.run(async () => {
      try {
        const st = await fsp.stat(this.path);
        this.ino = st.ino;
        const fh = await fsp.open(this.path, READ_NOFOLLOW);
        try {
          this.offset = await lineBoundary(fh, st.size);
          this.meta = await sessionFacts(fh, this.format, this.offset, `${this.path}\0${st.ino}`);
        } finally {
          await fh.close();
        }
      } catch {
        // Not there yet: it appears with the session's first message.
      }
      this.watch();
    });
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.listeners.clear();
  }

  /** Adds a listener and returns the page of the last `opts.turns` turns, exactly up to where batches start. */
  join(l: TailListener, opts: PageOptions = DEFAULT_PAGE): Promise<Page> {
    return this.run(async () => {
      const page = await this.pageAt(this.offset, opts);
      this.meta = { ...page.meta, ...this.meta };
      page.meta = { ...this.meta };
      this.listeners.add(l);
      return page;
    });
  }

  /** The current page again (after onReplaced), for a listener that is already in. */
  current(opts: PageOptions = DEFAULT_PAGE): Promise<Page> {
    return this.run(async () => {
      const page = await this.pageAt(this.offset, opts);
      page.meta = { ...this.meta, ...page.meta };
      return page;
    });
  }

  /** Older items: the page that ends at `before`. */
  older(before: number, opts: PageOptions = DEFAULT_PAGE): Promise<Page> {
    return this.run(() => this.pageAt(Math.min(before, this.offset), opts));
  }

  leave(l: TailListener): void {
    this.listeners.delete(l);
  }

  /** Read now (tests; fs.watch and the poll call it). */
  kick(): void {
    if (this.kicked || this.stopped || !this.started) return;
    this.kicked = true;
    void this.run(async () => {
      this.kicked = false;
      await this.readNew();
    });
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private watch(): void {
    if (this.watcher || this.stopped) return;
    try {
      this.watcher = fs.watch(this.path, { persistent: false }, (event) => {
        if (event === 'rename') {
          // Replaced or moved: watch whatever is at the path now, on the next poll.
          this.watcher?.close();
          this.watcher = null;
        }
        this.kick();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  private async pageAt(end: number, opts: PageOptions): Promise<Page> {
    if (end <= 0) return { items: [], results: [], before: null, meta: {} };
    let fh: FileHandle;
    try {
      fh = await fsp.open(this.path, READ_NOFOLLOW);
    } catch {
      return { items: [], results: [], before: null, meta: {} };
    }
    try {
      return await readPage(fh, this.format, end, opts);
    } finally {
      await fh.close();
    }
  }

  private async readNew(): Promise<void> {
    if (this.stopped) return;
    let st: fs.Stats;
    try {
      st = await fsp.stat(this.path);
    } catch {
      return;
    }
    if (!this.watcher) this.watch();
    if ((this.ino !== -1 && st.ino !== this.ino) || st.size < this.offset) {
      this.log.info({ path: this.path }, 'transcript replaced; starting over');
      this.ino = st.ino;
      this.offset = 0;
      this.parser = this.format.createParser();
      this.meta = {};
      const fh = await fsp.open(this.path, READ_NOFOLLOW).catch(() => null);
      if (fh) {
        try {
          this.offset = await lineBoundary(fh, st.size);
        } finally {
          await fh.close();
        }
      }
      for (const l of [...this.listeners]) l.onReplaced();
      return;
    }
    this.ino = st.ino;
    if (st.size <= this.offset) return;
    const fh = await fsp.open(this.path, READ_NOFOLLOW).catch(() => null);
    if (!fh) return;
    try {
      const batch: Batch = { items: [], results: [] };
      while (this.offset < st.size) {
        const { lines, next } = await readForward(fh, this.offset, st.size);
        if (next === this.offset) break;
        this.offset = next;
        for (const line of lines) {
          const out = this.parser.push(parseLine(line.text));
          batch.items.push(...out.items);
          batch.results.push(...out.results);
        }
      }
      batch.results = pairResults(batch.items, batch.results);
      const facts = this.parser.meta();
      const changed = Object.entries(facts).some(([k, v]) => this.meta[k as keyof ConversationMeta] !== v);
      if (changed) this.meta = { ...this.meta, ...facts };
      if (batch.items.length === 0 && batch.results.length === 0 && !changed) return;
      for (const l of this.listeners) l.onBatch(batch, changed ? { ...this.meta } : null);
    } catch (err) {
      this.log.warn({ path: this.path, err: (err as Error).message }, 'transcript read failed');
    } finally {
      await fh.close();
    }
  }
}
