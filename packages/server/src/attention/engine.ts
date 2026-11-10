import { randomUUID } from 'node:crypto';
import type { AttentionAlert } from '@herdr-mobile/protocol';
import { type Logger, silentLogger } from '../log.js';
import type { Notifier } from '../notify/notifier.js';
import type { WordTransition } from '../world/store.js';
import { alertFor, alertText } from './rules.js';

export interface AttentionEngineOptions {
  notifier: Notifier;
  logger?: Logger;
  /**
   * Hold "finished" alerts this long, then drop them if someone marked the turn
   * seen meanwhile (the desktop writes `herdr.seen` when the person is looking at
   * the agent there, and then the desktop itself doesn't alert). 0: send at once.
   */
  doneGraceMs?: number;
  /** True when a "finished" alert for this terminal is no longer news (seen, or being looked at). */
  isSettled?: (terminalId: string) => boolean;
  /** The same alert (terminal, kind, turn) within this window is a duplicate. */
  dedupeMs?: number;
  /** How many recent alerts to keep for newly connected clients. */
  keep?: number;
  now?: () => number;
}

/** Turns word transitions into alerts and hands them to the notifier. */
export class AttentionEngine {
  private readonly notifier: Notifier;
  private readonly log: Logger;
  private readonly doneGraceMs: number;
  private readonly isSettled: (id: string) => boolean;
  private readonly dedupeMs: number;
  private readonly keep: number;
  private readonly now: () => number;
  private readonly lastFired = new Map<string, number>();
  private readonly pendingDone = new Map<string, NodeJS.Timeout>();
  /** "Finished" alerts held while the agent's background work still runs (it shows as working). */
  private readonly heldDone = new Map<string, AttentionAlert>();
  private readonly recentAlerts: AttentionAlert[] = [];

  constructor(opts: AttentionEngineOptions) {
    this.notifier = opts.notifier;
    this.log = opts.logger ?? silentLogger;
    this.doneGraceMs = opts.doneGraceMs ?? 1200;
    this.isSettled = opts.isSettled ?? (() => false);
    this.dedupeMs = opts.dedupeMs ?? 2000;
    this.keep = opts.keep ?? 50;
    this.now = opts.now ?? Date.now;
  }

  get recent(): AttentionAlert[] {
    return [...this.recentAlerts];
  }

  onTransitions(transitions: readonly WordTransition[]): void {
    for (const t of transitions) {
      // Busy again: a "finished" still in its grace period is stale.
      if (t.next === 'working' || t.next === 'blocked' || t.next === 'error') {
        this.cancelDone(t.terminalId);
        this.heldDone.delete(t.terminalId);
      }
      const kind = alertFor(t);
      if (!kind) continue;
      const { title, level } = alertText(kind, t.name);
      const alert: AttentionAlert = {
        id: randomUUID(),
        kind,
        terminalId: t.terminalId,
        title,
        body: t.place,
        level,
        turn: t.turn,
        at: this.now(),
      };
      if (kind === 'done' && t.busy) {
        this.cancelDone(t.terminalId);
        this.heldDone.set(t.terminalId, alert);
      } else if (kind === 'done') this.queueDone(alert);
      else this.fire(alert);
    }
  }

  /** These agents' background work ended: a "finished" held for them is news now (unless seen meanwhile). */
  backgroundEnded(terminalIds: readonly string[]): void {
    for (const id of terminalIds) {
      const alert = this.heldDone.get(id);
      if (!alert) continue;
      this.heldDone.delete(id);
      this.queueDone(alert);
    }
  }

  private queueDone(alert: AttentionAlert): void {
    const id = alert.terminalId;
    if (this.doneGraceMs <= 0) {
      this.fire(alert);
      return;
    }
    this.cancelDone(id);
    const timer = setTimeout(() => {
      this.pendingDone.delete(id);
      if (this.isSettled(id)) {
        this.log.debug({ terminal: id }, 'finished alert dropped: seen meanwhile');
        return;
      }
      this.fire({ ...alert, at: this.now() });
    }, this.doneGraceMs);
    timer.unref();
    this.pendingDone.set(id, timer);
  }

  stop(): void {
    for (const t of this.pendingDone.values()) clearTimeout(t);
    this.pendingDone.clear();
    this.heldDone.clear();
  }

  private cancelDone(id: string): void {
    const t = this.pendingDone.get(id);
    if (t) clearTimeout(t);
    this.pendingDone.delete(id);
  }

  private fire(alert: AttentionAlert): void {
    const key = `${alert.terminalId}|${alert.kind}|${alert.turn}`;
    const last = this.lastFired.get(key);
    if (last !== undefined && alert.at - last < this.dedupeMs) return;
    this.lastFired.set(key, alert.at);
    if (this.lastFired.size > 1000) {
      for (const [k, at] of this.lastFired) if (alert.at - at > this.dedupeMs) this.lastFired.delete(k);
    }
    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > this.keep) this.recentAlerts.splice(0, this.recentAlerts.length - this.keep);
    this.log.info({ terminal: alert.terminalId, kind: alert.kind, title: alert.title }, 'alert');
    this.notifier.notify(alert).catch((err: Error) => this.log.warn({ err: err.message }, 'notifier failed'));
  }
}
