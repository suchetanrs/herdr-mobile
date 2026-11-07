// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLING_MS, guardTaps, TAP_SLOP, TapTracker } from './tap';

describe('TapTracker', () => {
  it('a still touch is a tap', () => {
    const t = new TapTracker();
    t.down(1, 100, 20, 0, 1000);
    expect(t.move(1, 103, 21)).toBe(true);
    expect(t.up(1, 104, 22, 0)).toBe(true);
  });

  it('moving TAP_SLOP or more is a pan, even if the finger comes back', () => {
    const t = new TapTracker();
    t.down(1, 100, 20, 0, 1000);
    expect(t.move(1, 100 - TAP_SLOP, 20)).toBe(false);
    expect(t.pending).toBe(false);
    expect(t.up(1, 100, 20, 0)).toBe(false);
  });

  it('just under the slop still taps; vertical counts too', () => {
    const t = new TapTracker();
    t.down(1, 0, 0, 0, 0);
    expect(t.up(1, TAP_SLOP - 1, 0, 0)).toBe(true);
    t.down(1, 0, 0, 0, 0);
    expect(t.up(1, 0, TAP_SLOP, 0)).toBe(false);
  });

  it('the strip scrolling under a still finger is not a tap', () => {
    const t = new TapTracker();
    t.down(1, 100, 20, 0, 1000);
    expect(t.up(1, 100, 20, 30)).toBe(false);
    t.down(1, 100, 20, 0, 2000);
    t.scrolled(2010);
    expect(t.up(1, 100, 20, 0)).toBe(false);
  });

  it('a touch that stops a fling is not a tap; a later one is', () => {
    const t = new TapTracker();
    t.scrolled(1000);
    t.down(1, 100, 20, 50, 1000 + FLING_MS - 1);
    expect(t.pending).toBe(false);
    expect(t.up(1, 100, 20, 50)).toBe(false);
    t.down(1, 100, 20, 50, 1000 + FLING_MS + 1);
    expect(t.up(1, 100, 20, 50)).toBe(true);
  });

  it('another pointer, cancel, and up without down are not taps', () => {
    const t = new TapTracker();
    t.down(1, 0, 0, 0, 0);
    expect(t.up(2, 0, 0, 0)).toBe(false);
    t.down(1, 0, 0, 0, 0);
    t.cancel();
    expect(t.up(1, 0, 0, 0)).toBe(false);
    expect(t.up(1, 0, 0, 0)).toBe(false);
  });
});

describe('guardTaps', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  function rig() {
    const strip = document.createElement('div');
    const btn = document.createElement('button');
    strip.append(btn);
    document.body.append(strip);
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    const off = guardTaps(strip);
    const p = (type: string, x: number) =>
      btn.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: 10, pointerId: 7, isPrimary: true }));
    const click = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    return { strip, btn, onClick, off, p, click };
  }

  it('lets a tap click through', () => {
    const r = rig();
    r.p('pointerdown', 50);
    r.p('pointerup', 52);
    r.click();
    expect(r.onClick).toHaveBeenCalledTimes(1);
  });

  it('drops the click that ends a pan', () => {
    const r = rig();
    r.p('pointerdown', 50);
    r.p('pointermove', 80);
    r.p('pointerup', 120);
    r.click();
    expect(r.onClick).not.toHaveBeenCalled();
    // The next tap works again.
    r.p('pointerdown', 50);
    r.p('pointerup', 50);
    r.click();
    expect(r.onClick).toHaveBeenCalledTimes(1);
  });

  it('drops the click when the strip scrolled under the finger', () => {
    const r = rig();
    r.p('pointerdown', 50);
    r.strip.scrollLeft = 40;
    r.strip.dispatchEvent(new Event('scroll'));
    r.p('pointerup', 50);
    r.click();
    expect(r.onClick).not.toHaveBeenCalled();
  });

  it('drops the click after a pointercancel (the browser took the pan)', () => {
    const r = rig();
    r.p('pointerdown', 50);
    r.p('pointercancel', 50);
    r.click();
    expect(r.onClick).not.toHaveBeenCalled();
  });

  it('keyboard / programmatic clicks (no pointer) pass, and it can be removed', () => {
    const r = rig();
    r.btn.click();
    expect(r.onClick).toHaveBeenCalledTimes(1);
    r.off();
    r.p('pointerdown', 50);
    r.p('pointermove', 200);
    r.click();
    expect(r.onClick).toHaveBeenCalledTimes(2);
  });
});
