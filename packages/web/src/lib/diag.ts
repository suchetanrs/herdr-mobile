import { BUILD } from './build';
import { load, save } from './storage';
import type { AppStore } from './store';

/**
 * Diagnostics (Settings > Diagnostics): while on, a ring buffer of what the app went through — screens visited,
 * connection changes, errors, taps on controls, the app going to the background — that "Send to bridge" posts
 * to `POST /api/diag` (kept in ~/.local/state/herdr-mobile/diag.jsonl), so a problem seen on a phone can be read
 * on the computer.
 *
 * Never recorded: what's typed or shown (no values, no text content), cookies, tokens, the address's query.
 * Selectors use tag, id and classes only; long token-like runs in any string are redacted.
 */

export const DIAG_KEY = 'diag';
export const MAX_EVENTS = 300;
/** The bridge takes 48 KiB; stay under it. */
export const MAX_REPORT_BYTES = 44 * 1024;

export type DiagEvent = { k: string; t: number } & Record<string, unknown>;

const TOKENISH = /[A-Za-z0-9_\-+/=]{32,}/g;

/** A string safe to send: capped, token-like runs redacted, `token=` values dropped. */
export function redact(s: string, max = 200): string {
  const cut = s.length > max ? `${s.slice(0, max)}…` : s;
  return cut.replace(/(token|session|cookie)=[^&\s#;]*/gi, '$1=[redacted]').replace(TOKENISH, '[redacted]');
}

/** The address without its query, and without any sign-in fragment. */
export function safeLocation(loc: Pick<Location, 'pathname' | 'hash'>): string {
  const hash = loc.hash.startsWith('#token=') ? '#token=[redacted]' : loc.hash;
  return redact(`${loc.pathname}${hash}`, 120);
}

function one(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id.slice(0, 30)}`;
  const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3) : [];
  for (const c of cls) s += `.${c.slice(0, 30)}`;
  return s;
}

/** `div.keybar>button.key`: the element and two ancestors, by tag, id and classes only. */
export function selectorOf(target: EventTarget | null | undefined): string | null {
  if (!(target instanceof Element)) return null;
  const parts: string[] = [];
  for (let el: Element | null = target; el && parts.length < 3; el = el.parentElement) {
    parts.unshift(one(el));
    if (el === document.documentElement) break;
  }
  return redact(parts.join('>'), 160);
}

/** The device and page facts that go with every report. */
export function deviceInfo(store: AppStore | null): Record<string, unknown> {
  const st = store?.getState();
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    build: BUILD,
    serverBuild: st?.serverBuild ?? null,
    ua: redact(navigator.userAgent, 200),
    standalone,
    screen: [screen.width, screen.height],
    dpr: window.devicePixelRatio,
    loc: safeLocation(window.location),
    visible: document.visibilityState,
    ws: st ? { status: st.conn.status, everSynced: st.conn.everSynced, attempt: st.conn.attempt, offline: st.conn.offline } : null,
  };
}

type Sender = (body: string) => Promise<number>;

const defaultSender: Sender = async (body) => {
  const r = await fetch('/api/diag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  await r.text().catch(() => '');
  return r.status;
};

export type SendResult = 'sent' | 'limited' | 'signed-out' | 'failed';

/** The recorder. Off by default; on, it listens (passive, never preventing anything) and keeps the last MAX_EVENTS events. */
export class DiagRecorder {
  private events: DiagEvent[] = [];
  private on = false;
  private readonly t0 = performance.now();
  private offs: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();
  private snap = '';
  private notify: ReturnType<typeof setTimeout> | null = null;
  lastSend: { at: number; result: SendResult } | null = null;

  constructor(
    private readonly store: AppStore | null,
    private readonly send: Sender = defaultSender,
  ) {}

  get enabled(): boolean {
    return this.on;
  }

  get count(): number {
    return this.events.length;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Changes whenever what Settings shows (on/off, count, last send) does. */
  snapshot(): string {
    return this.snap;
  }

  /** `later`: an event being recorded, notified after it (a re-render inside a click would undo a checkbox's toggle). */
  private changed(later = false): void {
    this.snap = `${this.on}|${this.events.length}|${this.lastSend?.at ?? 0}`;
    if (!later) {
      for (const l of this.listeners) l();
      return;
    }
    if (this.notify) return;
    this.notify = setTimeout(() => {
      this.notify = null;
      for (const l of this.listeners) l();
    }, 0);
  }

  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    save(DIAG_KEY, on ? true : null);
    if (on) this.attach();
    else this.detach();
    this.changed();
  }

  /** Adds one event (no-op while off). */
  push(k: string, fields: Record<string, unknown> = {}): void {
    if (!this.on) return;
    this.events.push({ k, t: Math.round(performance.now() - this.t0), ...fields });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.changed(true);
  }

  /** What would be sent now: device facts plus the newest events that fit MAX_REPORT_BYTES. */
  report(): string {
    const info = deviceInfo(this.store);
    let events = this.events.slice();
    let body = JSON.stringify({ info, events });
    while (body.length > MAX_REPORT_BYTES && events.length > 0) {
      events = events.slice(Math.ceil(events.length / 4));
      body = JSON.stringify({ info, events });
    }
    return body;
  }

  async flush(): Promise<SendResult> {
    let result: SendResult;
    try {
      const status = await this.send(this.report());
      result = status === 200 ? 'sent' : status === 429 ? 'limited' : status === 401 ? 'signed-out' : 'failed';
    } catch {
      result = 'failed';
    }
    this.lastSend = { at: Date.now(), result };
    this.changed();
    return result;
  }

  private attach(): void {
    this.push('start', deviceInfo(this.store));
    const listen = (t: EventTarget, type: string, fn: (e: Event) => void, capture = false) => {
      const o = { capture, passive: true };
      t.addEventListener(type, fn, o);
      this.offs.push(() => t.removeEventListener(type, fn, o));
    };
    listen(
      document,
      'click',
      (e) => {
        const el = e.target instanceof Element ? e.target.closest('button, a, [role="button"], [role="tab"], label') : null;
        if (el) this.push('click', { tg: selectorOf(el) });
      },
      true,
    );
    listen(window, 'hashchange', () => this.push('nav', { loc: safeLocation(window.location) }));
    listen(window, 'error', (e) => {
      const ee = e as ErrorEvent;
      this.push('error', {
        msg: redact(String(ee.message ?? '')),
        src: ee.filename ? redact(ee.filename.split('?')[0]?.split('/').pop() ?? '', 60) : null,
        line: ee.lineno ?? null,
      });
    });
    listen(window, 'unhandledrejection', (e) => {
      const reason = (e as PromiseRejectionEvent).reason;
      this.push('rejection', { msg: redact(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)) });
    });
    listen(document, 'visibilitychange', () => this.push('visibility', { v: document.visibilityState }));
    if (this.store) {
      const store = this.store;
      let last = '';
      const onConn = () => {
        const c = store.getState().conn;
        const key = `${c.status}/${c.offline}`;
        if (key === last) return;
        last = key;
        this.push('ws', { status: c.status, attempt: c.attempt, offline: c.offline, everSynced: c.everSynced });
      };
      onConn();
      this.offs.push(store.subscribe(onConn));
    }
  }

  private detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.events = [];
  }
}

export function diagStored(): boolean {
  return load<boolean>(DIAG_KEY, false) === true;
}
