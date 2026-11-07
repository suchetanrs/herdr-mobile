import { isEditable } from './viewport';

/**
 * Tap vs. scroll on button strips that scroll sideways (quick keys, tab pills, answers). A button fires only
 * on a real tap: the finger moved less than TAP_SLOP, the strip didn't scroll under it, and the strip wasn't
 * still gliding when it came down (a touch that stops a fling is not a tap).
 */
export const TAP_SLOP = 10;
/** A strip that scrolled this recently is still moving (momentum): a touch now only stops it. */
export const FLING_MS = 120;

interface Start {
  id: number;
  x: number;
  y: number;
  scroll: number;
}

export class TapTracker {
  private start: Start | null = null;
  private lastScrollAt = Number.NEGATIVE_INFINITY;

  /** A pointer came down on a button of the strip. `scroll`: the strip's scrollLeft now. */
  down(id: number, x: number, y: number, scroll: number, now: number): void {
    this.start = now - this.lastScrollAt < FLING_MS ? null : { id, x, y, scroll };
  }

  /** The pointer moved; false once it's no longer a tap. */
  move(id: number, x: number, y: number): boolean {
    const s = this.start;
    if (!s || s.id !== id) return s !== null;
    if (Math.hypot(x - s.x, y - s.y) >= TAP_SLOP) this.start = null;
    return this.start !== null;
  }

  /** The strip scrolled (by the finger, momentum or code): whatever is down is not a tap. */
  scrolled(now: number): void {
    this.lastScrollAt = now;
    this.start = null;
  }

  cancel(): void {
    this.start = null;
  }

  /** Still a tap in progress (no movement or scroll yet)? */
  get pending(): boolean {
    return this.start !== null;
  }

  /** The pointer went up: true if this was a tap. */
  up(id: number, x: number, y: number, scroll: number): boolean {
    const s = this.start;
    this.start = null;
    return s !== null && s.id === id && Math.hypot(x - s.x, y - s.y) < TAP_SLOP && Math.abs(scroll - s.scroll) < 1;
  }
}

/**
 * Drops clicks on `strip` that ended a pan or a scroll rather than a tap. Works for any button with a plain
 * onClick (React's or native): the click is stopped in the capture phase before it reaches the button.
 * Clicks without a pointer (keyboard, assistive tech, el.click()) pass.
 */
export function guardTaps(strip: HTMLElement): () => void {
  const t = new TapTracker();
  // null: no pointer gesture to judge (keyboard click); true/false: the last gesture's verdict.
  let verdict: boolean | null = null;
  const scrollLeft = () => strip.scrollLeft;
  const down = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    verdict = null;
    // A text field in the strip (an answer typed in) is never a pan's button: its taps always go through.
    if (isTextField(e.target)) return;
    t.down(e.pointerId, e.clientX, e.clientY, scrollLeft(), performance.now());
    if (!t.pending) verdict = false;
  };
  const move = (e: PointerEvent) => {
    if (t.pending && !t.move(e.pointerId, e.clientX, e.clientY)) verdict = false;
  };
  const up = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    if (verdict === false) return;
    verdict = t.up(e.pointerId, e.clientX, e.clientY, scrollLeft());
  };
  const cancel = () => {
    t.cancel();
    verdict = false;
  };
  // The strip itself or anything around it (the list the answers sit in) scrolling ends a tap.
  const scroll = (e: Event) => {
    const target = e.target;
    if (target !== document && !(target instanceof Node && target.contains(strip))) return;
    if (t.pending) verdict = false;
    t.scrolled(performance.now());
  };
  const click = (e: MouseEvent) => {
    const v = verdict;
    verdict = null;
    if (v === false && !isTextField(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  strip.addEventListener('pointerdown', down, true);
  strip.addEventListener('pointermove', move, true);
  strip.addEventListener('pointerup', up, true);
  strip.addEventListener('pointercancel', cancel, true);
  document.addEventListener('scroll', scroll, { capture: true, passive: true });
  strip.addEventListener('click', click, true);
  return () => {
    strip.removeEventListener('pointerdown', down, true);
    strip.removeEventListener('pointermove', move, true);
    strip.removeEventListener('pointerup', up, true);
    strip.removeEventListener('pointercancel', cancel, true);
    document.removeEventListener('scroll', scroll, true);
    strip.removeEventListener('click', click, true);
  };
}

/** Text fields: tapping one must bring up the phone keyboard. */
export function isTextField(el: EventTarget | null): el is HTMLElement {
  return isEditable(el instanceof Element ? el : null);
}

/**
 * Focuses `field` in the touchend of a still tap on it, i.e. inside the touch itself. iOS raises its keyboard
 * only for a focus made while it is handling the person's touch. A tap normally focuses the field later, from
 * the mouse events iOS synthesizes after the touch, and in a home-screen app that step is where the keyboard
 * goes missing. Nothing is prevented: the caret still lands where the finger was, and a pan stays a scroll.
 */
export function focusOnTap(field: HTMLElement): () => void {
  let start: { id: number; x: number; y: number; at: number } | null = null;
  const down = (e: TouchEvent) => {
    const t = e.touches[0];
    start = e.touches.length === 1 && t ? { id: t.identifier, x: t.clientX, y: t.clientY, at: performance.now() } : null;
  };
  const move = (e: TouchEvent) => {
    const t = start && Array.from(e.touches).find((x) => x.identifier === start?.id);
    if (t && start && Math.hypot(t.clientX - start.x, t.clientY - start.y) >= TAP_SLOP) start = null;
  };
  const up = (e: TouchEvent) => {
    const s = start;
    start = null;
    const t = s && Array.from(e.changedTouches).find((x) => x.identifier === s.id);
    if (!s || !t || e.touches.length > 0) return;
    if (Math.hypot(t.clientX - s.x, t.clientY - s.y) >= TAP_SLOP || performance.now() - s.at > 800) return;
    if (document.activeElement !== field && isTextField(field)) field.focus();
  };
  const cancel = () => {
    start = null;
  };
  field.addEventListener('touchstart', down, { passive: true });
  field.addEventListener('touchmove', move, { passive: true });
  field.addEventListener('touchend', up);
  field.addEventListener('touchcancel', cancel, { passive: true });
  return () => {
    field.removeEventListener('touchstart', down);
    field.removeEventListener('touchmove', move);
    field.removeEventListener('touchend', up);
    field.removeEventListener('touchcancel', cancel);
  };
}
