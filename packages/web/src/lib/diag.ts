import { BUILD } from './build';
import { load, save } from './storage';
import type { AppStore } from './store';
import { isEditable } from './viewport';

/**
 * On-device diagnostics (Settings > About > Diagnostics, or `#diag` in the address): a ring buffer of what the
 * page saw around touches and focus — which element each touch landed on and what was really under the
 * finger (elementFromPoint, its pointer-events and z-index), where focus went, the visual viewport, the
 * connection, errors — sent to the bridge (`POST /api/diag`, kept in ~/.local/state/herdr-mobile/diag.jsonl)
 * so a problem only the real phone shows can be read on the computer.
 *
 * Never recorded: what's typed or shown (no values, no text content, no placeholders), cookies, tokens, the
 * address's query. Selectors use tag, id, classes and the aria-label of text fields only; long token-like
 * runs in any string are redacted.
 */

export const DIAG_KEY = 'diag';
export const MAX_EVENTS = 300;
/** The bridge takes 48 KiB; stay under it. */
export const MAX_REPORT_BYTES = 44 * 1024;
const AUTO_SEND_MS = 20_000;

export type DiagEvent = { k: string; t: number } & Record<string, unknown>;

export interface DiagReport {
  info: Record<string, unknown>;
  events: DiagEvent[];
}

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
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const label = el.getAttribute('aria-label');
    if (label) s += `[${redact(label, 30)}]`;
    if (el instanceof HTMLInputElement) s += `[type=${el.type}]`;
  }
  return redact(s, 120);
}

/** `div.agent-input-row>form.composer>textarea.composer-input[Message]`: the element and two ancestors. */
export function selectorOf(target: EventTarget | null | undefined): string | null {
  if (!target) return null;
  if (target === window) return 'window';
  if (target === document) return 'document';
  if (!(target instanceof Element)) return null;
  const parts: string[] = [];
  for (let el: Element | null = target; el && parts.length < 3; el = el.parentElement) {
    parts.unshift(one(el));
    if (el === document.documentElement) break;
  }
  return parts.join('>');
}

/** What a text field allows (never its value). */
export function fieldState(el: Element | null): Record<string, unknown> | undefined {
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return undefined;
  return {
    dis: el.disabled,
    ro: el.readOnly,
    im: el.getAttribute('inputmode'),
    ekh: el.getAttribute('enterkeyhint'),
    editable: isEditable(el),
  };
}

/** What's really under the finger at (x, y), and whether it's the event's target. */
export function hitAt(x: number, y: number, target: EventTarget | null): Record<string, unknown> | undefined {
  if (typeof document.elementFromPoint !== 'function') return undefined;
  const hit = document.elementFromPoint(x, y);
  if (!hit) return { s: null };
  const cs = getComputedStyle(hit);
  return {
    s: selectorOf(hit),
    pe: cs.pointerEvents,
    z: cs.zIndex,
    pos: cs.position,
    same: target instanceof Node ? hit === target || target.contains(hit) || hit.contains(target) : null,
  };
}

const r = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);

function viewport(): Record<string, unknown> {
  const vv = window.visualViewport;
  return {
    vv: vv ? [r(vv.width), r(vv.height), r(vv.offsetTop), r(vv.pageTop)] : null,
    inner: [r(window.innerWidth), r(window.innerHeight)],
    sy: r(window.scrollY),
    kb: document.documentElement.dataset.keyboard ?? null,
  };
}

function displayModes(): Record<string, boolean> {
  const m = (q: string) => window.matchMedia?.(`(display-mode: ${q})`).matches === true;
  return { standalone: m('standalone'), fullscreen: m('fullscreen'), minimalUi: m('minimal-ui'), browser: m('browser') };
}

/** The safe-area insets as the page sees them (env() read through a probe). */
function safeAreas(): number[] | null {
  try {
    const p = document.createElement('div');
    p.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(p);
    const cs = getComputedStyle(p);
    const out = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => r(Number.parseFloat(v)) ?? 0);
    p.remove();
    return out;
  } catch {
    return null;
  }
}

