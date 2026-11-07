import {
  type ConversationMeta,
  type ConversationServerMessage,
  type ConversationSource,
  type ConvItem,
  mergeItems,
  mergeResults,
  type ToolResult,
} from '@herdr-mobile/protocol';
import type { Connection } from '../lib/connection';
import type { AppStore } from '../lib/store';

export type ConversationStatus = 'loading' | 'live' | 'none' | 'gone' | 'error';

/** One agent's conversation as the page shows it. Immutable: every change makes a new object. */
export interface ConversationState {
  status: ConversationStatus;
  items: ConvItem[];
  /** Cursor for older items; null: the start is loaded. */
  before: number | null;
  loadingOlder: boolean;
  source: ConversationSource | null;
  meta: ConversationMeta;
  error: string | null;
  /** Bumped when the list was replaced (new session): views jump to the end. */
  epoch: number;
  /** Disconnected: what's shown may be behind until the stream re-opens. */
  stale: boolean;
}

const initial = (): ConversationState => ({
  status: 'loading',
  items: [],
  before: null,
  loadingOlder: false,
  source: null,
  meta: {},
  error: null,
  epoch: 0,
  stale: false,
});

type Listener = () => void;

/**
 * A live conversation: opens the stream, keeps the items (upserts, results
 * waiting for their tool call, older pages), re-opens after a reconnect.
 * Read with `get` / `subscribe` (useSyncExternalStore).
 */
export class Conversation {
  private state = initial();
  private readonly listeners = new Set<Listener>();
  private pending = new Map<string, ToolResult>();
  stream: number | null = null;
  req: number | null = null;
  moreReq: number | null = null;
  closed = false;

  constructor(
    readonly terminalId: string,
    private readonly client: ConversationClient,
  ) {}

  get = (): ConversationState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Load the page before the oldest one shown. */
  loadOlder(): void {
    if (this.state.before === null || this.state.loadingOlder || this.stream === null) return;
    if (this.client.more(this, this.state.before)) this.set({ loadingOlder: true });
  }

  close(): void {
    this.client.close(this);
  }

  /** @internal Fed by ConversationClient. */
  apply(m: ConversationServerMessage): void {
    const s = this.state;
    switch (m.t) {
      case 'conv.opened': {
        this.pending = new Map();
        // A re-open after a reconnect keeps the older pages already loaded, when it's the same file and the
        // new page joins up with what's shown. More turns than a page while away: the page alone (older ones
        // load on scroll), else turns in between would be missing.
        const ids = new Set(s.items.map((it) => it.id));
        const joins = m.items.length === 0 || m.items.some((it) => ids.has(it.id));
        const same = s.source?.path === m.source.path && s.items.length > 0 && joins;
        let items = same ? mergeItems(s.items, m.items, { pending: this.pending }) : this.withPending(m.items, m.results);
        // Results that came in while away (a tool finished): their cards stop spinning.
        if (same && m.results?.length) items = mergeResults(items, m.results, this.pending);
        this.set({
          status: 'live',
          items,
          before: same ? s.before : m.before,
          source: m.source,
          meta: m.meta,
          error: null,
          stale: false,
          loadingOlder: false,
          epoch: same ? s.epoch : s.epoch + 1,
        });
        return;
      }
      case 'conv.reset':
        this.pending = new Map();
        this.set({
          status: 'live',
          items: this.withPending(m.items, m.results),
          before: m.before,
          source: m.source,
          meta: m.meta,
          loadingOlder: false,
          epoch: s.epoch + 1,
        });
        return;
      case 'conv.page': {
        for (const r of m.results ?? []) this.pending.set(r.id, r.result);
        this.set({ items: mergeItems(s.items, m.items, { at: 'start', pending: this.pending }), before: m.before, loadingOlder: false });
        return;
      }
      case 'conv.items': {
        let items = m.items.length ? mergeItems(s.items, m.items, { pending: this.pending }) : s.items;
        if (m.results?.length) items = mergeResults(items, m.results, this.pending);
        this.set({ items, ...(m.meta ? { meta: { ...s.meta, ...m.meta } } : {}) });
        return;
      }
      case 'conv.closed':
        this.set({ status: m.reason === 'no_transcript' ? 'none' : m.reason === 'gone' ? 'gone' : s.status, stale: m.reason !== 'gone' });
        return;
      case 'conv.error':
        if (m.req !== undefined && m.req === this.moreReq) {
          this.set({ loadingOlder: false });
          return;
        }
        this.set({
          status: m.code === 'no_transcript' ? 'none' : m.code === 'not_found' ? 'gone' : 'error',
          error: m.message,
          loadingOlder: false,
        });
        return;
    }
  }

