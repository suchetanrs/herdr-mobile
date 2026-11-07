import type { AttentionAlert } from '@herdr-mobile/protocol';
import type { Notifier } from './notifier.js';

/** Sends alerts to open pages over their WebSocket (in-page toast, sound, Notification API). */
export class InPageSink implements Notifier {
  readonly name = 'in-page';
  constructor(private readonly broadcast: (alert: AttentionAlert) => void) {}

  async notify(alert: AttentionAlert): Promise<void> {
    this.broadcast(alert);
  }
}
