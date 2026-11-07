// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyBar } from './KeyBar';

function rig() {
  const onKey = vi.fn();
  const onCtrl = vi.fn();
  const r = render(<KeyBar onKey={onKey} ctrl="off" onCtrl={onCtrl} />);
  const bar = r.container.querySelector('.keybar') as HTMLElement;
  const key = (label: string) => r.getByRole('button', { name: label });
  const p = (el: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', x: number) =>
    fireEvent[type](el, { clientX: x, clientY: 10, pointerId: 1, isPrimary: true });
  return { onKey, onCtrl, bar, key, p, ...r };
}

describe('KeyBar: taps press, pans never do', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('nothing on the way down; the key fires when a tap lifts', () => {
    const r = rig();
    const esc = r.key('Escape');
    r.p(esc, 'pointerDown', 40);
    expect(r.onKey).not.toHaveBeenCalled();
    r.p(esc, 'pointerUp', 42);
    expect(r.onKey).toHaveBeenCalledWith('esc');
    expect(r.onKey).toHaveBeenCalledTimes(1);
  });

  it('a sideways drag across keys sends nothing', () => {
    const r = rig();
    const y = r.key('y');
    r.p(y, 'pointerDown', 200);
    r.p(y, 'pointerMove', 185);
    r.p(y, 'pointerMove', 120);
    r.p(y, 'pointerUp', 60);
    expect(r.onKey).not.toHaveBeenCalled();
  });

  it('the browser taking the pan (pointercancel) or the bar scrolling sends nothing', () => {
    const r = rig();
    const cc = r.key('Ctrl+C');
    r.p(cc, 'pointerDown', 100);
    r.p(cc, 'pointerCancel', 100);
    r.p(cc, 'pointerUp', 100);
    r.p(cc, 'pointerDown', 100);
    fireEvent.scroll(r.bar);
    r.p(cc, 'pointerUp', 100);
    expect(r.onKey).not.toHaveBeenCalled();
  });

  it('a still hold on an arrow repeats; lifting adds no extra press', () => {
    const r = rig();
    const up = r.key('Up');
    r.p(up, 'pointerDown', 100);
    act(() => vi.advanceTimersByTime(379));
    expect(r.onKey).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1 + 70 * 3));
    expect(r.onKey).toHaveBeenCalledTimes(4);
    r.p(up, 'pointerUp', 100);
    act(() => vi.advanceTimersByTime(500));
    expect(r.onKey).toHaveBeenCalledTimes(4);
  });

  it('a hold that turns into a pan never repeats', () => {
    const r = rig();
    const up = r.key('Up');
    r.p(up, 'pointerDown', 100);
    act(() => vi.advanceTimersByTime(200));
    r.p(up, 'pointerMove', 70);
    act(() => vi.advanceTimersByTime(1000));
    r.p(up, 'pointerUp', 40);
    expect(r.onKey).not.toHaveBeenCalled();
  });

  it('pointerdown is default-prevented (focus and the phone keyboard stay put)', () => {
    const r = rig();
    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true });
    r.key('Tab').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ctrl (a plain click button) ignores the click that ends a pan, takes a tap', () => {
    const r = rig();
    const ctrl = r.getByText('ctrl');
    r.p(ctrl, 'pointerDown', 100);
    r.p(ctrl, 'pointerMove', 40);
    r.p(ctrl, 'pointerUp', 40);
    fireEvent.click(ctrl, { detail: 1 });
    expect(r.onCtrl).not.toHaveBeenCalled();
    r.p(ctrl, 'pointerDown', 100);
    r.p(ctrl, 'pointerUp', 100);
    fireEvent.click(ctrl, { detail: 1 });
    expect(r.onCtrl).toHaveBeenCalledWith('once');
  });
});
