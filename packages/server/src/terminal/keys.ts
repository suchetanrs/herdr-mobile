import { TERMINAL_ANSWER_KEYS } from '@herdr-mobile/protocol';

/** Terminal modes that change what a key sends (read from the screen mirror). */
export interface KeyModes {
  /** DECCKM: arrows/home/end send SS3 (`ESC O A`) instead of CSI. */
  applicationCursorKeys: boolean;
  /** DEC mode 2004: the program wants pastes wrapped in `ESC[200~ ... ESC[201~`. */
  bracketedPaste?: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const ESCAPES = /[\x1b\x80-\x9f]/g;

/**
 * A paste as a terminal sends one (herdr-core input.rs `paste`): bracketed when asked, and unable to
 * end early. Every ESC and C1 control (U+0080-U+009F, e.g. CSI) is dropped from the text, not just
 * whole `ESC[201~` terminators: removing those in one pass lets `ESC[20ESC[201~1~` reassemble into
 * one (core input.rs has the same gap), and outside a bracket an escape would act as a key anyway.
 */
export function encodePaste(text: string, bracketed: boolean): string {
  const body = text.replaceAll('\x1b[201~', '').replace(ESCAPES, '');
  return bracketed ? `\x1b[200~${body}\x1b[201~` : body;
}

const FIXED: Record<string, string> = {
  enter: '\r',
  return: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  backspace: '\x7f',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  insert: '\x1b[2~',
  pageup: '\x1b[5~',
  pgup: '\x1b[5~',
  pagedown: '\x1b[6~',
  pgdn: '\x1b[6~',
  space: ' ',
};

const CURSOR: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };

export class KeyError extends Error {
  constructor(readonly key: string) {
    super(`unknown key ${JSON.stringify(key)} (try enter, esc, tab, shift+tab, up, ctrl+c, y)`);
    this.name = 'KeyError';
  }
}

/**
 * One key name -> the bytes a legacy (xterm-style) terminal sends for it, the
 * same encoding xterm.js uses for the person's own typing, so quick keys and the
 * keyboard never disagree.
 */
export function encodeKey(name: string, modes: KeyModes): string {
  const key = name.length === 1 ? name : name.toLowerCase();
  const fixed = FIXED[key];
  if (fixed !== undefined) return fixed;
  const cursor = CURSOR[key];
  if (cursor !== undefined) return modes.applicationCursorKeys ? `\x1bO${cursor}` : `\x1b[${cursor}`;
  const ctrl = /^(?:ctrl|control)\+([a-z])$/.exec(key);
  if (ctrl?.[1]) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) return key;
  }
  throw new KeyError(name);
}

export function encodeKeys(names: readonly string[], modes: KeyModes): string {
  return names.map((n) => encodeKey(n, modes)).join('');
}

const ANSWER = new Set(TERMINAL_ANSWER_KEYS);

/** True when every key is one a quick answer may press. */
export function isAnswerKeys(names: readonly string[]): boolean {
  return names.length > 0 && names.every((n) => ANSWER.has(n.length === 1 ? n : n.toLowerCase()));
}
