// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetLayer } from './Sheet';

class FakeVV extends EventTarget {
  height = 844;
  offsetTop = 0;
}

describe('SheetLayer', () => {
  let vv: FakeVV;
  const scrolled: Element[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vv = new FakeVV();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    scrolled.length = 0;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const sheet = (onDismiss = () => {}) =>
    render(
      <div className="bar" style={{ transform: 'translateY(0)' }}>
        <SheetLayer className="add-backdrop" onDismiss={onDismiss}>
          <form className="sheet">
            <input aria-label="name" />
            <button type="submit">Create</button>
          </form>
        </SheetLayer>
        <input aria-label="outside" />
      </div>,
    );

  it('sits on <body>, outside whatever box rendered it (bars clip, transforms shift a fixed layer)', () => {
    const { container } = sheet();
    const layer = document.querySelector('.sheet-backdrop.add-backdrop');
    expect(layer?.parentElement).toBe(document.body);
    expect(container.contains(layer)).toBe(false);
  });

  it('a tap on the backdrop dismisses; one inside the sheet does not', () => {
    const dismiss = vi.fn();
    sheet(dismiss);
    fireEvent.pointerDown(document.querySelector('.sheet') as Element);
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.querySelector('.sheet-backdrop') as Element);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps its focused field in view as the keyboard comes up; fields elsewhere are left alone', () => {
    const { getByLabelText } = sheet();
    const name = getByLabelText('name') as HTMLInputElement;
    name.focus();
    vi.advanceTimersByTime(1000);
    expect(scrolled.length).toBeGreaterThan(0);
    expect(scrolled.every((el) => el === name)).toBe(true);
    // The keyboard finishing its animation (visual viewport shrinks) re-checks.
    scrolled.length = 0;
    vv.height = 420;
    vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(scrolled).toContain(name);
    // Focus outside the sheet: nothing scrolled.
    scrolled.length = 0;
    (getByLabelText('outside') as HTMLInputElement).focus();
    vv.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(scrolled).toEqual([]);
  });
});
