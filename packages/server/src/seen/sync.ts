import type { World } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';

export interface SeenSyncOptions {
  world: () => World;
  /** Terminals a person is looking at right now (page visible, agent on screen). */
  looking: () => ReadonlySet<string>;
  /** The terminal's program is running (finished terminals are never marked). */
  isLive: (terminalId: string) => boolean;
  /** Writes `herdr.seen=<turn>` on the terminal. */
  write: (terminalId: string, turn: number) => Promise<void>;
  /** Wait this long after a change before deciding (a turn ends with a status event, then a turn event). */
  debounceMs?: number;
  logger?: Logger;
}

/**
 * Shares what the phone shows as `herdr.seen`, the way Herdr desktop does
 * (herdr-app window.rs `share_seen`, docs/labels.md): for an agent someone is
 * looking at, once per turn while it stays on screen, write its turn as
 * `herdr.seen`, only to raise it (or when it's missing). Looking away and back
 * later raises it again; a lower "mark unread" written elsewhere isn't
 * overruled while it just stays on screen.
 */
export class SeenSync {
  private readonly log: Logger;
  private readonly debounceMs: number;
  /** The turn each on-screen terminal was last considered at. */
  private readonly looked = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  /** Writes made (tests, logs). */
  writes = 0;

  constructor(private readonly opts: SeenSyncOptions) {
    this.log = opts.logger ?? silentLogger;
    this.debounceMs = opts.debounceMs ?? 300;
  }

  /** Something changed (world or looking): re-check what's on screen. */
  update(): void {
    if (this.stopped) return;
    const looking = this.opts.looking();
    for (const id of [...this.looked.keys()]) if (!looking.has(id)) this.looked.delete(id);
    for (const id of looking) this.schedule(id);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(id: string): void {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.check(id);
    }, this.debounceMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  private check(id: string): void {
    if (this.stopped || !this.opts.looking().has(id)) return;
    const t = this.opts.world().terminals[id];
    // Agents only (a plain shell has no word), and only live ones.
    if (!t || t.word === null || !this.opts.isLive(id)) return;
    const turn = t.turn;
    if (this.looked.get(id) === turn) return;
    this.looked.set(id, turn);
    if (t.seenTurn !== null && t.seenTurn >= turn) return;
    this.writes++;
    this.opts.write(id, turn).catch((err: Error) => {
      this.log.warn({ terminal: id, turn, err: err.message }, 'writing herdr.seen failed');
      // Try again on the next change, as the desktop does.
      if (this.looked.get(id) === turn) this.looked.delete(id);
    });
  }
}
