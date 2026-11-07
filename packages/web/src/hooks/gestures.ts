import { useCallback, useEffect, useRef } from 'react';
import { focusOnTap, guardTaps, isTextField } from '../lib/tap';

/** Something between `el` and `stop` scrolls sideways (code blocks, tables): a horizontal swipe there is theirs. */
function scrollsSideways(el: Element | null, stop: Element): boolean {
  for (let e = el; e && e !== stop; e = e.parentElement) {
    if (e.scrollWidth > e.clientWidth + 1) {
      const ox = getComputedStyle(e).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

/** Horizontal swipes on an element (to the previous / next agent of the space). */
export function useSwipe(onSwipe: (dir: 1 | -1) => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const cb = useRef(onSwipe);
  cb.current = onSwipe;
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      const ok = e.touches.length === 1 && t && t.clientX > 28 && !scrollsSideways(e.target as Element, e.currentTarget);
      start.current = ok ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = start.current;
      const t = e.changedTouches[0];
      start.current = null;
      if (!s || !t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 2 && Date.now() - s.t < 600) cb.current(dx < 0 ? 1 : -1);
    },
  };
}

/** Opened from the home screen: no browser chrome, and on iOS no system back gesture either. */
export function standalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Swipe right from the left edge to go back, iOS-style, where the system doesn't do it (a home-screen
 * app). In a browser tab the browser's own edge swipe does it already.
 */
export function useEdgeBack(onBack: (() => void) | null): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  const on = onBack !== null;
  useEffect(() => {
    if (!on || !standalone()) return;
    let s: { x: number; y: number; t: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      // A touch on a text field is the person typing, never a swipe back.
      s = e.touches.length === 1 && t && t.clientX < 24 && !isTextField(e.target) ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      const from = s;
      s = null;
      if (!from || !t) return;
      const dx = t.clientX - from.x;
      if (dx > 70 && dx > Math.abs(t.clientY - from.y) * 1.5 && Date.now() - from.t < 800) cb.current?.();
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
    };
  }, [on]);
}

/** Ref for a strip of buttons that scrolls: its buttons' clicks fire on real taps only, never at the end of a pan. */
export function useTapGuard<T extends HTMLElement>(): (el: T | null) => void {
  const off = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    off.current?.();
    off.current = el ? guardTaps(el) : null;
  }, []);
}

/** Ref for a text field: a tap focuses it inside the touch itself, so iOS raises the keyboard (lib/tap.ts focusOnTap). */
export function useTapFocus<T extends HTMLElement>(): (el: T | null) => void {
  const off = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    off.current?.();
    off.current = el ? focusOnTap(el) : null;
  }, []);
}
