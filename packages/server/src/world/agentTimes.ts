import fs from 'node:fs';
import path from 'node:path';
import type { AgentStatus } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';

/**
 * When the desktop's agents list says each agent last changed state: its
 * agents mod keeps `{address: {s, at}}` in its localStorage
 * (data/agents/store.json, key `changed`), done and idle counting as one.
 * Read only, stat-polled like SpaceColors.
 */
export class AgentTimes {
  private changed: Record<string, { s: string | null; at: number }> = {};
  private watching = false;
  private readonly file: string;
  private readonly log: Logger;

  constructor(
    herdrAppDir: string,
    private readonly onChange: () => void,
    logger?: Logger,
    private readonly intervalMs = 2000,
  ) {
    this.file = path.join(herdrAppDir, 'data', 'agents', 'store.json');
    this.log = logger ?? silentLogger;
  }

  start(): void {
    this.read();
    if (this.watching) return;
    this.watching = true;
    fs.watchFile(this.file, { interval: this.intervalMs, persistent: false }, () => {
      if (this.read()) this.onChange();
    });
  }

  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    fs.unwatchFile(this.file);
  }

  /** The desktop's "since" for an agent, if its stamp is for the state it's in now. */
  since(address: string, status: AgentStatus | null): number | null {
    const c = this.changed[address];
    const s = status === 'done' ? 'idle' : status;
    return c && c.s === s ? c.at : null;
  }

  /** Re-reads the file; true when it changed. */
  read(): boolean {
    let next: typeof this.changed = {};
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { changed?: unknown };
      const raw = typeof v.changed === 'string' ? (JSON.parse(v.changed) as unknown) : v.changed;
      if (raw && typeof raw === 'object') {
        for (const [k, c] of Object.entries(raw as Record<string, { s?: unknown; at?: unknown }>)) {
          if (c && typeof c.at === 'number' && (typeof c.s === 'string' || c.s === null)) next[k] = { s: c.s, at: c.at };
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.debug({ err: (err as Error).message }, 'agents store unreadable');
      next = {};
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.changed);
    this.changed = next;
    return changed;
  }
}
