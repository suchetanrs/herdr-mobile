import { load, save } from './storage';

/**
 * Diagnostic switches (Settings > About > Diagnostics) that turn off one suspected mechanism each, so the
 * person can tell on the real phone which one keeps the iOS keyboard from coming up. All off by default; a
 * reload applies them everywhere.
 */
export const AB_FLAGS = {
  noViewport: 'Don’t follow the visual viewport (task 8: --vvh/--vv-top, scroll reset)',
  noTapFocus: 'Don’t focus text fields in touchend (task 22)',
  noEdgeBack: 'No edge swipe back (document touch listeners)',
  staticApp: 'App frame not position:fixed / transformed',
  noTransitions: 'No view transitions between screens',
  noRefocus: 'Keyboard button: no blur before focusing the terminal',
} as const;

export type AbFlag = keyof typeof AB_FLAGS;
const KEY = 'ab';

let flags: Partial<Record<AbFlag, boolean>> = load<Partial<Record<AbFlag, boolean>>>(KEY, {});

export function ab(flag: AbFlag): boolean {
  return flags[flag] === true;
}

export function abAll(): Partial<Record<AbFlag, boolean>> {
  return { ...flags };
}

export function setAb(flag: AbFlag, on: boolean): void {
  flags = { ...flags, [flag]: on };
  if (!on) delete flags[flag];
  save(KEY, Object.keys(flags).length ? flags : null);
  applyAbToDocument();
}

/** The CSS-level switches as `data-ab` on <html>. */
export function applyAbToDocument(root: HTMLElement = document.documentElement): void {
  const on = (Object.keys(flags) as AbFlag[]).filter((f) => flags[f]);
  if (on.length) root.dataset.ab = on.join(' ');
  else delete root.dataset.ab;
}
