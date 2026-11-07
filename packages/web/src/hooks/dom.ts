import { useEffect, useState } from 'react';
import { isEditable, SETTLE_MS, viewportState } from '../lib/viewport';

export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
  const [on, setOn] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return on;
}

/** Herdr's desktop layout (sidebar + tabs + pane) from this width up. */
export const DESKTOP = '(min-width: 1024px)';

/**
 * Keeps the app inside the visual viewport while the phone keyboard is up, so the composer stays above it
 * (iOS doesn't resize the layout viewport for it), and back at the full height once it's down. Sets --vvh /
 * --vv-top and data-keyboard on <html>. See lib/viewport.ts for why focus decides, not just the events.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    let frame = 0;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let last = '';
    const measure = () => {
      const editing = isEditable(document.activeElement);
      const s = viewportState({
        editing,
        vvHeight: vv?.height ?? window.innerHeight,
        vvTop: vv?.offsetTop ?? 0,
        innerHeight: window.innerHeight,
      });
      const key = `${s.keyboard} ${s.height} ${s.top}`;
      if (key !== last) {
        last = key;
        if (s.height === null) root.style.removeProperty('--vvh');
        else root.style.setProperty('--vvh', `${s.height}px`);
        if (s.top === null) root.style.removeProperty('--vv-top');
        else root.style.setProperty('--vv-top', `${s.top}px`);
        root.dataset.keyboard = s.keyboard;
      }
      // iOS scrolls the window to show the caret and can leave it there after the keyboard goes.
      if (!editing && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    /** Now, and again over the keyboard's animation: iOS may send no event at its end. */
    const settle = () => {
      update();
      for (const t of timers) clearTimeout(t);
      timers = SETTLE_MS.map((ms) => setTimeout(measure, ms));
    };
    measure();
    vv?.addEventListener('resize', settle);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', settle);
    // Focus moving between two fields: activeElement is the next one by the frame after focusout, so no flicker.
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    return () => {
      cancelAnimationFrame(frame);
      for (const t of timers) clearTimeout(t);
      vv?.removeEventListener('resize', settle);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', settle);
      document.removeEventListener('focusin', settle);
      document.removeEventListener('focusout', settle);
    };
  }, []);
}
