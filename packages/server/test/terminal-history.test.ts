import { type HistoryRow, historyText } from '@herdr-mobile/protocol';
import { describe, expect, it } from 'vitest';
import { checkCall, PolicyError } from '../src/core/policy.js';
import { type HistoryPage, ScreenMirror } from '../src/terminal/mirror.js';

const numbered = (from: number, to: number) => {
  let s = '';
  for (let i = from; i <= to; i++) s += `line ${i}\r\n`;
  return s;
};

async function page(m: ScreenMirror, epoch: number, line: number, dir: 'older' | 'newer', limit: number): Promise<HistoryPage> {
  const p = await m.history({ epoch, line }, dir, limit);
  if (p === 'stale') throw new Error('stale');
  return p;
}

/** Walks `older` pages from the snapshot's mark to the top, like the web client. */
async function walkUp(m: ScreenMirror, limit: number): Promise<{ rows: HistoryRow[]; pages: number; last: HistoryPage }> {
  const snap = await m.snapshot(0);
  const mark = snap.history;
  if (!mark) throw new Error('no mark');
  let rows: HistoryRow[] = [];
  let line = mark.end;
  let pages = 0;
  let last: HistoryPage | null = null;
  for (;;) {
    const p = await page(m, mark.epoch, line, 'older', limit);
    last = p;
    pages++;
    expect(p.start + p.rows.length).toBe(line);
    rows = [...p.rows, ...rows];
    line = p.start;
    if (p.older === 0) break;
  }
  return { rows, pages, last };
}

describe('terminal history pages (mirror)', () => {
  it('numbers main-buffer rows and pages up to the first row, in order, without gaps or doubles', async () => {
    const m = new ScreenMirror({ cols: 40, rows: 5, scrollback: 10_000 });
    m.write(Buffer.from(numbered(1, 2000)));
    const snap = await m.snapshot(0);
    // 2000 lines + the empty cursor row: 1996 rows above the 5-row screen.
    expect(snap.history).toMatchObject({ epoch: expect.any(Number), end: 1996, kept: 1996, alt: false });
    const { rows, pages, last } = await walkUp(m, 300);
    expect(pages).toBe(7);
    expect(last).toMatchObject({ start: 0, older: 0, edge: 'start' });
    expect(historyText(rows)).toEqual(Array.from({ length: 1996 }, (_, i) => `line ${i + 1}`));
    m.dispose();
  });

  it('keeps numbering through trimming: pages stop at the oldest kept row and say why', async () => {
    const m = new ScreenMirror({ cols: 40, rows: 5, scrollback: 100 });
    m.write(Buffer.from(numbered(1, 1000)));
    const snap = await m.snapshot(0);
    expect(snap.history).toMatchObject({ end: 996, kept: 100 });
    const { rows, last } = await walkUp(m, 30);
    expect(last).toMatchObject({ start: 896, older: 0, edge: 'trimmed' });
    // Absolute row n holds "line n+1": the numbering survived the trimming.
    expect(historyText(rows)).toEqual(Array.from({ length: 100 }, (_, i) => `line ${897 + i}`));
    m.dispose();
  });

  it('newer pages give rows that scrolled off since a cursor, never past the screen', async () => {
    const m = new ScreenMirror({ cols: 40, rows: 5, scrollback: 10_000 });
    m.write(Buffer.from(numbered(1, 20)));
    const mark = (await m.snapshot(0)).history;
    if (!mark) throw new Error('no mark');
    m.write(Buffer.from(numbered(21, 50)));
    const p = await page(m, mark.epoch, mark.end, 'newer', 1000);
    expect(p.start).toBe(mark.end);
    expect(p.end).toBe(46);
    expect(historyText(p.rows)).toEqual(Array.from({ length: 30 }, (_, i) => `line ${17 + i}`));
    const capped = await page(m, mark.epoch, mark.end, 'newer', 7);
    expect(capped.rows).toHaveLength(7);
    m.dispose();
  });

  it('keeps colors and styles of older rows', async () => {
    const m = new ScreenMirror({ cols: 40, rows: 3, scrollback: 100 });
    m.write(Buffer.from('plain\r\n\x1b[31mred\x1b[0m and \x1b[1;38;2;1;2;3mrgb bold\x1b[0m\r\n\x1b[7minv\x1b[0m\r\n\r\n\r\n\r\n'));
    const mark = (await m.snapshot(0)).history;
    if (!mark) throw new Error('no mark');
    const p = await page(m, mark.epoch, mark.end, 'older', 10);
    const [plain, red, inv] = p.rows;
    expect(plain).toEqual({ t: 'plain' });
    expect(red?.t).toBe('red and rgb bold');
    const styleOf = (row: HistoryRow | undefined, i: number) => p.styles[row?.s?.[i * 2 + 1] ?? 0];
    expect(styleOf(red, 0)).toEqual([1, -1, 0]);
    expect(styleOf(red, 1)).toEqual([-1, -1, 0]);
    expect(styleOf(red, 2)).toEqual([0x1000000 | 0x010203, -1, 1]);
    expect(styleOf(inv, 0)).toEqual([-1, -1, 32]);
    m.dispose();
  });

  it('marks soft-wrapped rows and the alternate screen', async () => {
    const m = new ScreenMirror({ cols: 10, rows: 3, scrollback: 100 });
    m.write(Buffer.from(`${'x'.repeat(15)}\r\na\r\nb\r\nc\r\n\x1b[?1049h`));
    const s = await m.snapshot(0);
    expect(s.history?.alt).toBe(true);
    const mark = s.history;
    if (!mark) throw new Error('no mark');
    const p = await page(m, mark.epoch, mark.end, 'older', 10);
    expect(p.rows.slice(0, 2)).toEqual([{ t: 'x'.repeat(10) }, { t: 'xxxxx', w: 1 }]);
    expect(historyText(p.rows)[0]).toBe('x'.repeat(15));
    m.dispose();
  });

  it('a width change or a reset starts a new epoch: old cursors are stale', async () => {
    const m = new ScreenMirror({ cols: 40, rows: 5, scrollback: 100 });
    m.write(Buffer.from(numbered(1, 30)));
    const a = (await m.snapshot(0)).history;
    if (!a) throw new Error('no mark');
    m.resize(40, 6);
    expect((await m.snapshot(0)).history?.epoch).toBe(a.epoch);
    m.resize(50, 6);
    const b = (await m.snapshot(0)).history;
    expect(b?.epoch).toBe(a.epoch + 1);
    expect(await m.history({ epoch: a.epoch, line: a.end }, 'older', 10)).toBe('stale');
    m.reset(50, 6);
    expect((await m.snapshot(0)).history?.epoch).toBe(a.epoch + 2);
    m.dispose();
  });
});

describe('policy: terminal.read', () => {
  it('only as {terminal, lines <= 1000} (a full-screen app read on request)', () => {
    expect(() => checkCall('terminal.read', { terminal: 't3', lines: 1000 })).not.toThrow();
    for (const p of [
      { terminal: 't3' },
      { terminal: 't3', lines: 0 },
      { terminal: 't3', lines: 1001 },
      { terminal: 't3', lines: 10, caller: 't1' },
      { terminal: 3, lines: 10 },
    ])
      expect(() => checkCall('terminal.read', p), JSON.stringify(p)).toThrow(PolicyError);
  });
});
