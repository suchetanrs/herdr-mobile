import fs from 'node:fs';
import path from 'node:path';
import { type Logger, silentLogger } from '../log.js';

/**
 * The avatar colors the desktop gives spaces (`space.colors` in herdr-app's
 * shared.json, written by its spaces mod). Read only: polled with a cheap
 * stat, so atomic rewrites by the app are picked up within `intervalMs`.
 */
export class SpaceColors {
  private colors: Record<string, string> = {};
  private watching = false;
  private readonly file: string;
  private readonly log: Logger;

  constructor(
    herdrAppDir: string,
    private readonly onChange: () => void,
    logger?: Logger,
    private readonly intervalMs = 2000,
  ) {
    this.file = path.join(herdrAppDir, 'shared.json');
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

  /** A space's color ("ansi6", "#22a99a"), by its id or (for a machine's space) its unqualified id. */
  get(spaceId: string): string | null {
    const local = spaceId.slice(spaceId.lastIndexOf('/') + 1);
    return this.colors[spaceId] ?? this.colors[local] ?? null;
  }

  /** Re-reads the file; true when the colors changed. */
  read(): boolean {
    let next: Record<string, string> = {};
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { 'space.colors'?: unknown };
      const raw = v['space.colors'];
      if (raw && typeof raw === 'object') {
        for (const [k, c] of Object.entries(raw as Record<string, unknown>))
          if (typeof c === 'string' && /^(ansi\d{1,2}|#[0-9a-fA-F]{6})$/.test(c)) next[k] = c;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.debug({ err: (err as Error).message }, 'shared.json unreadable');
      next = {};
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.colors);
    this.colors = next;
    return changed;
  }
}
