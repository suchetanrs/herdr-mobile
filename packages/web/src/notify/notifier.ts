import type { AttentionAlert } from '@herdr-mobile/protocol';

/** What the page knows when an alert arrives. */
export interface AlertContext {
  /** The page is in front (not a background tab, not a locked phone). */
  visible: boolean;
  /** The person is looking at this alert's agent right now. */
  looking: boolean;
}

/**
 * Somewhere an alert can go on this device: the client-side twin of the
 * bridge's `Notifier` (packages/server/src/notify/notifier.ts). Sinks are
 * independent; adding one (Web Push once there's HTTPS) is one `add` call.
 */
export interface ClientNotifier {
  readonly name: string;
  notify(alert: AttentionAlert, ctx: AlertContext): void | Promise<void>;
}

export class ClientNotifierHub implements ClientNotifier {
  readonly name = 'hub';
  private readonly sinks: ClientNotifier[] = [];

  add(sink: ClientNotifier): this {
    this.sinks.push(sink);
    return this;
  }

  get sinkNames(): string[] {
    return this.sinks.map((s) => s.name);
  }

  async notify(alert: AttentionAlert, ctx: AlertContext): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map(async (s) => s.notify(alert, ctx)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`alert sink ${this.sinks[i]?.name} failed`, r.reason);
    });
  }
}
