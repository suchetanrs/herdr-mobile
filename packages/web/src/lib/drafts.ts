import { load, save } from './storage';

type Listener = () => void;

/** Per-agent composer drafts (localStorage `hm.draft.<id>`), with which agents have one, for the lists. */
class Drafts {
  private ids: ReadonlySet<string> = new Set();
  private readonly listeners = new Set<Listener>();
  private scanned = false;

  /** Agents with a non-empty draft (a new set on every change). */
  withDrafts = (): ReadonlySet<string> => {
    if (!this.scanned) this.scan();
    return this.ids;
  };

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  get(terminalId: string): string {
    return load<string>(`draft.${terminalId}`, '');
  }

  set(terminalId: string, text: string): void {
    save(`draft.${terminalId}`, text || null);
    if (!this.scanned) this.scan();
    const has = text.trim().length > 0;
    if (has === this.ids.has(terminalId)) return;
    const next = new Set(this.ids);
    if (has) next.add(terminalId);
    else next.delete(terminalId);
    this.ids = next;
    for (const l of this.listeners) l();
  }

  private scan(): void {
    this.scanned = true;
    const found = new Set<string>();
    try {
      const ls = globalThis.localStorage;
      for (let i = 0; i < (ls?.length ?? 0); i++) {
        const k = ls?.key(i);
        if (k?.startsWith('hm.draft.') && this.get(k.slice('hm.draft.'.length)).trim()) found.add(k.slice('hm.draft.'.length));
      }
    } catch {
      // storage blocked: no drafts to show
    }
    this.ids = found;
  }
}

export const drafts = new Drafts();
