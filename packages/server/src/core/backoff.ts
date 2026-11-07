/** Exponential backoff with full jitter on the upper half: base, 2x, 4x ... capped. */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly baseMs = 200,
    private readonly maxMs = 5000,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }

  reset(): void {
    this.attempt = 0;
  }
}
