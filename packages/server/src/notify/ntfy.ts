import type { AttentionAlert } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';
import type { Notifier } from './notifier.js';

/**
 * Push through an ntfy server: works without HTTPS on the bridge (the phone
 * runs the ntfy app and subscribes to the topic). OFF unless a topic is set.
 * The topic is a secret (anyone who knows it can read and post), and enabling
 * this sends what the alert says (the agent's name and where it lives) to that
 * server, so it is the user's call: docs/guide.md "Phone notifications (ntfy)".
 */
export interface NtfyConfig {
  /** Server base URL, e.g. https://ntfy.sh or a self-hosted one. */
  server: string;
  topic: string;
  /** Access token for a protected topic (sent as Bearer). */
  token?: string;
  /** Where a tap opens: the bridge's address as the phone reaches it (e.g. http://100.x.y.z:8787). None: no link. */
  clickBase?: string;
  /** Only "an agent needs you / finished": no names or places leave the machine. */
  private?: boolean;
}

export interface NtfySinkOptions {
  config: NtfyConfig;
  /** Someone is looking at this agent right now (fresh lease): don't buzz their pocket too. */
  isLooking?: (terminalId: string) => boolean;
  fetch?: typeof fetch;
  logger?: Logger;
  timeoutMs?: number;
  /** At most this many posts per minute (an alert storm must not flood the phone or the server). */
  perMinute?: number;
  now?: () => number;
}

/** What goes to the server: ntfy's JSON publish format (POST to the server root). */
export function ntfyMessage(alert: AttentionAlert, config: NtfyConfig): Record<string, unknown> {
  const blocked = alert.kind === 'blocked';
  const msg: Record<string, unknown> = {
    topic: config.topic,
    title: config.private ? (blocked ? 'An agent needs you' : 'An agent finished') : alert.title,
    message: config.private ? 'Open Herdr to see which.' : (alert.body ?? alert.title),
    priority: blocked ? 4 : 3,
    tags: [blocked ? 'warning' : 'white_check_mark'],
  };
  if (config.clickBase) msg.click = `${config.clickBase.replace(/\/+$/, '')}/#/a/${encodeURIComponent(alert.terminalId)}`;
  return msg;
}

export class NtfySink implements Notifier {
  readonly name = 'ntfy';
  private readonly log: Logger;
  private readonly sent: number[] = [];

  constructor(private readonly opts: NtfySinkOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  async notify(alert: AttentionAlert): Promise<void> {
    if (this.opts.isLooking?.(alert.terminalId)) return;
    const now = (this.opts.now ?? Date.now)();
    while (this.sent.length > 0 && now - (this.sent[0] as number) > 60_000) this.sent.shift();
    if (this.sent.length >= (this.opts.perMinute ?? 20)) {
      this.log.warn('ntfy: too many alerts this minute; skipping');
      return;
    }
    this.sent.push(now);
    const { config } = this.opts;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const r = await (this.opts.fetch ?? fetch)(config.server.replace(/\/+$/, '') || config.server, {
        method: 'POST',
        headers,
        body: JSON.stringify(ntfyMessage(alert, config)),
        signal: ctl.signal,
        redirect: 'error',
      });
      // Never log the topic or token (they are the secret); the status is enough.
      if (!r.ok) throw new Error(`ntfy server answered ${r.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The sink's config from HERDR_MOBILE_NTFY_*; null (off) unless a topic is set. */
export function ntfyConfigFrom(env: NodeJS.ProcessEnv): NtfyConfig | null {
  const topic = env.HERDR_MOBILE_NTFY_TOPIC?.trim();
  if (!topic) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error('HERDR_MOBILE_NTFY_TOPIC: 1-64 letters, digits, _ or -');
  const server = env.HERDR_MOBILE_NTFY_SERVER?.trim() || 'https://ntfy.sh';
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error(`HERDR_MOBILE_NTFY_SERVER is not a URL: ${server}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('HERDR_MOBILE_NTFY_SERVER must be http(s)');
  const config: NtfyConfig = { server, topic };
  if (env.HERDR_MOBILE_NTFY_TOKEN) config.token = env.HERDR_MOBILE_NTFY_TOKEN;
  if (env.HERDR_MOBILE_NTFY_CLICK) config.clickBase = env.HERDR_MOBILE_NTFY_CLICK;
  if (env.HERDR_MOBILE_NTFY_PRIVATE === '1') config.private = true;
  return config;
}
