import type { AttentionAlert } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';

/**
 * Somewhere an alert can go. Sinks are independent: one failing never stops
 * the others. Adding a channel (web push, ntfy, ...) is a new sink registered
 * in app.ts; nothing else changes.
 */
export interface Notifier {
  readonly name: string;
  notify(alert: AttentionAlert): Promise<void>;
}

/** Fans an alert out to every registered sink. */
export class NotifierHub implements Notifier {
  readonly name = 'hub';
  private readonly sinks: Notifier[] = [];
  constructor(private readonly log: Logger = silentLogger) {}

  add(sink: Notifier): this {
    this.sinks.push(sink);
    return this;
  }

  get sinkNames(): string[] {
    return this.sinks.map((s) => s.name);
  }

  async notify(alert: AttentionAlert): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((s) => s.notify(alert)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') this.log.warn({ sink: this.sinks[i]?.name, err: String(r.reason) }, 'notifier sink failed');
    });
  }
}
