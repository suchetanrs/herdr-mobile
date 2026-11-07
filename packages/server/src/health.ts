import fs from 'node:fs';
import { CONVERSATION_PROTOCOL_VERSION, PROTOCOL_VERSION, type World } from '@herdr-mobile/protocol';
import type { CoreClient } from './core/client.js';

/** The bridge's own version (packages/server/package.json; the same file from src/ and dist/). */
export function bridgeVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface HealthOptions {
  client: Pick<CoreClient, 'on'>;
  world: () => World;
  clients: () => number;
  now?: () => number;
}

/**
 * `GET /api/health`: is the bridge up, is herdr-core connected (and since when,
 * how many reconnects, the last error), and every version. Without a session only `{ ok: true }`
 * (even up/connected tells a peer whether Herdr, and so its owner, is active).
 */
export class Health {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly version = bridgeVersion();
  private coreSince: number;
  private connects = 0;
  private lastError: string | null = null;

  constructor(private readonly opts: HealthOptions) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.coreSince = this.startedAt;
    opts.client.on('ready', () => {
      this.connects++;
      this.coreSince = this.now();
    });
    opts.client.on('down', (err) => {
      this.coreSince = this.now();
      if (err) this.lastError = (err as NodeJS.ErrnoException).code ?? err.message;
    });
    opts.client.on('failed', (err) => {
      this.lastError = (err as NodeJS.ErrnoException).code ?? err.message;
    });
  }

  /** The full report, for a signed-in caller (others get only `{ ok: true }`: transport/http.ts). */
  report(): Record<string, unknown> {
    const now = this.now();
    const core = this.opts.world().core;
    return {
      ok: true,
      status: core.connected ? 'ok' : 'degraded',
      core: {
        connected: core.connected,
        version: core.version,
        name: core.name,
        /** Seconds in the current state (connected or not). */
        forS: Math.round((now - this.coreSince) / 1000),
        reconnects: Math.max(0, this.connects - 1),
        lastError: core.connected ? null : this.lastError,
      },
      bridge: {
        version: this.version,
        protocol: PROTOCOL_VERSION,
        conversationProtocol: CONVERSATION_PROTOCOL_VERSION,
        node: process.version,
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeS: Math.round((now - this.startedAt) / 1000),
        clients: this.opts.clients(),
      },
    };
  }
}
