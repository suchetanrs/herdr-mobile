/** A token bucket: `burst` at most, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Takes `cost` tokens if there are enough. */
  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (cost > this.tokens) return false;
    this.tokens -= cost;
    return true;
  }
}

export interface InputLimits {
  /** Input messages (binary frames, keys, send, answer) per second, and burst. */
  messagesPerSecond: number;
  messageBurst: number;
  /** Input bytes per second, and burst. */
  bytesPerSecond: number;
  byteBurst: number;
}

export const DEFAULT_INPUT_LIMITS: InputLimits = {
  messagesPerSecond: 50,
  messageBurst: 200,
  bytesPerSecond: 64 * 1024,
  byteBurst: 256 * 1024,
};

/** One client's input allowance: messages and bytes. */
export class InputLimiter {
  private readonly messages: TokenBucket;
  private readonly bytes: TokenBucket;

  constructor(limits: InputLimits = DEFAULT_INPUT_LIMITS, now?: () => number) {
    this.messages = new TokenBucket(limits.messagesPerSecond, limits.messageBurst, now);
    this.bytes = new TokenBucket(limits.bytesPerSecond, limits.byteBurst, now);
  }

  allow(bytes: number): boolean {
    if (!this.messages.take(1)) return false;
    if (!this.bytes.take(bytes)) return false;
    return true;
  }
}
