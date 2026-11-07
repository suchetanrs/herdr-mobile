import { describe, expect, it } from 'vitest';
import { autoFont, type CellRatio, fitFont, fontFor, READABLE, READABLE_DESKTOP, type Room, stepFont } from './zoom';

const cell: CellRatio = { w: 0.6, h: 1.32 };
// The desktop's 127x41 pane, in the room a phone or a desktop window gives it.
const room = (width: number, height: number): Room => ({ width, height, cols: 127, rows: 41 });

describe('terminal zoom', () => {
  it('auto never goes below a readable size on a phone held upright (it pans instead)', () => {
    for (const w of [375, 393, 412]) expect(autoFont(room(w, 550), cell)).toBe(READABLE);
  });

  it('auto shows the whole width of a phone held sideways when that is readable', () => {
    // Pixel 7 sideways: 915 px wide fits 127 columns at 12 px (the height scrolls with the cursor).
    expect(autoFont(room(915, 270), cell)).toBeCloseTo(12, 0);
    // iPhone sideways inside the notches: not quite, so readable size and a short pan.
    expect(autoFont(room(758, 270), cell)).toBe(READABLE);
  });

  it('auto fits the whole grid of a desktop window, never above Herdr’s 14 px', () => {
    const f = autoFont(room(1120, 660), cell);
    expect(f).toBeGreaterThanOrEqual(READABLE);
    expect(41 * cell.h * f).toBeLessThanOrEqual(660);
    expect(autoFont(room(2400, 1400), cell)).toBe(14);
  });

  it('auto fits a wide grid on a desktop screen rather than panning (lower floor with a mouse)', () => {
    // The desktop's pane grew to 173 columns; our pane is 1122 px wide.
    const wide = { width: 1120, height: 660, cols: 173, rows: 41 };
    expect(autoFont(wide, cell)).toBe(READABLE);
    const f = autoFont(wide, cell, READABLE_DESKTOP);
    expect(f).toBeLessThan(READABLE);
    expect(173 * cell.w * f).toBeLessThanOrEqual(1120);
  });

  it('fit shows the whole grid however small; a picked size stays', () => {
    const f = fitFont(room(375, 450), cell);
    expect(f).toBeLessThan(5);
    expect(127 * cell.w * f).toBeLessThanOrEqual(375);
    expect(fontFor({ mode: 'fit' }, room(375, 450), cell)).toBe(f);
    expect(fontFor({ mode: 'font', font: 13 }, room(375, 450), cell)).toBe(13);
    // The keyboard is up (height 0): the width alone.
    expect(fitFont(room(375, 0), cell)).toBeCloseTo(375 / 127 / 0.6, 0);
  });

  it('steps the size by whole pixels', () => {
    expect(stepFont(11, 1)).toBe(12);
    expect(stepFont(11, -1)).toBe(10);
    expect(stepFont(10.4, 1)).toBe(11);
    expect(stepFont(10.4, -1)).toBe(10);
    expect(stepFont(16, 1)).toBe(18);
    expect(stepFont(4, -1)).toBe(4);
  });
});
