// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisualViewport } from '../hooks/dom';
import { isEditable, viewportState } from './viewport';

describe('viewportState', () => {
  it('no field focused: full height, no shift, keyboard down, whatever the visual viewport says', () => {
    // iOS after the keyboard went: a stale, short visual viewport and a scrolled offset.
    expect(viewportState({ editing: false, vvHeight: 420, vvTop: 300, innerHeight: 844 })).toEqual({
      keyboard: 'down',
      height: null,
      top: null,
    });
  });
  it('a field focused and the keyboard up: follow the visual viewport', () => {
    expect(viewportState({ editing: true, vvHeight: 420.4, vvTop: 12.6, innerHeight: 844 })).toEqual({
      keyboard: 'up',
      height: 420,
      top: 13,
    });
  });
  it('a field focused without an on-screen keyboard (hardware, Android resizes-content)', () => {
    expect(viewportState({ editing: true, vvHeight: 800, vvTop: 0, innerHeight: 844 }).keyboard).toBe('down');
    expect(viewportState({ editing: true, vvHeight: 500, vvTop: -2, innerHeight: 500 })).toEqual({ keyboard: 'down', height: 500, top: 0 });
  });
});

describe('isEditable', () => {
  it('text fields yes; buttons, checkboxes, read-only no', () => {
    const ta = document.createElement('textarea');
    const text = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const ro = document.createElement('textarea');
    ro.readOnly = true;
    expect([ta, text, box, ro, document.createElement('button'), null].map(isEditable)).toEqual([true, true, false, false, false, false]);
  });
});

/** A visualViewport we drive by hand, like iOS: events only when we say so. */
class FakeVV extends EventTarget {
  height = 844;
  offsetTop = 0;
  width = 390;
}

describe('useVisualViewport (iOS keyboard close)', () => {
  let vv: FakeVV;
  const root = document.documentElement;
  const vvh = () => root.style.getPropertyValue('--vvh');
  beforeEach(() => {
    vi.useFakeTimers();
    vv = new FakeVV();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    document.body.innerHTML = '<textarea id="a"></textarea><textarea id="b"></textarea><button id="k">k</button>';
  });
  afterEach(() => {
    vi.useRealTimers();
    root.removeAttribute('style');
    delete root.dataset.keyboard;
  });
  const flush = () => vi.advanceTimersByTime(1000);

  it('follows the keyboard up, and comes back down on blur even with no visualViewport event', () => {
    renderHook(() => useVisualViewport());
    expect(root.dataset.keyboard).toBe('down');
    expect(vvh()).toBe('');
    (document.getElementById('a') as HTMLTextAreaElement).focus();
    vv.height = 420;
    vv.offsetTop = 260;
    vv.dispatchEvent(new Event('resize'));
    flush();
    expect(vvh()).toBe('420px');
    expect(root.style.getPropertyValue('--vv-top')).toBe('260px');
    expect(root.dataset.keyboard).toBe('up');
    // Keyboard dismissed: the field blurs; iOS sends nothing more and the visual viewport still reads short.
    (document.getElementById('a') as HTMLTextAreaElement).blur();
    flush();
    expect(vvh()).toBe('');
    expect(root.style.getPropertyValue('--vv-top')).toBe('');
    expect(root.dataset.keyboard).toBe('down');
  });

  it('resets a window iOS left scrolled once the keyboard is down', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 180 });
    renderHook(() => useVisualViewport());
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    vi.unstubAllGlobals();
  });

  it('focus moving between two fields keeps the keyboard layout (no flicker)', () => {
    renderHook(() => useVisualViewport());
    (document.getElementById('a') as HTMLTextAreaElement).focus();
    vv.height = 420;
    vv.dispatchEvent(new Event('resize'));
    flush();
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(`${root.dataset.keyboard} ${vvh()}`));
    mo.observe(root, { attributes: true });
    (document.getElementById('b') as HTMLTextAreaElement).focus();
    flush();
    mo.disconnect();
    expect(seen).toEqual([]);
    expect(vvh()).toBe('420px');
  });

  it('repeated open/close settles each time', () => {
    renderHook(() => useVisualViewport());
    const a = document.getElementById('a') as HTMLTextAreaElement;
    for (let i = 0; i < 3; i++) {
      a.focus();
      vv.height = 420;
      vv.dispatchEvent(new Event('resize'));
      flush();
      expect(root.dataset.keyboard).toBe('up');
      a.blur();
      flush();
      expect(root.dataset.keyboard).toBe('down');
      expect(vvh()).toBe('');
      vv.height = 844;
    }
  });
});
