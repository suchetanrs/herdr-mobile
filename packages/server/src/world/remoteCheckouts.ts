import type { CoreClient } from '../core/client.js';
import { type Logger, silentLogger } from '../log.js';

/** The exact command the desktop runs to name an unnamed space (window.rs `folder_info`). */
export function gitTopArgv(cwd: string): string[] {
  return ['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'];
}

/**
 * Checkout tops of folders on other machines, asked of the core with
 * `machine.exec` running git there (the desktop does the same through
 * `hc exec --on`). Answers from a cache; a miss starts one lookup and returns
 * null (the caller shows the folder itself) and `onChange` fires when it lands.
 */
export class RemoteCheckouts {
  private readonly cache = new Map<string, { top: string | null; at: number; pending: boolean }>();
  private readonly log: Logger;

  constructor(
    private readonly client: Pick<CoreClient, 'call' | 'connected'>,
    private readonly onChange: () => void,
    logger?: Logger,
    private readonly ttlMs = 60_000,
  ) {
    this.log = logger ?? silentLogger;
  }

  top(machine: string, cwd: string): string | null {
    const key = `${machine}\0${cwd}`;
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && (hit.pending || now - hit.at < this.ttlMs)) return hit.top;
    if (!this.client.connected) return hit?.top ?? null;
    if (this.cache.size > 500) this.cache.clear();
    const entry = { top: hit?.top ?? null, at: now, pending: true };
    this.cache.set(key, entry);
    this.client
      .call<{ code: number | null; stdout?: string }>('machine.exec', { on: machine, argv: gitTopArgv(cwd), timeout: 10 }, 15_000)
      .then((r) => {
        const lines =
          r.code === 0
            ? Buffer.from(r.stdout ?? '', 'base64')
                .toString('utf8')
                .split('\n')
            : [];
        const top = lines[0]?.trim() || cwd;
        entry.pending = false;
        entry.at = Date.now();
        if (entry.top !== top) {
          entry.top = top;
          this.onChange();
        }
      })
      .catch((err: Error) => {
        entry.pending = false;
        entry.at = Date.now();
        this.log.debug({ machine, err: err.message }, 'remote checkout lookup failed');
      });
    return entry.top;
  }
}