export function isStandalone(): boolean {
  return displayModes().standalone || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** The device and page facts that go with every report. */
export function deviceInfo(store: AppStore | null): Record<string, unknown> {
  const st = store?.getState();
  return {
    build: BUILD,
    serverBuild: st?.serverBuild ?? null,
    ua: redact(navigator.userAgent, 200),
    displayMode: displayModes(),
    navStandalone: (navigator as Navigator & { standalone?: boolean }).standalone ?? null,
    screen: [r(screen.width), r(screen.height)],
    dpr: window.devicePixelRatio,
    touchPoints: navigator.maxTouchPoints,
    safe: safeAreas(),
    ...viewport(),
    loc: safeLocation(window.location),
    visible: document.visibilityState,
    ws: st ? { status: st.conn.status, everSynced: st.conn.everSynced, attempt: st.conn.attempt, offline: st.conn.offline } : null,
    ae: selectorOf(document.activeElement),
    nav: document.documentElement.dataset.nav ?? null,
    secure: window.isSecureContext,
  };
}

const TOUCH_KINDS = ['touchstart', 'touchend', 'touchcancel'] as const;
const POINTER_KINDS = ['pointerdown', 'pointerup', 'mousedown', 'click'] as const;
const FOCUS_KINDS = ['focusin', 'focusout'] as const;

type Sender = (body: string) => Promise<number>;

const defaultSender: Sender = async (body) => {
  const r = await fetch('/api/diag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
    credentials: 'same-origin',
    keepalive: body.length < 60_000,
  });
  await r.text().catch(() => '');
  return r.status;
};

export type SendResult = 'sent' | 'nothing' | 'limited' | 'signed-out' | 'failed';

/**
 * The recorder. Off by default; on, it listens (capture phase, passive, never preventing anything) and keeps
 * the last MAX_EVENTS events; reports go out every 20 s while there's something new, when the page is hidden,
 * and on "Send now".
 */
export class DiagRecorder {
  private events: DiagEvent[] = [];
  private on = false;
  private readonly t0 = performance.now();
  private unsent = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();
  private lastVv = 0;
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

  private changed(): void {
    for (const l of this.listeners) l();
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
    this.unsent++;
  }

  /** What would be sent now: device facts plus the newest events that fit MAX_REPORT_BYTES. */
  report(reason: string): string {
    const info = { ...deviceInfo(this.store), reason, events: undefined };
    let events = this.events.slice();
    let body = JSON.stringify({ info, events } satisfies DiagReport);
    while (body.length > MAX_REPORT_BYTES && events.length > 0) {
      events = events.slice(Math.ceil(events.length / 4));
      body = JSON.stringify({ info, events } satisfies DiagReport);
    }
    return body;
  }

  async flush(reason = 'manual'): Promise<SendResult> {
    let result: SendResult;
    if (this.unsent === 0 && reason === 'auto') result = 'nothing';
    else {
      try {
        const status = await this.send(this.report(reason));
        result = status === 200 ? 'sent' : status === 429 ? 'limited' : status === 401 ? 'signed-out' : 'failed';
        if (result === 'sent') this.unsent = 0;
      } catch {
        result = 'failed';
      }
    }
    if (result !== 'nothing') {
      this.lastSend = { at: Date.now(), result };
      this.changed();
    }
    return result;
  }

