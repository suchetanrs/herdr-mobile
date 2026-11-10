import type { AgentAccount } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';
import { accountsOf, backgroundOf, ConfigCache, findClaudeProcesses, type ScanOptions } from './scan.js';

export interface ClaudeAccountsOptions extends ScanOptions {
  /** Called when some terminal's account changed (the world store rebuilds). */
  onChange: () => void;
  /** These terminals' `claude` no longer has background work running. */
  onBackgroundEnd?: (terminals: string[]) => void;
  logger?: Logger;
  /** Re-scan this often regardless (a /login inside a running claude; my-agents polls every 15 s). */
  intervalMs?: number;
  /** A burst of world changes is scanned once, this long after it starts. */
  debounceMs?: number;
}

/**
 * Keeps the terminal -> Claude account map (and which `claude` has background work) fresh: on an interval, and soon after the
 * terminals or their programs change (`poke`). Local terminals only: an address on
 * another machine (`vps/t7`) never has one.
 */
export class ClaudeAccounts {
  private accounts = new Map<string, AgentAccount>();
  private background = new Set<string>();
  private readonly cache = new ConfigCache();
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private pokeTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private started = false;
  private stopped = false;

  private warned = false;
  private readonly opts: ClaudeAccountsOptions;

  constructor(opts: ClaudeAccountsOptions) {
    this.log = opts.logger ?? silentLogger;
    this.opts = {
      ...opts,
      onDenied: (pid) => {
        opts.onDenied?.(pid);
        if (this.warned) return;
        this.warned = true;
        // Pid only: nothing from the process or its config.
        this.log.warn(
          { claudePid: pid },
          "can't read a claude process's environment (EACCES): no Claude accounts for it. A systemd unit with ProtectSystem/PrivateTmp runs the bridge in its own user namespace, which hides it",
        );
      },
    };
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.opts.intervalMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.timer = null;
    this.pokeTimer = null;
  }

  get(address: string): AgentAccount | null {
    if (address.includes('/')) return null;
    return this.accounts.get(address) ?? null;
  }

  /** Its `claude` has a Bash tool command running (background work), as of the last scan. */
  busy(address: string): boolean {
    return this.background.has(address);
  }

  /** Terminals appeared, exited or changed program: scan soon. */
  poke(): void {
    if (!this.started || this.stopped || this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.scan();
    }, this.opts.debounceMs ?? 300);
    this.pokeTimer.unref();
  }

  /** One scan at a time; a request meanwhile runs one more after it. Resolves when the map is current. */
  async scan(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        let next: Map<string, AgentAccount>;
        let bg: Set<string>;
        try {
          const procs = await findClaudeProcesses(this.opts);
          next = await accountsOf(procs, this.cache);
          bg = await backgroundOf(procs, this.opts.procRoot);
        } catch (err) {
          // Only the error's code: messages could quote a path, never file contents, but keep it minimal.
          this.log.debug({ code: (err as NodeJS.ErrnoException).code ?? 'error' }, 'claude account scan failed');
          continue;
        }
        if (this.stopped) return;
        const ended = [...this.background].filter((t) => !bg.has(t));
        const bgChanged = ended.length > 0 || bg.size !== this.background.size;
        if (!sameMap(this.accounts, next) || bgChanged) {
          this.accounts = next;
          this.background = bg;
          this.opts.onChange();
        }
        if (ended.length) this.opts.onBackgroundEnd?.(ended);
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}

function sameMap(a: ReadonlyMap<string, AgentAccount>, b: ReadonlyMap<string, AgentAccount>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.name !== v.name || w.plan !== v.plan) return false;
  }
  return true;
}
