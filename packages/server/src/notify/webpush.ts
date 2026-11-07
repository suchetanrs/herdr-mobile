import type { AttentionAlert } from '@herdr-mobile/protocol';
import type { Notifier } from './notifier.js';

/**
 * EXTENSION POINT, not implemented: Web Push for when no page is open.
 * Needs HTTPS (a secure context for the service worker and PushManager), so it
 * waits for the HTTPS decision (docs/guide.md "Later: HTTPS, system notifications and Web Push"). To add it:
 *  1. generate VAPID keys once into ~/.config/herdr-mobile/vapid.json;
 *  2. add `POST /api/push/subscribe` (auth'd) storing PushSubscription JSON per device;
 *  3. implement `notify` with the `web-push` package: payload = the alert JSON,
 *     `tag` = terminalId so a newer alert replaces an older one, TTL ~ 1 h;
 *     drop subscriptions that answer 404/410;
 *  4. register the sink in app.ts next to InPageSink.
 */
export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subject: string;
}

export class WebPushSink implements Notifier {
  readonly name = 'web-push';
  constructor(readonly config: WebPushConfig) {}

  async notify(_alert: AttentionAlert): Promise<void> {
    throw new Error('web-push sink is not implemented yet');
  }
}
