import type { CoreEvent, CoreTerminal } from '../core/types.js';

/**
 * The core's terminals as an event-subscribed client sees them: a snapshot
 * plus events applied the way schema/README.md "Events" says (and as
 * herdr-app's hc.rs `apply` does).
 */
export class TerminalTable {
  private readonly byAddress = new Map<string, CoreTerminal>();
  private seq = -1;

  /** Replaces everything with a fresh snapshot (subscribe, reconnect, `missed`). */
  reset(seq: number, terminals: readonly CoreTerminal[]): void {
    this.byAddress.clear();
    for (const t of terminals) this.byAddress.set(t.address, structuredClone(t));
    this.seq = seq;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get(address: string): CoreTerminal | undefined {
    return this.byAddress.get(address);
  }

  all(): IterableIterator<CoreTerminal> {
    return this.byAddress.values();
  }

  get size(): number {
    return this.byAddress.size;
  }

  /** Applies one event; returns whether a terminal changed. Events at or below the snapshot's seq are stale. */
  apply(ev: CoreEvent): boolean {
    if (ev.seq <= this.seq) return false;
    this.seq = ev.seq;
    const address = ev.terminal;
    if (!address) return false;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    const whole =
      ev.type === 'created' || ev.type === 'restarted'
        ? (data as CoreTerminal)
        : ev.type === 'labels'
          ? (data.record as CoreTerminal | undefined)
          : undefined;
    if (whole && typeof whole === 'object') {
      this.byAddress.set(address, structuredClone({ ...whole, address }));
      return true;
    }
    const t = this.byAddress.get(address);
    if (!t) return false;
    const set = (...keys: string[]) => {
      for (const k of keys) t[k] = data[k] ?? null;
    };
    switch (ev.type) {
      case 'removed':
        this.byAddress.delete(address);
        return true;
      case 'finished':
      case 'lost':
        set('reason', 'exit_code', 'signal', 'finished_ms');
        t.state = ev.type === 'lost' ? 'live' : 'finished';
        if (ev.type === 'lost') t.pid = null;
        delete t.foreground;
        return true;
      case 'status':
        set('status', 'records', 'reported');
        // The event doesn't carry status_ms; stamp it here so clients can show "since".
        t.status_ms = Date.now();
        return true;
      case 'turn':
        t.turn = typeof data.turn === 'number' ? data.turn : (t.turn ?? 0);
        return true;
      case 'title':
        set('title');
        return true;
      case 'labels':
        t.labels = (data.labels as Record<string, string> | undefined) ?? {};
        return true;
      case 'keep':
        set('keep');
        return true;
      case 'size':
        set('cols', 'rows');
        return true;
      case 'foreground':
        t.foreground = (ev.data as CoreTerminal['foreground']) ?? null;
        return true;
      default:
        return false;
    }
  }
}
