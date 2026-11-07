import { LOOKING_RENEW_MS } from '@herdr-mobile/protocol';
import type { Connection } from './connection';

/**
 * Tells the bridge which agents the person is looking at: only while the page
 * is visible (and focused, on a desktop), and only agents actually on screen.
 * The bridge marks those seen (as the desktop does) and skips "finished"
 * alerts for them. It's a lease: repeated every LOOKING_RENEW_MS while it
 * holds, so a phone that locks before `[]` gets out stops counting by itself.
 */
export class LookingTracker {
  private readonly counts = new Map<string, number>();
  private sent = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renew: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly conn: Connection) {
    conn.onOpen(() => {
      this.sent = '';
      this.flush();
    });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => this.flush());
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flush());
      window.addEventListener('focus', () => this.flush());
      window.addEventListener('blur', () => this.flush());
    }
  }

  /** An agent came on screen; call the returned function when it leaves. */
  add(terminalId: string): () => void {
    this.counts.set(terminalId, (this.counts.get(terminalId) ?? 0) + 1);
    this.schedule();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.counts.get(terminalId) ?? 1) - 1;
      if (n <= 0) this.counts.delete(terminalId);
      else this.counts.set(terminalId, n);
      this.schedule();
    };
  }

  /** What the bridge should hear right now. */
  current(): string[] {
    return inFront() ? [...this.counts.keys()].sort() : [];
  }

  isLooking(terminalId: string): boolean {
    return this.current().includes(terminalId);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 50);
  }

  private flush(force = false): void {
    const ids = this.current();
    const key = ids.join('\u0000');
    if (ids.length > 0 && !this.renew) this.renew = setInterval(() => this.flush(true), LOOKING_RENEW_MS);
    if (ids.length === 0 && this.renew) {
      clearInterval(this.renew);
      this.renew = null;
    }
    if (key === this.sent && !(force && ids.length > 0)) return;
    if (this.conn.send({ t: 'looking', terminalIds: ids })) this.sent = key;
  }
}

/** The page is in front of the person: visible, and on a desktop (fine pointer) also the focused window. */
function inFront(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState !== 'visible') return false;
  const desktop = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
  return !desktop || typeof document.hasFocus !== 'function' || document.hasFocus();
}
