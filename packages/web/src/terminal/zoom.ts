import { load, save } from '../lib/storage';

/**
 * How a terminal is scaled on this device. The grid is always the desktop's (never resized from here):
 * - auto: readable. The whole width when that's at least READABLE px (wide screens, phones held sideways),
 *   else READABLE px and the view pans sideways, following the cursor.
 * - fit: the whole grid in view, however small.
 * - font: a size the person picked (pinch, +/-).
 */
export type Zoom = { mode: 'auto' } | { mode: 'fit' } | { mode: 'font'; font: number };
export type ZoomMode = Zoom['mode'];

export const MIN_FONT = 4;
export const MAX_FONT = 32;
/** The smallest size auto ever picks: text you can read on a phone without zooming in. */
export const READABLE = 11;
/** The same on a desktop screen read at arm's length with a mouse: fitting the width beats panning there. */
export const READABLE_DESKTOP = 9;
/** The font Herdr's terminals use (settings.rs default); auto never goes above it. */
export const HERDR_FONT = 14;
export const MONO = '"JetBrains Mono", "Symbols Nerd Font", ui-monospace, monospace';

export function loadZoom(terminalId: string, fallback: 'auto' | 'fit' = 'auto'): Zoom {
  const z = load<Zoom | null>(`zoom2.${terminalId}`, null);
  if (z?.mode === 'font' && Number.isFinite(z.font)) return { mode: 'font', font: clampFont(z.font) };
  if (z?.mode === 'fit' || z?.mode === 'auto') return z;
  return { mode: fallback };
}

/** Remembers a picked size or mode per terminal; the device default isn't stored (it can change in Settings). */
export function saveZoom(terminalId: string, z: Zoom, fallback: 'auto' | 'fit' = 'auto'): void {
  save(`zoom2.${terminalId}`, z.mode === fallback ? null : z);
}

export function clampFont(f: number): number {
  return Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(f * 10) / 10));
}

/** Cell size per 1px of font, as the renderer draws it (measured from the drawn grid). */
export interface CellRatio {
  w: number;
  h: number;
}

/** The space the grid can use, CSS px. `height` 0: don't fit the height (phone keyboard up). */
export interface Room {
  width: number;
  height: number;
  cols: number;
  rows: number;
}

const floor1 = (f: number) => Math.floor(f * 10) / 10;

/** The biggest font whose grid fits `room` (width, and height when given). */
export function fitFont(room: Room, cell: CellRatio, heightToo = true): number {
  if (room.cols < 1 || room.width <= 0 || cell.w <= 0) return HERDR_FONT;
  const w = room.width / (room.cols * cell.w);
  const h = heightToo && room.height > 0 && room.rows > 0 && cell.h > 0 ? room.height / (room.rows * cell.h) : Number.POSITIVE_INFINITY;
  return clampFont(floor1(Math.min(w, h)));
}

/**
 * Auto: the whole grid when it can be shown at a readable size (desktop windows), else the whole width
 * when that's readable (phones held sideways: the view scrolls down with the cursor), else READABLE px
 * (phones held upright: the view pans sideways with the cursor). Never above Herdr's own size.
 */
export function autoFont(room: Room, cell: CellRatio, floor = READABLE): number {
  const both = fitFont(room, cell, true);
  if (both >= floor) return Math.min(both, HERDR_FONT);
  const width = fitFont(room, cell, false);
  return clampFont(Math.min(HERDR_FONT, Math.max(floor, width)));
}

export function fontFor(z: Zoom, room: Room, cell: CellRatio, floor = READABLE): number {
  if (z.mode === 'font') return z.font;
  if (z.mode === 'fit') return fitFont(room, cell, true);
  return autoFont(room, cell, floor);
}

/** Auto's floor on this device: READABLE on touch screens, lower on a desktop with a mouse. */
export function autoFloor(): number {
  const desk = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine) and (min-width: 1024px)').matches;
  return desk ? READABLE_DESKTOP : READABLE;
}

/** Size steps for the +/- buttons: whole pixels, 2px apart above 16px. */
export function stepFont(font: number, dir: 1 | -1): number {
  if (dir > 0) return clampFont(Math.floor(font + 0.05) + (font >= 16 ? 2 : 1));
  return clampFont(Math.ceil(font - 0.05) - (font > 16 ? 2 : 1));
}

let cellAt100: CellRatio | null = null;

/** The monospace cell per 1px of font from the canvas, before anything is drawn (refined by measuring later). */
export function estimatedCell(): CellRatio {
  if (cellAt100) return cellAt100;
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!ctx) return { w: 0.6, h: 1.32 };
  ctx.font = `100px ${MONO}`;
  const w = ctx.measureText('W'.repeat(10)).width / 1000;
  if (!(w > 0)) return { w: 0.6, h: 1.32 };
  cellAt100 = { w, h: 1.32 };
  return cellAt100;
}
