import type { ConversationMeta, ConversationSource } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';
import type { Located } from './locate.js';
import { type Batch, DEFAULT_PAGE, type Page, type PageOptions, type TailListener, TranscriptTail } from './tail.js';

/** What a stream's owner (a WebSocket client) hears. */
export interface ConversationSubscriber {
  onBatch(batch: Batch, meta: ConversationMeta | null): void;
  /** Start over with this page: a new session (`session`) or the file was replaced. */
  onReset(reason: 'session' | 'replaced', source: ConversationSource, page: Page): void;
  onClosed(reason: 'gone'): void;
}

export interface ConversationHandle {
  readonly source: ConversationSource;
  more(before: number, turns: number): Promise<Page>;
  close(): void;
}

export interface ConversationHubOptions {
  /** A terminal's transcript now; null: it has none; 'gone': no such terminal. */
  locate(terminalId: string): Located | null | 'gone';
  logger?: Logger;
  pollMs?: number;
  /** Keep following a file this long after its last reader left (quick tab switches). */
  graceMs?: number;
}

export class ConversationError extends Error {
  constructor(
    readonly code: 'not_found' | 'no_transcript',
    message: string,
  ) {
    super(message);
  }
}

interface Sub {
  terminalId: string;
  located: Located;
  tail: TranscriptTail;
  listener: TailListener;
  pageOpts: PageOptions;
  client: ConversationSubscriber;
  closed: boolean;
  /** Bumped on every switch, so a late page from the old file is dropped. */
  gen: number;
}

/**
 * Conversation streams: one tail per transcript file, shared by every client
 * reading it. Follows terminals to their new transcript when the agent starts
 * another session (the agent-resume label moves on /clear or a restart).
 */
export class ConversationHub {
  private readonly tails = new Map<string, TranscriptTail>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  private readonly subs = new Set<Sub>();
  private readonly log: Logger;

  constructor(private readonly opts: ConversationHubOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  get openCount(): number {
    return this.subs.size;
  }

  async open(terminalId: string, client: ConversationSubscriber, turns: number): Promise<{ handle: ConversationHandle; page: Page }> {
    const located = this.opts.locate(terminalId);
    if (located === 'gone') throw new ConversationError('not_found', `no terminal ${terminalId}`);
    if (!located) throw new ConversationError('no_transcript', `${terminalId} has no transcript the bridge can read`);
    const pageOpts = { ...DEFAULT_PAGE, turns };
    const sub: Sub = {
      terminalId,
      located,
      tail: this.tail(located),
      listener: null as unknown as TailListener,
      pageOpts,
      client,
      closed: false,
      gen: 0,
    };
    sub.listener = this.listenerFor(sub);
    this.subs.add(sub);
    await sub.tail.start();
    const page = await sub.tail.join(sub.listener, pageOpts);
    // Closed while the page was read (its terminal went away): no stream to hand out.
    if (sub.closed) {
      sub.tail.leave(sub.listener);
      throw new ConversationError('not_found', `${terminalId} went away while opening`);
    }
    const handle: ConversationHandle = {
      get source() {
        return sub.located.source;
      },
      more: (before, n) => sub.tail.older(before, { ...pageOpts, turns: n }),
      close: () => this.drop(sub),
    };
    return { handle, page };
  }

  /** Re-checks every stream's terminal (call on world changes). */
  refresh(): void {
    for (const sub of [...this.subs]) {
      if (sub.closed) continue;
      const now = this.opts.locate(sub.terminalId);
      if (now === 'gone') {
        this.drop(sub);
        sub.client.onClosed('gone');
        continue;
      }
      // No transcript right now (the agent quit): keep showing the last one.
      if (!now || now.source.path === sub.located.source.path) continue;
      void this.switchTo(sub, now);
    }
  }

  stop(): void {
    for (const sub of this.subs) sub.closed = true;
    this.subs.clear();
    for (const t of this.idle.values()) clearTimeout(t);
    this.idle.clear();
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
  }

  private listenerFor(sub: Sub): TailListener {
    // Bound to the tail it was made for: a stream that moved on ignores its old file.
    const tail = sub.tail;
    return {
      onBatch: (batch, meta) => {
        if (!sub.closed && sub.tail === tail) sub.client.onBatch(batch, meta);
      },
      onReplaced: () => {
        if (sub.closed || sub.tail !== tail) return;
        const gen = sub.gen;
        void sub.tail.current(sub.pageOpts).then((page) => {
          if (!sub.closed && sub.gen === gen) sub.client.onReset('replaced', sub.located.source, page);
        });
      },
    };
  }

  private async switchTo(sub: Sub, located: Located): Promise<void> {
    this.log.info({ terminal: sub.terminalId, path: located.source.path }, 'conversation moved to a new transcript');
    const old = sub.tail;
    old.leave(sub.listener);
    const gen = ++sub.gen;
    sub.located = located;
    sub.tail = this.tail(located);
    sub.listener = this.listenerFor(sub);
    this.release(old);
    await sub.tail.start();
    if (sub.closed || sub.gen !== gen) return;
    const page = await sub.tail.join(sub.listener, sub.pageOpts);
    if (sub.closed || sub.gen !== gen) {
      sub.tail.leave(sub.listener);
      return;
    }
    sub.client.onReset('session', located.source, page);
  }

  private drop(sub: Sub): void {
    if (sub.closed) return;
    sub.closed = true;
    this.subs.delete(sub);
    sub.tail.leave(sub.listener);
    this.release(sub.tail);
  }

  private tail(located: Located): TranscriptTail {
    const p = located.source.path;
    const timer = this.idle.get(p);
    if (timer) {
      clearTimeout(timer);
      this.idle.delete(p);
    }
    let t = this.tails.get(p);
    if (!t) {
      t = new TranscriptTail(p, located.format, { logger: this.log, ...(this.opts.pollMs ? { pollMs: this.opts.pollMs } : {}) });
      this.tails.set(p, t);
    }
    return t;
  }

  private release(tail: TranscriptTail): void {
    const p = tail.path;
    if ([...this.subs].some((s) => s.tail === tail) || this.idle.has(p)) return;
    const timer = setTimeout(() => {
      this.idle.delete(p);
      if ([...this.subs].some((s) => s.tail === tail)) return;
      tail.stop();
      if (this.tails.get(p) === tail) this.tails.delete(p);
    }, this.opts.graceMs ?? 30_000);
    timer.unref?.();
    this.idle.set(p, timer);
  }
}
