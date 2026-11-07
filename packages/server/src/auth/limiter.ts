export interface AuthLimiterOptions {
  /** Failed attempts allowed per address within `windowMs` before it is blocked. */
  maxFailures?: number;
  windowMs?: number;
  /** How long a blocked address gets 429s (any request with or without a token). */
  blockMs?: number;
  /** Most addresses tracked at once (oldest dropped first), so a flood can't grow memory without bound. */
  maxTracked?: number;
  now?: () => number;
}

interface Entry {
  failures: number[];
  blockedUntil: number;
}

/**
 * Per-address limit on failed auth (a wrong token, or no token where one is
 * needed). The 256-bit token can't be guessed anyway; this keeps a noisy peer
 * on a shared tailnet from hammering the bridge and makes probing visible.
 */
export class AuthLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly maxTracked: number;
  private readonly now: () => number;

  constructor(opts: AuthLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 30;
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.blockMs = opts.blockMs ?? 10 * 60_000;
    this.maxTracked = opts.maxTracked ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** Milliseconds this address must still wait, or 0 if it may try. */
  blockedFor(addr: string): number {
    const e = this.entries.get(addr);
    if (!e) return 0;
    return Math.max(0, e.blockedUntil - this.now());
  }

  /** Records a failure; returns true if the address is now blocked. */
  fail(addr: string): boolean {
    const now = this.now();
    let e = this.entries.get(addr);
    if (!e) {
      if (this.entries.size >= this.maxTracked) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      e = { failures: [], blockedUntil: 0 };
      this.entries.set(addr, e);
    }
    e.failures = e.failures.filter((t) => now - t < this.windowMs);
    e.failures.push(now);
    if (e.failures.length >= this.maxFailures) {
      e.blockedUntil = now + this.blockMs;
      e.failures = [];
      return true;
    }
    return false;
  }

  /** A good token from this address clears its record. */
  succeed(addr: string): void {
    const e = this.entries.get(addr);
    if (e && e.blockedUntil <= this.now()) this.entries.delete(addr);
  }
}
