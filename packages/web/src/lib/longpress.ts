import { TapTracker } from './tap';

/** How long a finger (or the mouse) stays down for a long press. */
export const LONG_PRESS_MS = 500;
/** Rows that take a long press carry `data-press="<terminal id>"`. */
const SELECTOR = '[data-press]';

/**
 * Long press (or right-click) on a row marked `data-press`: calls `onPress(id, x, y)`. A press that
 * moves past the tap slop, a scroll under it, or a touch that stops a fling (the tap guard's TapTracker,
 * lib/tap.ts) is not one. The click that ends a long press is dropped, so the row doesn't also open.
 */
export function watchLongPress(root: Document | HTMLElement, onPress: (id: string, x: number, y: number) => void): () => void {
  const tracker = new TapTracker();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const rowOf = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>(SELECTOR) : null);
  const down = (e: PointerEvent) => {
    fired = false;
    stop();
    const row = rowOf(e);
    if (!row || !e.isPrimary || e.button !== 0) return;
    tracker.down(e.pointerId, e.clientX, e.clientY, 0, performance.now());
    if (!tracker.pending) return;
    const { clientX: x, clientY: y } = e;
    timer = setTimeout(() => {
      timer = null;
      if (!tracker.pending || !row.isConnected) return;
      tracker.cancel();
      fired = true;
      onPress(row.dataset.press ?? '', x, y);
    }, LONG_PRESS_MS);
  };
  const move = (e: PointerEvent) => {
    if (timer && !tracker.move(e.pointerId, e.clientX, e.clientY)) stop();
  };
  const end = () => {
    stop();
    tracker.cancel();
  };
  // The page or a list of rows scrolling (not some other pane, like a terminal) ends a press.
  const scroll = (e: Event) => {
    const target = e.target;
    if (target !== document && !(target instanceof Element && target.querySelector(SELECTOR))) return;
    stop();
    tracker.scrolled(performance.now());
  };
  // Desktop right-click, and Android's own long-press menu: ours instead (once per press).
  const menu = (e: MouseEvent) => {
    const row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    if (fired) return;
    end();
    fired = true;
    onPress(row.dataset.press ?? '', e.clientX, e.clientY);
  };
  const click = (e: MouseEvent) => {
    if (!fired || !rowOf(e)) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  };
  root.addEventListener('pointerdown', down as EventListener, true);
  root.addEventListener('pointermove', move as EventListener, true);
  root.addEventListener('pointerup', end, true);
  root.addEventListener('pointercancel', end, true);
  root.addEventListener('contextmenu', menu as EventListener, true);
  root.addEventListener('click', click as EventListener, true);
  document.addEventListener('scroll', scroll, { capture: true, passive: true });
  return () => {
    stop();
    root.removeEventListener('pointerdown', down as EventListener, true);
    root.removeEventListener('pointermove', move as EventListener, true);
    root.removeEventListener('pointerup', end, true);
    root.removeEventListener('pointercancel', end, true);
    root.removeEventListener('contextmenu', menu as EventListener, true);
    root.removeEventListener('click', click as EventListener, true);
    document.removeEventListener('scroll', scroll, true);
  };
}
