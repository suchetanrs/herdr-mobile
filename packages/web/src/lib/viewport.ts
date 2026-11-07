/**
 * Where the app lives while the phone's keyboard comes and goes.
 *
 * iOS doesn't resize the layout viewport for its keyboard (it ignores interactive-widget), so while a text
 * field has focus the app follows the visual viewport (--vvh, --vv-top). The keyboard can't be hidden on iOS
 * without the field losing focus, and on the way down iOS often sends no final visualViewport resize (or one
 * mid-animation, with a stale height), and may leave the window scrolled where it put it for the caret. So
 * the visual viewport is trusted only while an editable has focus; without one the app is the full layout
 * height (100dvh), whatever the last visualViewport event said.
 */
export interface ViewportInput {
  /** A text field (input, textarea, contenteditable) has focus. */
  editing: boolean;
  vvHeight: number;
  vvTop: number;
  innerHeight: number;
}

export interface ViewportState {
  keyboard: 'up' | 'down';
  /** px for --vvh / --vv-top, or null: no override (100dvh, no shift). */
  height: number | null;
  top: number | null;
}

/** The visual viewport this much shorter than the window: the keyboard is up. */
export const KEYBOARD_MIN = 120;

export function viewportState(v: ViewportInput): ViewportState {
  if (!v.editing) return { keyboard: 'down', height: null, top: null };
  return {
    keyboard: v.innerHeight - v.vvHeight > KEYBOARD_MIN ? 'up' : 'down',
    height: Math.round(v.vvHeight),
    top: Math.max(0, Math.round(v.vvTop)),
  };
}

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time', '']);

/** Elements that bring up the on-screen keyboard. */
export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled;
  return el instanceof HTMLElement && el.isContentEditable === true;
}

/** Re-measure after the keyboard's show/hide animation (~250-400 ms on iOS) in case no event marks its end. */
export const SETTLE_MS = [60, 160, 320, 520, 800];
