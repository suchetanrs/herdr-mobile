import { describe, expect, it } from 'vitest';
import { ctrlChar, ctrlKeyName, isAutomaticReply } from './input';

describe('terminal input', () => {
  it("tells the emulator's own replies from typing", () => {
    for (const r of [
      '\x1b[?1;2c',
      '\x1b[>0;276;0c',
      '\x1b[I',
      '\x1b[O',
      '\x1b]11;rgb:1717/1919/1d1d\x1b\\',
      '\x1bP>|xterm\x1b\\',
      '\x1b[?2004;1$y',
    ]) {
      expect(isAutomaticReply(r)).toBe(true);
    }
    for (const k of ['a', '\r', '\x1b', '\x1b[A', '\x1bOA', '\x03', 'hello', '\x1b[3~']) expect(isAutomaticReply(k)).toBe(false);
  });

  it('drops a cursor report only when the program asked for one (Shift+F3 sends the same bytes)', () => {
    expect(isAutomaticReply('\x1b[12;40R', true)).toBe(true);
    expect(isAutomaticReply('\x1b[12;40R')).toBe(false);
    expect(isAutomaticReply('\x1b[1;2R', false)).toBe(false);
    expect(isAutomaticReply('\x1b[1;5R')).toBe(false);
  });

  it('maps a sticky ctrl onto keys', () => {
    expect(ctrlChar('c')).toBe('\x03');
    expect(ctrlChar('C')).toBe('\x03');
    expect(ctrlChar('[')).toBe('\x1b');
    expect(ctrlChar('1')).toBeNull();
    expect(ctrlKeyName('R')).toBe('ctrl+r');
    expect(ctrlKeyName('/')).toBeNull();
  });
});
