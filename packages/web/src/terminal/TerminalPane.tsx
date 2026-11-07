import { encodeHistoryRow, type HistoryMark, type HistoryRow, HistoryStyles } from '@herdr-mobile/protocol';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useLight, useServices } from '../hooks/app';
import { load } from '../lib/storage';
import { type HistoryChange, HistoryModel, type HistoryRequest } from './history';
import { HistoryView } from './historyView';
import { isAutomaticReply, isCursorReport } from './input';
import { terminalColors, terminalTheme } from './palette';
import type { Screen } from './prompt';
import { InputError, type StreamHandle } from './streams';
import {
  autoFloor,
  type CellRatio,
  clampFont,
  estimatedCell,
  fontFor,
  HERDR_FONT,
  loadZoom,
  MONO,
  READABLE,
  type Room,
  saveZoom,
  stepFont,
  type Zoom,
} from './zoom';

export interface TerminalApi {
  /** The visible screen's lines. */
  lines(): string[];
  /** The bottom of the buffer (the screen plus `history` lines above it) with background marks, for reading a question. */
  screen(history?: number): Screen;
  /** Scrollback and screen as plain text, soft-wrapped lines joined (select / copy). */
  text(): string;
  /** Raw keyboard bytes, as if typed into the terminal. */
  type(data: string): boolean;
  /** Bring the cursor back into view and keep it there (after the person sends something). */
  follow(): void;
  /** Show the OS keyboard and type straight into the terminal. */
  focusKeyboard(): void;
  blur(): void;
  setZoom(z: Zoom): void;
  /** One size step bigger or smaller (leaves auto/fit for a picked size). */
  step(dir: 1 | -1): void;
}

export interface TerminalPaneProps {
  terminalId: string;
  /** Turns a typed key into ctrl+key when the quick bar's Ctrl is armed (returns the bytes to send). */
  transformInput?: (data: string) => string;
  /** Something new reached the screen (throttled by the caller as it likes). */
  onOutput?: () => void;
  onZoom?: (z: Zoom, font: number) => void;
  /** Desktop: clicking the terminal focuses it for typing. Touch: only via focusKeyboard(). */
  clickToType?: boolean;
  /** How a terminal without a picked size opens (Settings). */
  defaultZoom?: 'auto' | 'fit';
}

type Phase = 'loading' | 'live' | 'closed' | 'error';

const fontOf = (term: Terminal | null): number => (term?.options.fontSize as number | undefined) ?? HERDR_FONT;

/** (Re)loads the WebGL renderer (its own chunk: only DPR-1 screens use it); without it xterm's DOM renderer draws. */
async function loadWebgl(term: Terminal, ref: { current: WebglAddon | null }): Promise<void> {
  ref.current?.dispose();
  ref.current = null;
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const gl = new WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      if (ref.current === gl) ref.current = null;
    });
    term.loadAddon(gl);
    ref.current = gl;
  } catch {
    ref.current = null;
  }
}

/**
 * JetBrains Mono loaded (or 1.5 s gone by). Never rejects: a font that can't load (the bridge away at that
 * moment; WebKit rejects then) still opens the terminal in the fallback font, and the next one tries again.
 */