  private attach(): void {
    const capture = { capture: true, passive: true } as const;
    const listen = (t: EventTarget, type: string, fn: (e: Event) => void, o: AddEventListenerOptions = capture) => {
      t.addEventListener(type, fn, o);
      this.offs.push(() => t.removeEventListener(type, fn, o));
    };
    for (const type of TOUCH_KINDS) {
      listen(document, type, (e) => {
        const te = e as TouchEvent;
        const touch = te.changedTouches[0];
        const x = touch?.clientX ?? 0;
        const y = touch?.clientY ?? 0;
        this.push(type, {
          tg: selectorOf(e.target),
          x: r(x),
          y: r(y),
          n: te.touches.length,
          hit: type === 'touchcancel' ? undefined : hitAt(x, y, e.target),
          f: fieldState(e.target as Element),
          ae: selectorOf(document.activeElement),
          ...(type === 'touchend' ? viewport() : {}),
        });
      });
    }
    for (const type of POINTER_KINDS) {
      listen(document, type, (e) => {
        const me = e as MouseEvent & { pointerType?: string };
        this.push(type, {
          tg: selectorOf(e.target),
          x: r(me.clientX),
          y: r(me.clientY),
          pt: me.pointerType,
          hit: type === 'pointerup' ? undefined : hitAt(me.clientX, me.clientY, e.target),
          ae: selectorOf(document.activeElement),
        });
      });
    }
    // After every handler ran: did something cancel the touch/click (that can stop focus and the keyboard)?
    for (const type of ['touchend', 'mousedown', 'click', 'pointerdown']) {
      listen(
        window,
        type,
        (e) => {
          if (e.defaultPrevented) this.push('prevented', { ev: type, tg: selectorOf(e.target) });
        },
        { passive: true },
      );
    }
    for (const type of FOCUS_KINDS) {
      listen(document, type, (e) => {
        const fe = e as FocusEvent;
        this.push(type, {
          tg: selectorOf(e.target),
          rel: selectorOf(fe.relatedTarget),
          f: fieldState(e.target as Element),
          ae: selectorOf(document.activeElement),
          nav: document.documentElement.dataset.nav ?? null,
        });
      });
    }
    listen(window, 'blur', () => this.push('winblur', { ae: selectorOf(document.activeElement) }));
    listen(window, 'focus', () => this.push('winfocus', { ae: selectorOf(document.activeElement) }));
    const vv = window.visualViewport;
    if (vv) {
      const onVv = (e: Event) => {
        const now = performance.now();
        if (now - this.lastVv < 200) return;
        this.lastVv = now;
        this.push(`vv-${e.type}`, viewport());
      };
      listen(vv, 'resize', onVv, { passive: true });
      listen(vv, 'scroll', onVv, { passive: true });
    }
    listen(
      window,
      'error',
      (e) => {
        const ee = e as ErrorEvent;
        this.push('error', {
          msg: redact(String(ee.message ?? '')),
          src: ee.filename ? redact(ee.filename.split('?')[0]?.split('/').pop() ?? '', 60) : null,
          line: ee.lineno ?? null,
        });
      },
      { passive: true },
    );
    listen(
      window,
      'unhandledrejection',
      (e) => {
        const reason = (e as PromiseRejectionEvent).reason;
        this.push('rejection', { msg: redact(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)) });
      },
      { passive: true },
    );
    listen(document, 'visibilitychange', () => {
      this.push('visibility', { v: document.visibilityState });
      if (document.visibilityState === 'hidden') void this.flush('hidden');
    });
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
    this.push('start', deviceInfo(this.store));
    this.timer = setInterval(() => void this.flush('auto'), AUTO_SEND_MS);
  }

  private detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.events = [];
    this.unsent = 0;
  }
}

/**
 * `#diag` in the address turns diagnostics on (`#diag-off`: off) and leaves the address; returns the choice
 * (null: the address didn't say). Otherwise the stored setting stands.
 */
export function diagFromUrl(loc: Location = window.location, hist: History = window.history): boolean | null {
  const m = /^#diag(-off)?(?:&(.*))?$/.exec(loc.hash);
  if (!m) return null;
  hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}${m[2] ? `#${m[2]}` : ''}`);
  return m[1] === undefined;
}

export function diagStored(): boolean {
  return load<boolean>(DIAG_KEY, false) === true;
}
