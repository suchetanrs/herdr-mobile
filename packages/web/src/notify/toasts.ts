import type { AttentionAlert } from '@herdr-mobile/protocol';
import type { AlertContext, ClientNotifier } from './notifier';

export interface Toast {
  id: string;
  title: string;
  body: string | null;
  /** Herdr's toast levels: the dot's color. */
  level: 'error' | 'warning' | 'success' | 'info';
  /** Tapping it opens this agent. */
  terminalId: string | null;
  at: number;
}

type Listener = () => void;

/** The in-page toasts (Herdr's toast mod: popover, colored dot, title, "space / tab"). */
export class ToastStore {
  private list: Toast[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  get = (): Toast[] => this.list;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  show(t: Omit<Toast, 'at'>, ttlMs = 6000): void {
    this.list = [{ ...t, at: Date.now() }, ...this.list.filter((x) => x.id !== t.id)].slice(0, 3);
    this.emit();
    const old = this.timers.get(t.id);
    if (old) clearTimeout(old);
    this.timers.set(
      t.id,
      setTimeout(() => this.dismiss(t.id), ttlMs),
    );
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const next = this.list.filter((x) => x.id !== id);
    if (next.length === this.list.length) return;
    this.list = next;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Herdr toasts an alert unless you're looking at that agent (window.rs `alert`). */
export class ToastSink implements ClientNotifier {
  readonly name = 'toast';
  constructor(private readonly toasts: ToastStore) {}

  notify(alert: AttentionAlert, ctx: AlertContext): void {
    if (ctx.looking && ctx.visible) return;
    this.toasts.show(
      { id: alert.id, title: alert.title, body: alert.body, level: alert.level, terminalId: alert.terminalId },
      alert.kind === 'blocked' ? 10000 : 6000,
    );
  }
}