const fontsReady = (() => {
  let p: Promise<unknown> | null = null;
  return () => {
    p ??= Promise.race([
      Promise.all([document.fonts.load(`14px ${MONO}`), document.fonts.load(`bold 14px ${MONO}`)]).catch(() => {
        p = null;
      }),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    return p;
  };
})();

const floor1 = (f: number) => Math.floor(f * 10) / 10;

/** Rows this xterm keeps above its screen: room to copy rows that scroll off into the history, and for prompts. */
const LOCAL_SCROLLBACK = 1000;
/** Scrollback rows in a snapshot (the history above comes in pages; the question parser reads ~60). */
const SNAPSHOT_HISTORY = 200;
/** Load older rows once the top of what's loaded is this many screens above the view. */
const PREFETCH_SCREENS = 2;

const advances = new Map<number, number>();
/** The font's own advance per character at `font` px (history rows get letter-spacing up to xterm's cell width). */
function charAdvance(font: number): number {
  let a = advances.get(font);
  if (a === undefined) {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    ctx.font = `${font}px ${MONO}`;
    a = ctx.measureText('W'.repeat(20)).width / 20;
    advances.set(font, a);
  }
  return a;
}

/** xterm's CircularList (private, pinned @xterm/xterm 6): counts rows dropped off the top of the main buffer. */
type TrimList = { onTrim(listener: (n: number) => void): { dispose(): void } };
function normalLines(term: Terminal): TrimList | null {
  const l = (term as unknown as { _core?: { buffers?: { normal?: { lines?: TrimList } } } })._core?.buffers?.normal?.lines;
  return l && typeof l.onTrim === 'function' ? l : null;
}

/**
 * A live view of one of the desktop's terminals: xterm.js at the desktop's own grid (never resized from
 * here), scaled by font size only (zoom.ts: readable by default, panning sideways with the cursor on a
 * phone), with the stream and input from TerminalClient.
 */
export const TerminalPane = forwardRef<TerminalApi, TerminalPaneProps>(function TerminalPane(
  { terminalId, transformInput, onOutput, onZoom, clickToType = false, defaultZoom = 'auto' },
  ref,
) {
  const { terminals } = useServices();
  const light = useLight();
  const hostRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const glRef = useRef<WebglAddon | null>(null);
  const handleRef = useRef<StreamHandle | null>(null);
  const zoomRef = useRef<Zoom>(loadZoom(terminalId, defaultZoom));
  const cellRef = useRef<CellRatio>(estimatedCell());
  /** Keep the cursor in view (until the person pans away; typing or the pill brings it back). */
  const stickRef = useRef(true);
  /** The person's finger / wheel / mouse is on the terminal: scrolls now are theirs. */
  const userRef = useRef({ touching: false, at: 0, wheelAt: 0, mineAt: 0, lastScrollMine: false, lastScrollAt: 0 });
  /** Cursor reports the program asked for and xterm hasn't sent yet. */
  const cprRef = useRef(0);
  const histRef = useRef<{ model: HistoryModel; view: HistoryView } | null>(null);
  histRef.current ??= { model: new HistoryModel(), view: new HistoryView() };
  /** Rows the main buffer dropped off its top (the history numbering's offset). */
  const trimRef = useRef(0);
  /** Runs a history check on the next frame (scrolls, output, pages). */
  const histTickRef = useRef<() => void>(() => {});
  const [phase, setPhase] = useState<Phase>('loading');
  const [closedWhy, setClosedWhy] = useState('');
  const [following, setFollowing] = useState(true);
  const [overflows, setOverflows] = useState(false);
  const cb = useRef({ transformInput, onOutput, onZoom, defaultZoom });
  cb.current = { transformInput, onOutput, onZoom, defaultZoom };

  const setStick = useCallback((on: boolean) => {
    stickRef.current = on;
    setFollowing(on);
  }, []);

  /** Scrolls so the cursor (and what the program drew under it) is in view; sideways smoothly. */
  const followCursor = useCallback((smooth = true) => {
    const term = termRef.current;
    const host = hostRef.current;
    const mount = mountRef.current;
    const u = userRef.current;
    if (!term || !host || !mount || !stickRef.current || u.touching) return;
    const screen = mount.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;
    const cellH = screen.offsetHeight / term.rows;
    const cellW = screen.offsetWidth / term.cols;
    const b = term.buffer.active;
    // Measured, not summed offsets: the history sits above the grid inside the mount.
    const sr = screen.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const top = sr.top - hr.top - host.clientTop + host.scrollTop;
    const left = sr.left - hr.left - host.clientLeft + host.scrollLeft;
    // Down to the cursor and whatever the program drew under it (an agent's status lines), with a little room.
    let last = term.rows - 1;
    while (
      last > b.cursorY &&
      !b
        .getLine(b.viewportY + last)
        ?.translateToString(true)
        .trim()
    )
      last--;
    const rowBottom = top + (Math.max(b.cursorY + 1, last + 1) + 0.5) * cellH;
    const wantTop = Math.max(0, Math.min(host.scrollHeight - host.clientHeight, rowBottom - host.clientHeight));
    // Sideways: leave it while the cursor is comfortably in view; else the left edge when the cursor fits
    // there (prompts sit at the start of a line), else the cursor at about 70% of the width.
    const x = left + b.cursorX * cellW;
    const margin = cellW * 4;
    const w = host.clientWidth;
    let wantLeft = host.scrollLeft;
    if (x < host.scrollLeft + margin || x > host.scrollLeft + w - margin) wantLeft = x < w - cellW * 6 ? 0 : Math.max(0, x - w * 0.7);
    wantLeft = Math.min(Math.max(0, host.scrollWidth - w), wantLeft);
    u.lastScrollMine = true;
    u.mineAt = Date.now();
    if (Math.abs(host.scrollTop - wantTop) >= 1) host.scrollTop = wantTop;
    if (Math.abs(host.scrollLeft - wantLeft) >= 1) host.scrollTo({ left: wantLeft, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  /** The room the grid has: the host minus the mount's padding; no height while the phone keyboard is up. */
  const room = useCallback((): Room | null => {
    const host = hostRef.current;
    const mount = mountRef.current;
    const term = termRef.current;
    if (!host || !mount || !term) return null;
    const cs = getComputedStyle(mount);
    const padX = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight);
    const padY = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    const keyboardUp = document.documentElement.dataset.keyboard === 'up';
    return {
      width: host.clientWidth - padX - 1,
      height: keyboardUp ? 0 : host.clientHeight - padY - 1,
      cols: term.cols,
      rows: term.rows,
    };
  }, []);

  /** Learns the renderer's real cell size per px of font from the drawn grid. */
  const measureCell = useCallback(() => {
    const term = termRef.current;
    const screen = mountRef.current?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!term || !screen || screen.offsetWidth === 0) return;
    const f = fontOf(term);
    cellRef.current = { w: screen.offsetWidth / term.cols / f, h: screen.offsetHeight / term.rows / f };
  }, []);

  /** History rows take xterm's cell size, so they line up with the grid below. */
  const histMetrics = useCallback(() => {
    const term = termRef.current;
    const screen = mountRef.current?.querySelector('.xterm-screen') as HTMLElement | null;
    const h = histRef.current;
    if (!term || !screen || !h || screen.offsetWidth === 0) return;
    const font = fontOf(term);
    const cell = screen.offsetWidth / term.cols;
    const adv = charAdvance(font);
    h.view.setMetrics(font, screen.offsetHeight / term.rows, cell, term.cols, adv > 0 ? cell - adv : 0);
  }, []);

  const setFont = useCallback((font: number) => {
    const term = termRef.current;
    if (!term || Math.abs(fontOf(term) - font) < 0.01) return false;
    term.options.fontSize = font;
    // The WebGL renderer keeps glyphs of the old size after a font change: give it a fresh atlas.
    if (glRef.current) void loadWebgl(term, glRef);
    return true;
  }, []);

  /** Applies the zoom, keeping the point under `anchor` (host coordinates) in place. */
  const applyZoom = useCallback(
    (anchor?: { x: number; y: number }) => {
      const term = termRef.current;
      const host = hostRef.current;
      const r = room();
      if (!term || !host || !r) return;
      const z = zoomRef.current;
      const before = fontOf(term);
      const font = fontFor(z, r, cellRef.current, autoFloor());
      const ax = anchor ? (host.scrollLeft + anchor.x) / before : 0;
      const ay = anchor ? (host.scrollTop + anchor.y) / before : 0;
      setFont(font);
      requestAnimationFrame(() => {
        const t = termRef.current;
        if (!t) return;
        measureCell();
        // Measured, not guessed: a fitted grid that still overflows by a hair (cells snap to device pixels) shrinks once.
        if (zoomRef.current.mode !== 'font') {
          const screen = mountRef.current?.querySelector('.xterm-screen') as HTMLElement | null;
          const rr = room();
          if (screen && rr) {
            const f = fontOf(t);
            const auto = zoomRef.current.mode === 'auto';
            const floor = auto ? autoFloor() : 0;
            const rw = rr.width / screen.offsetWidth;
            const rh = rr.height > 0 ? rr.height / screen.offsetHeight : 1;
            // Fit: always the whole grid. Auto: the whole grid only where that stays readable (a desktop window).
            const overW = rw < 0.999 && f > floor;
            const overH = rh < 0.999 && (!auto || f * rh >= floor);
            if (overW || overH) {
              const ratio = Math.min(overW ? rw : 1, overH ? rh : 1);
              setFont(clampFont(Math.max(floor, floor1(f * ratio))));
            }
          }
        }
        histMetrics();
        cb.current.onZoom?.(zoomRef.current, fontOf(t));
        setOverflows(host.scrollWidth > host.clientWidth + 1 || host.scrollHeight > host.clientHeight + 1);
        if (anchor) {
          const f = fontOf(t);
          host.scrollLeft = ax * f - anchor.x;
          host.scrollTop = ay * f - anchor.y;
        } else followCursor(false);
      });
    },
    [room, setFont, measureCell, followCursor, histMetrics],
  );

  const setZoom = useCallback(
    (z: Zoom, anchor?: { x: number; y: number }) => {
      zoomRef.current = z;
      saveZoom(terminalId, z, cb.current.defaultZoom);
      // Zooming out to the whole grid shows the cursor anyway; zooming in on a spot is the person looking there.
      if (!anchor) setStick(true);
      applyZoom(anchor);
    },
    [terminalId, applyZoom, setStick],
  );

  useImperativeHandle(
    ref,
    () => ({
      lines() {
        const t = termRef.current;
        if (!t) return [];
        const b = t.buffer.active;
        const out: string[] = [];
        for (let y = b.viewportY; y < b.viewportY + t.rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
        return out;
      },
      screen(history = 0) {
        const t = termRef.current;
        if (!t) return { lines: [] };
        const b = t.buffer.active;
        const lines: string[] = [];
        const marks: (string | undefined)[] = [];
        const cell = b.getNullCell();
        for (let y = Math.max(0, b.baseY - history); y < b.baseY + t.rows; y++) {
          const line = b.getLine(y);
          const text = line?.translateToString(true) ?? '';
          lines.push(text);
          // Only a tab bar needs them (the current tab is drawn on a colored background).
          if (!line || !/[☐☒]/u.test(text)) {
            marks.push(undefined);
            continue;
          }
          let m = '';
          for (let x = 0; x < line.length && m.length < text.length; x++) {
            const c = line.getCell(x, cell);
            if (!c || c.getWidth() === 0) continue;
            const chars = c.getChars() || ' ';
            m += (c.isBgDefault() && !c.isInverse() ? ' ' : '#').repeat(chars.length);
          }
          marks.push(m);
        }
        return { lines, marks, cols: t.cols };
      },
      text() {
        const t = termRef.current;
        if (!t) return '';
        const b = t.buffer.active;
        const h = histRef.current?.model;
        // The history above, then what this xterm has after it (the main buffer's own copy of those rows skipped).
        const local = b.type === 'normal' && h?.enabled ? h.local(b.baseY, trimRef.current) : null;
        const out: string[] = local ? (h?.text() ?? []) : [];
        const from = local ? Math.max(0, (h?.end ?? 0) - local.lo) : 0;
        for (let y = from; y < b.length; y++) {
          const line = b.getLine(y);
          if (!line) continue;
          const s = line.translateToString(true);
          if (line.isWrapped && out.length > 0) out[out.length - 1] += s;
          else out.push(s);
        }
        return out.join('\n').replace(/\s+$/, '');
      },
      type(data: string) {
        setStick(true);
        return handleRef.current?.type(data) ?? false;
      },
      follow() {
        setStick(true);
        followCursor();
      },
      focusKeyboard() {
        const ta = termRef.current?.textarea;
        if (!ta) return;
        ta.setAttribute('inputmode', 'text');
        termRef.current?.focus();
      },
      blur() {
        termRef.current?.blur();
        termRef.current?.textarea?.setAttribute('inputmode', clickToType ? 'text' : 'none');
      },
      setZoom(z: Zoom) {
        setZoom(z);
      },
      step(dir: 1 | -1) {
        setZoom({ mode: 'font', font: stepFont(fontOf(termRef.current), dir) });
      },
    }),
    [setZoom, clickToType, followCursor, setStick],
  );

  // The terminal and its stream live as long as this terminal is shown.
  useEffect(() => {
    let disposed = false;
    zoomRef.current = loadZoom(terminalId, cb.current.defaultZoom);
    setPhase('loading');
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: MONO,
      fontSize: zoomRef.current.mode === 'font' ? zoomRef.current.font : READABLE,
      lineHeight: 1,
      scrollback: LOCAL_SCROLLBACK,
      cursorBlink: false,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      theme: terminalTheme(document.documentElement.dataset.theme === 'light'),
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
    });
    termRef.current = term;
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));

    // The program asking where the cursor is (DSR 6 / DECXCPR): xterm's answer is automatic; a key with
    // the same bytes (Shift+F3) at any other time is the person's.
    const cpr = (params: (number | number[])[]) => {
      if (params[0] === 6) cprRef.current++;
      return false;
    };
    const dsr = term.parser.registerCsiHandler({ final: 'n' }, cpr);
    const decxcpr = term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, cpr);

    const inputSub = term.onData((data) => {
      const h = handleRef.current;
      if (!h) return;
      const pending = cprRef.current > 0;
      if (pending && isCursorReport(data)) cprRef.current--;
      if (isAutomaticReply(data, pending)) {
        h.type(data, true);
        return;
      }
      setStick(true);
      h.type(cb.current.transformInput ? cb.current.transformInput(data) : data);
    });
    const binSub = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      handleRef.current?.type(bytes);
    });

    // ---- history above the grid (terminal/history.ts) ----
    const { model, view } = histRef.current as { model: HistoryModel; view: HistoryView };
    view.setColors(terminalColors(document.documentElement.dataset.theme === 'light'));
    let trimList: TrimList | null = null;
    let trimSub: { dispose(): void } | null = null;
    const hookTrim = () => {
      const l = normalLines(term);
      if (l === trimList) return;
      trimSub?.dispose();
      trimList = l;
      trimSub =
        l?.onTrim((n) => {
          trimRef.current += n;
        }) ?? null;
    };
    hookTrim();
    /** The next data frame is a snapshot placed by this mark (null: an older bridge, no history). */
    let pendingMark: HistoryMark | null | undefined;
    let histFrame = 0;
    let restartedAt = 0;
    const xtermEl = () => mountRef.current?.querySelector('.xterm') as HTMLElement | null;
    /** Changes to the history without moving what the person is reading (following the cursor re-scrolls anyway). */
    const keepView = (fn: () => void) => {
      const host = hostRef.current;
      if (!host || stickRef.current) {
        fn();
        return;
      }
      const top = host.getBoundingClientRect().top;
      const x = xtermEl();
      const anchor = view.anchorAt(top) ?? x;
      const before = anchor?.getBoundingClientRect().top ?? 0;
      const xBefore = x?.getBoundingClientRect().top ?? 0;
      fn();
      let delta = 0;
      if (anchor?.isConnected) delta = anchor.getBoundingClientRect().top - before;
      else if (x) delta = x.getBoundingClientRect().top - xBefore;
      if (Math.abs(delta) >= 0.5) {
        userRef.current.lastScrollMine = true;
        userRef.current.mineAt = Date.now();
        host.scrollTop += delta;
      }
    };
    const chrome = () => {
      const alt = term.buffer.active.type === 'alternate';
      view.setEnabled(model.enabled || alt);
      view.setAlt(alt);
      view.setReserved(model.olderAvailable);
      // Nothing above the screen: no "start of history" line either (the grid stays at the top).
      const empty = model.rows === 0 && model.olderAvailable === 0;
      view.setStatus(model.loadingOlder, empty ? null : model.topEdge, model.olderAvailable > 0);
    };
    const show = (changes: HistoryChange[]) =>
      keepView(() => {
        if (changes.length) view.apply(changes);
        chrome();
      });
    /** The numbering moved on (the width changed): a fresh snapshot brings a new mark. */
    const restart = () => {
      const h = handleRef.current;
      if (!h || Date.now() - restartedAt < 3000) return;
      restartedAt = Date.now();
      terminals.resync(h);
    };
    const request = (req: HistoryRequest) => {
      const h = handleRef.current;
      if (!h) {
        model.failed(req.dir);
        return;
      }
      h.history(req.cursor, req.dir, req.limit)
        .then((page) => {
          // Placed after the bytes that came before it.
          term.write('', () => {
            if (disposed) return;
            const b = term.buffer.normal;
            show(model.page(req.dir, page, model.local(b.baseY, trimRef.current)));
            tick();
          });
        })
        .catch((err: unknown) => {
          model.failed(req.dir);
          if (disposed) return;
          if (err instanceof InputError && err.code === 'stale') restart();
          show([]);
        });
    };
    const syncHistory = () => {
      if (!model.enabled) {
        show([]);
        return;
      }
      const b = term.buffer.normal;
      const r = model.sync(b.baseY, trimRef.current);
      const changes = r.changes;
      const local = model.local(b.baseY, trimRef.current);
      if (r.copy && local) {
        const [from, to] = r.copy;
        const styles = new HistoryStyles();
        const cell = b.getNullCell();
        const rows: HistoryRow[] = [];
        for (let a = from; a < to; a++) {
          const line = b.getLine(a - local.lo);
          rows.push(line ? encodeHistoryRow(line, styles, cell) : { t: '' });
        }
        changes.push(...model.appendLocal(from, rows, styles.list));
      }
      show(changes);
      if (r.request) request(r.request);
    };
    const loadOlder = () => {
      const host = hostRef.current;
      // Only once the person scrolled away from the cursor: opening a terminal loads nothing old.
      if (!host || stickRef.current || !model.enabled || model.loadingOlder || model.olderAvailable <= 0) return;
      const hr = host.getBoundingClientRect();
      if (view.statusElement.getBoundingClientRect().bottom < hr.top - PREFETCH_SCREENS * hr.height) return;
      const req = model.olderRequest();
      if (!req) return;
      show([]);
      request(req);
    };
    const tick = () => {
      if (histFrame) return;
      histFrame = requestAnimationFrame(() => {
        histFrame = 0;
        if (disposed) return;
        syncHistory();
        loadOlder();
      });
    };
    histTickRef.current = tick;
    const placeSnapshot = (mark: HistoryMark | null) => {
      if (!mark || !trimList) {
        show(model.disable());
        return;
      }
      show(model.attach(mark, term.buffer.normal.baseY, trimRef.current));
      tick();
    };
    const startOver = (mark: HistoryMark | undefined) => {
      term.reset();
      hookTrim();
      model.detach();
      pendingMark = mark ?? null;
    };
    // A full-screen app keeps its history to itself: on request, herdr-core reads it by scrolling the app.
    let appReading = false;
    view.onReadApp = () => {
      const h = handleRef.current;
      if (!h || appReading) return;
      appReading = true;
      keepView(() => view.setAppState('reading'));
      h.appHistory()
        .then((r) => {
          if (disposed) return;
          keepView(() => {
            if (r.why) view.setAppState('failed', `It’s ${r.why} right now: try again once it’s idle.`);
            else {
              const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              view.setAppRows(r.lines);
              view.setAppState('read', `${r.lines.length} lines${r.complete ? ', from the start' : ''}, as of ${at}`);
            }
          });
        })
        .catch((err: unknown) => {
          if (!disposed) keepView(() => view.setAppState('failed', `Couldn’t read it: ${(err as Error).message}`));
        })
        .finally(() => {
          appReading = false;
        });
    };
    // This xterm's own scrollback is only a buffer for the history: its view stays on the screen.
    const scrollSub = term.onScroll(() => {
      const b = term.buffer.active;
      if (b.viewportY < b.baseY) term.scrollToBottom();
    });

    const resizeGrid = (cols: number, rows: number) => {
      if (cols > 0 && rows > 0 && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
      applyZoom();
    };

    let outputQueued = false;
    const output = () => {
      if (outputQueued) return;
      outputQueued = true;
      setTimeout(() => {
        outputQueued = false;
        if (!disposed) cb.current.onOutput?.();
      }, 150);
    };

    void fontsReady().then(() => {
      if (disposed || !mountRef.current) return;
      term.open(mountRef.current);
      const ta = term.textarea;
      if (ta) {
        // Touch: no keyboard popping up on every tap; the keyboard button asks for it.
        ta.setAttribute('inputmode', clickToType ? 'text' : 'none');
        ta.setAttribute('aria-label', 'Terminal input');
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('enterkeyhint', 'send');
      }
      measureCell();
      // WebGL draws glyphs 2-3x too big at device pixel ratios above 1 once the font size changes (seen with
      // xterm 6 + addon-webgl 0.19 in Chromium): the DOM renderer is exact there. `hm.renderer` = "webgl" /
      // "dom" in localStorage overrides.
      const renderer = load<string | null>('renderer', null) ?? (window.devicePixelRatio === 1 ? 'webgl' : 'dom');
      // The WebGL renderer measures cells its own way: fit again once it draws.
      if (renderer === 'webgl') void loadWebgl(term, glRef).then(() => applyZoom());
      mountRef.current.prepend(view.el);
      handleRef.current = terminals.open(
        terminalId,
        {
          onOpen(cols, rows, mark) {
            startOver(mark);
            cprRef.current = 0;
            resizeGrid(cols, rows);
            setPhase('live');
            setStick(true);
          },
          onData(data) {
            const mark = pendingMark;
            pendingMark = undefined;
            term.write(data, () => {
              if (mark !== undefined) placeSnapshot(mark);
              else tick();
              if (stickRef.current) requestAnimationFrame(() => followCursor());
            });
            output();
          },
          onReset(cols, rows, mark) {
            startOver(mark);
            cprRef.current = 0;
            resizeGrid(cols, rows);
          },
          onResize(cols, rows) {
            // A new width re-wraps the bridge's rows (a new numbering): start the history over.
            const rewrap = cols !== term.cols && model.enabled;
            resizeGrid(cols, rows);
            hookTrim();
            if (rewrap) {
              show(model.disable());
              restart();
            }
          },
          onClosed(reason) {
            setClosedWhy(reason);
            setPhase(reason === 'not_found' ? 'error' : 'closed');
          },
        },
        SNAPSHOT_HISTORY,
      );
      applyZoom();
    });

    return () => {
      disposed = true;
      if (histFrame) cancelAnimationFrame(histFrame);
      histTickRef.current = () => {};
      trimSub?.dispose();
      scrollSub.dispose();
      view.el.remove();
      view.onReadApp = null;
      show(model.disable());
      dsr.dispose();
      decxcpr.dispose();
      inputSub.dispose();
      binSub.dispose();
      handleRef.current?.close();
      handleRef.current = null;
      term.dispose();
      termRef.current = null;
      glRef.current = null;
    };
  }, [terminalId, terminals, applyZoom, clickToType, followCursor, measureCell, setStick]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(light);
    histRef.current?.view.setColors(terminalColors(light));
  }, [light]);

  // Auto and fit follow the space they have (rotation, keyboard, window size).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let w = host.clientWidth;
    let h = host.clientHeight;
    const ro = new ResizeObserver(() => {
      if (host.clientWidth === w && host.clientHeight === h) return;
      w = host.clientWidth;
      h = host.clientHeight;
      applyZoom();
    });
    ro.observe(host);
    // Scrolls while the person touches, wheels or drags (and their momentum after) are theirs: stop following.
    const u = userRef.current;
    const mine = () => {
      u.at = Date.now();
    };
    const wheel = () => {
      u.at = u.wheelAt = Date.now();
    };
    const onTouchStart = () => {
      u.touching = true;
      wheel();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) u.touching = false;
      wheel();
    };
    const onScroll = () => {
      const now = Date.now();
      // Ours (following the cursor, smooth sideways for a few hundred ms) unless a finger is down.
      const mine = !u.touching && now - u.mineAt < 700;
      // A finger, wheel or drag just now makes it theirs even while ours was still settling (output streaming in).
      const person =
        u.touching || now - u.wheelAt < 400 || (!mine && (now - u.at < 400 || (!u.lastScrollMine && now - u.lastScrollAt < 120)));
      u.lastScrollAt = now;
      if (person) {
        u.lastScrollMine = false;
        if (stickRef.current) setStick(false);
      }
      histTickRef.current();
    };
    // A wheel over the grid scrolls the pane (history included), not xterm's own scrollback; full-screen apps
    // and programs that read the mouse still get it from xterm, as before.
    const mount = mountRef.current;
    const onWheelCapture = (e: WheelEvent) => {
      const t = termRef.current;
      if (!t || e.ctrlKey) return;
      if (t.buffer.active.type === 'normal' && t.modes.mouseTrackingMode === 'none') {
        e.stopPropagation();
        wheel();
      }
    };
    mount?.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchend', onTouchEnd, { passive: true });
    host.addEventListener('touchcancel', onTouchEnd, { passive: true });
    host.addEventListener('wheel', wheel, { passive: true });
    host.addEventListener('pointerdown', mine, { passive: true });
    host.addEventListener('keydown', mine);
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('touchcancel', onTouchEnd);
      host.removeEventListener('wheel', wheel);
      host.removeEventListener('pointerdown', mine);
      host.removeEventListener('keydown', mine);
      host.removeEventListener('scroll', onScroll);
      mount?.removeEventListener('wheel', onWheelCapture, { capture: true });
    };
  }, [applyZoom, setStick]);

  // Pinch to zoom (live as a transform, committed to the font on release), ctrl+wheel / trackpad pinch on desktop,
  // double tap between readable and the whole grid.
  useEffect(() => {
    const host = hostRef.current;
    const mount = mountRef.current;
    if (!host || !mount) return;
    let pinch: { d0: number; f0: number; x: number; y: number; scale: number } | null = null;
    let lastTap = { at: 0, x: 0, y: 0 };
    /** The touch now down, while it may still be a tap (a scroll or a fling stop never is). */
    let down: { at: number; x: number; y: number; moved: boolean } | null = null;
    const dist = (t: TouchList) => Math.hypot((t[0]?.clientX ?? 0) - (t[1]?.clientX ?? 0), (t[0]?.clientY ?? 0) - (t[1]?.clientY ?? 0));
    const mid = (t: TouchList) => {
      const r = host.getBoundingClientRect();
      return {
        x: ((t[0]?.clientX ?? 0) + (t[1]?.clientX ?? 0)) / 2 - r.left,
        y: ((t[0]?.clientY ?? 0) + (t[1]?.clientY ?? 0)) / 2 - r.top,
      };
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const m = mid(e.touches);
        pinch = { d0: dist(e.touches), f0: fontOf(termRef.current), x: m.x, y: m.y, scale: 1 };
        mount.style.transformOrigin = `${host.scrollLeft + m.x}px ${host.scrollTop + m.y}px`;
      } else if (e.touches.length === 1) {
        const now = Date.now();
        const t = e.touches[0];
        const r = host.getBoundingClientRect();
        const x = (t?.clientX ?? 0) - r.left;
        const y = (t?.clientY ?? 0) - r.top;
        down = null;
        if (now - lastTap.at < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
          // Double tap: the whole grid, or back to readable text where you tapped.
          if (zoomRef.current.mode === 'fit') setZoom({ mode: 'auto' }, { x, y });
          else setZoom({ mode: 'fit' });
          lastTap = { at: 0, x: 0, y: 0 };
          e.preventDefault();
        } else {
          // A touch that stops a fling isn't a tap.
          down = { at: now, x, y, moved: now - userRef.current.lastScrollAt < 120 };
          lastTap = { at: 0, x: 0, y: 0 };
        }
      }
    };
    const onMove = (e: TouchEvent) => {
      if (down && e.touches.length === 1) {
        const t = e.touches[0];
        const r = host.getBoundingClientRect();
        if (Math.hypot((t?.clientX ?? 0) - r.left - down.x, (t?.clientY ?? 0) - r.top - down.y) > 10) down.moved = true;
      }
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const f = clampFont((pinch.f0 * dist(e.touches)) / pinch.d0);
      pinch.scale = f / pinch.f0;
      mount.style.transform = `scale(${pinch.scale})`;
    };
    const onEnd = (e: TouchEvent) => {
      if (down && e.touches.length === 0) {
        // Only a short, still touch counts toward a double tap (two quick flicks in a row never zoom).
        if (!down.moved && Date.now() - down.at < 300) lastTap = { at: Date.now(), x: down.x, y: down.y };
        down = null;
      }
      if (!pinch || e.touches.length >= 2) return;
      const p = pinch;
      pinch = null;
      mount.style.transform = '';
      if (Math.abs(p.scale - 1) > 0.02) setZoom({ mode: 'font', font: clampFont(p.f0 * p.scale) }, { x: p.x, y: p.y });
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      setZoom(
        { mode: 'font', font: clampFont(fontOf(termRef.current) * Math.exp(-e.deltaY / 200)) },
        { x: e.clientX - r.left, y: e.clientY - r.top },
      );
    };
    host.addEventListener('touchstart', onStart, { passive: false });
    host.addEventListener('touchmove', onMove, { passive: false });
    host.addEventListener('touchend', onEnd);
    host.addEventListener('touchcancel', onEnd);
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      host.removeEventListener('touchstart', onStart);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd);
      host.removeEventListener('touchcancel', onEnd);
      host.removeEventListener('wheel', onWheel);
    };
  }, [setZoom]);

  return (
    <div className="term-wrap" data-phase={phase}>
      <div className="term-host" ref={hostRef}>
        <div className="term-mount" ref={mountRef} />
      </div>
      {phase === 'live' && !following && overflows && (
        <button
          type="button"
          className="follow-pill"
          onClick={() => {
            setStick(true);
            followCursor();
          }}
        >
          <Icon name="locate" size={14} />
          Cursor
        </button>
      )}
      {phase === 'loading' && (
        <div className="term-overlay">
          <span className="term-overlay-text">
            <Icon name="spinner" size={13} spin />
            Connecting to the terminal…
          </span>
        </div>
      )}
      {(phase === 'closed' || phase === 'error') && (
        <div className="term-overlay">
          <span className="term-overlay-text">
            {phase === 'error'
              ? 'This terminal is gone.'
              : `The terminal closed${closedWhy && closedWhy !== 'closed' ? ` (${closedWhy})` : ''}.`}
          </span>
        </div>
      )}
    </div>
  );
});
