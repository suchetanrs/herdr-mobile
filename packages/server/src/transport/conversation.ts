import {
  CONVERSATION_LIMITS,
  CONVERSATION_PROTOCOL_VERSION,
  type ConvError,
  type ConversationClientMessage,
  type ConversationPage,
  type ConversationServerMessage,
} from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';
import { ConversationError, type ConversationHandle, type ConversationHub } from '../transcripts/hub.js';
import type { Page } from '../transcripts/tail.js';

const MAX_STREAMS = 8;

export interface ConversationSessionOptions {
  hub: ConversationHub;
  logger?: Logger;
}

const turnsOf = (n: number | undefined) => Math.max(1, Math.min(n ?? CONVERSATION_LIMITS.defaultTurns, CONVERSATION_LIMITS.maxTurns));

/** One WebSocket client's conversation streams. */
export class ConversationSession {
  private readonly streams = new Map<number, ConversationHandle>();
  private nextStream = 1;
  private opening = 0;
  private closed = false;
  private readonly log: Logger;

  constructor(
    private readonly opts: ConversationSessionOptions,
    private readonly send: (m: ConversationServerMessage) => void,
  ) {
    this.log = opts.logger ?? silentLogger;
  }

  onMessage(msg: ConversationClientMessage): void {
    if (this.closed) return;
    switch (msg.t) {
      case 'conv.open':
        void this.open(msg.req, msg.terminalId, turnsOf(msg.turns));
        return;
      case 'conv.more': {
        const h = this.streams.get(msg.stream);
        if (!h) {
          this.error({ req: msg.req, stream: msg.stream }, 'not_found', `no stream ${msg.stream}`);
          return;
        }
        h.more(msg.before, turnsOf(msg.turns)).then(
          (page) => this.reply({ t: 'conv.page', req: msg.req, stream: msg.stream, ...pageOut(page) }),
          (err: Error) => this.error({ req: msg.req, stream: msg.stream }, 'unavailable', err.message),
        );
        return;
      }
      case 'conv.close': {
        const h = this.streams.get(msg.stream);
        if (!h) return;
        this.streams.delete(msg.stream);
        h.close();
        return;
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const h of this.streams.values()) h.close();
    this.streams.clear();
  }

  private async open(req: number, terminalId: string, turns: number): Promise<void> {
    // Opens still in flight count too (else concurrent opens get past the cap).
    if (this.streams.size + this.opening >= MAX_STREAMS) {
      this.error({ req }, 'too_many', `at most ${MAX_STREAMS} conversations per connection`);
      return;
    }
    const stream = this.nextStream++;
    this.opening++;
    try {
      const { handle, page } = await this.opts.hub.open(
        terminalId,
        {
          onBatch: (batch, meta) => {
            if (!this.streams.has(stream)) return;
            this.reply({
              t: 'conv.items',
              stream,
              items: batch.items,
              ...(batch.results.length ? { results: batch.results } : {}),
              ...(meta ? { meta } : {}),
            });
          },
          onReset: (reason, source, p) => {
            if (this.streams.has(stream)) this.reply({ t: 'conv.reset', stream, reason, source, meta: p.meta, ...pageOut(p) });
          },
          onClosed: (reason) => {
            if (!this.streams.delete(stream)) return;
            this.reply({ t: 'conv.closed', stream, reason });
          },
        },
        turns,
      );
      if (this.closed) {
        handle.close();
        return;
      }
      this.streams.set(stream, handle);
      this.reply({
        t: 'conv.opened',
        req,
        stream,
        terminalId,
        source: handle.source,
        meta: page.meta,
        v: CONVERSATION_PROTOCOL_VERSION,
        ...pageOut(page),
      });
    } catch (err) {
      if (err instanceof ConversationError) this.error({ req }, err.code, err.message);
      else {
        this.log.warn({ terminal: terminalId, err: (err as Error).message }, 'conversation open failed');
        this.error({ req }, 'unavailable', (err as Error).message);
      }
    } finally {
      this.opening--;
    }
  }

  private reply(m: ConversationServerMessage): void {
    if (!this.closed) this.send(m);
  }

  private error(where: { req?: number; stream?: number }, code: ConvError['code'], message: string): void {
    this.reply({ t: 'conv.error', ...where, code, message });
  }
}

/** A page as sent (meta goes separately where the message has it). */
function pageOut(p: Page): ConversationPage {
  return { items: p.items, before: p.before, ...(p.results.length ? { results: p.results } : {}) };
}
