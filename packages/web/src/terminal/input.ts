/**
 * Replies a terminal emulator sends by itself (device attributes, cursor
 * position, mode and color reports, focus events). herdr-core already
 * answers these for the program, so the bridge drops ours (kind AUTOMATIC).
 * A person can't type one of these in a single burst.
 */
const E = '\u001b';
/**
 * A cursor position report (`ESC [ row ; col R`). Shift/Ctrl+F3 send the very same bytes (`ESC [ 1 ; 2 R`),
 * so it counts as automatic only while the program has asked for one (`ESC [ 6 n`).
 */
const CPR = new RegExp(`^${E}\\[\\??\\d+;\\d+R$`);
const AUTOMATIC = [
  `^${E}\\[[?>=]?[\\d;]*c$`, // DA1/DA2/DA3
  `^${E}\\[\\??[\\d;]*\\$y$`, // DECRQM
  `^${E}\\[\\d*n$`, // DSR status
  `^${E}\\[[IO]$`, // focus in/out
  `^${E}P[\\s\\S]*${E}\\\\$`, // DCS replies (XTVERSION, DECRQSS)
  `^${E}\\][\\s\\S]*(?:\u0007|${E}\\\\)$`, // OSC replies (colors)
  `^${E}\\[\\?[\\d;]*u$`, // kitty keyboard flags
  `^${E}\\[[\\d;]*t$`, // window reports
].map((src) => new RegExp(src));

export function isCursorReport(data: string): boolean {
  return CPR.test(data);
}

/** `cprPending`: the program asked for the cursor position and xterm hasn't answered yet. */
export function isAutomaticReply(data: string, cprPending = false): boolean {
  if (!data.startsWith(E)) return false;
  if (CPR.test(data)) return cprPending;
  return AUTOMATIC.some((r) => r.test(data));
}

/** Ctrl + a printable key, as a legacy terminal sends it; null when there's no such control code. */
export function ctrlChar(ch: string): string | null {
  if (ch.length !== 1) return null;
  const c = ch.toLowerCase().charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
  const special: Record<string, string> = {
    '@': '\x00',
    '[': '\x1b',
    '\\': '\x1c',
    ']': '\x1d',
    '^': '\x1e',
    _: '\x1f',
    ' ': '\x00',
    '?': '\x7f',
  };
  return special[ch] ?? null;
}

/** Ctrl + a key as a `term.keys` name (only letters have one). */
export function ctrlKeyName(ch: string): string | null {
  return /^[a-z]$/i.test(ch) ? `ctrl+${ch.toLowerCase()}` : null;
}