  /** @internal */
  markStale(): void {
    if (!this.state.stale) this.set({ stale: true, loadingOlder: false });
  }

  private withPending(items: ConvItem[], results: { id: string; result: ToolResult }[] | undefined): ConvItem[] {
    for (const r of results ?? []) this.pending.set(r.id, r.result);
    return mergeItems([], items, { pending: this.pending });
  }

  private set(patch: Partial<ConversationState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

/** Conversation streams over the page's connection (like TerminalClient for terminals). */
export class ConversationClient {
  private nextReq = 1;
  private readonly open_ = new Set<Conversation>();
  private readonly byReq = new Map<number, Conversation>();
  private readonly byStream = new Map<number, Conversation>();

  constructor(
    private readonly conn: Connection,
    store: AppStore,
  ) {
    store.onConversation((m) => this.onMessage(m));
    conn.onOpen(() => this.reopenAll());
  }

  open(terminalId: string): Conversation {
    const c = new Conversation(terminalId, this);
    this.open_.add(c);
    this.sendOpen(c);
    return c;
  }

  /** @internal */
  more(c: Conversation, before: number): boolean {
    if (c.stream === null) return false;
    const req = this.nextReq++;
    c.moreReq = req;
    this.byReq.set(req, c);
    return this.conn.send({ t: 'conv.more', req, stream: c.stream, before });
  }

  /** @internal */
  close(c: Conversation): void {
    if (c.closed) return;
    c.closed = true;
    this.open_.delete(c);
    if (c.req !== null) this.byReq.delete(c.req);
    if (c.stream !== null) {
      this.byStream.delete(c.stream);
      this.conn.send({ t: 'conv.close', stream: c.stream });
    }
  }

  private sendOpen(c: Conversation): void {
    if (c.req !== null) this.byReq.delete(c.req);
    c.stream = null;
    c.req = this.nextReq++;
    this.byReq.set(c.req, c);
    if (!this.conn.send({ t: 'conv.open', req: c.req, terminalId: c.terminalId })) c.markStale();
  }

  private reopenAll(): void {
    // Streams belong to a connection.
    this.byStream.clear();
    this.byReq.clear();
    for (const c of this.open_) this.sendOpen(c);
  }

  private onMessage(m: ConversationServerMessage): void {
    if (m.t === 'conv.opened') {
      const c = this.byReq.get(m.req);
      this.byReq.delete(m.req);
      if (!c || c.closed) {
        this.conn.send({ t: 'conv.close', stream: m.stream });
        return;
      }
      c.req = null;
      c.stream = m.stream;
      this.byStream.set(m.stream, c);
      c.apply(m);
      return;
    }
    if (m.t === 'conv.page' || (m.t === 'conv.error' && m.req !== undefined)) {
      const c = m.req !== undefined ? this.byReq.get(m.req) : undefined;
      if (m.req !== undefined) this.byReq.delete(m.req);
      // A page asked for before a reset belongs to the old list.
      if (c && !(m.t === 'conv.page' && c.moreReq !== m.req)) c.apply(m);
      if (c && m.req === c.moreReq) c.moreReq = null;
      return;
    }
    const c = 'stream' in m && m.stream !== undefined ? this.byStream.get(m.stream) : undefined;
    if (!c) return;
    if (m.t === 'conv.reset') c.moreReq = null;
    if (m.t === 'conv.closed') {
      this.byStream.delete(m.stream);
      c.stream = null;
    }
    c.apply(m);
  }
}
