// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLING_MS, focusOnTap, guardTaps, isTextField, TAP_SLOP, TapTracker } from './tap';

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

describe('guardTaps and text fields', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('never blocks a click on a text field in the strip, even after a pan or a cancel', () => {
    const strip = document.createElement('div');
    const field = document.createElement('input');
    strip.append(field);
    document.body.append(strip);
    const onClick = vi.fn();
    field.addEventListener('click', onClick);
    guardTaps(strip);
    const p = (type: string, x: number) =>
      field.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: 10, pointerId: 3, isPrimary: true }));
    p('pointerdown', 10);
    p('pointermove', 90);
    p('pointerup', 90);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    field.dispatchEvent(e);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    p('pointerdown', 10);
    p('pointercancel', 10);
    field.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe('focusOnTap', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  function rig(tag: 'textarea' | 'input' = 'textarea') {
    const field = document.createElement(tag);
    document.body.append(field);
    const off = focusOnTap(field);
    /** Records whether focus came while `type` was being dispatched (synchronously inside the touch). */
    const seen: string[] = [];
    let dispatching: string | null = null;
    field.addEventListener('focus', () => seen.push(dispatching ?? 'later'));
    const touch = (type: string, x: number, y: number, down: boolean) => {
      const t = { identifier: 1, clientX: x, clientY: y, target: field };
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'touches', { value: down ? [t] : [] });
      Object.defineProperty(e, 'changedTouches', { value: [t] });
      dispatching = type;
      field.dispatchEvent(e);
      dispatching = null;
    };
    return { field, off, seen, touch };
  }

  it('a still tap focuses the field during its touchend', () => {
    const r = rig();
    r.touch('touchstart', 40, 20, true);
    expect(document.activeElement).not.toBe(r.field);
    r.touch('touchend', 42, 21, false);
    expect(document.activeElement).toBe(r.field);
    expect(r.seen).toEqual(['touchend']);
  });

  it('a pan (scrolling the field or the page) never focuses', () => {
    const r = rig();
    r.touch('touchstart', 40, 20, true);
    r.touch('touchmove', 40, 20 + TAP_SLOP, true);
    r.touch('touchend', 40, 20, false);
    expect(document.activeElement).not.toBe(r.field);
    r.touch('touchstart', 40, 20, true);
    r.touch('touchcancel', 40, 20, false);
    r.touch('touchend', 40, 20, false);
    expect(document.activeElement).not.toBe(r.field);
  });

  it('an already focused field is left alone (caret, selection); read-only and disabled fields are not focused', () => {
    const r = rig('input');
    r.field.focus();
    r.seen.length = 0;
    r.touch('touchstart', 5, 5, true);
    r.touch('touchend', 5, 5, false);
    expect(r.seen).toEqual([]);
    r.field.blur();
    r.field.readOnly = true;
    r.touch('touchstart', 5, 5, true);
    r.touch('touchend', 5, 5, false);
    expect(document.activeElement).not.toBe(r.field);
  });

  it('can be removed', () => {
    const r = rig();
    r.off();
    r.touch('touchstart', 5, 5, true);
    r.touch('touchend', 5, 5, false);
    expect(document.activeElement).not.toBe(r.field);
  });

  it('isTextField: text inputs, textareas and contenteditable; not buttons, checkboxes or null', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTextField(document.createElement('textarea'))).toBe(true);
    expect(isTextField(document.createElement('input'))).toBe(true);
    expect(isTextField(document.createElement('button'))).toBe(false);
    expect(isTextField(box)).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});
