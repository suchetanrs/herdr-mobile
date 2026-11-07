// @vitest-environment jsdom
import type { HistoryMark, HistoryRow, TermHistoryPage } from '@herdr-mobile/protocol';
import { describe, expect, it } from 'vitest';
import { type HistoryChange, HistoryModel, OLDER_PAGE } from './history';
import { HistoryView, rowElement, styleCss } from './historyView';

/** The bridge's history: row n says "line n". */
const row = (n: number): HistoryRow => ({ t: `line ${n}` });
function bridgePage(epoch: number, from: number, to: number, lo: number, end: number): TermHistoryPage {
  const rows: HistoryRow[] = [];
  for (let n = from; n < to; n++) rows.push(row(n));
  const p: TermHistoryPage = {
    t: 'term.history.page',
    req: 1,
    stream: 1,
    v: 1,
    epoch,
    start: from,
    rows,
    styles: [[-1, -1, 0]],
    older: from - lo,
    end,
  };
  if (from === lo) p.edge = 'start';
  return p;
}
const serve = (m: HistoryModel, lo: number, end: number) => {
  const req = m.olderRequest();
  if (!req) return null;
  const to = req.cursor.line;
  return m.page('older', bridgePage(req.cursor.epoch, Math.max(lo, to - req.limit), to, lo, end), null);
};
const numbers = (m: HistoryModel) => m.allRows().map((r) => Number(r.t.slice(5)));
const contiguous = (ns: number[]) => ns.every((n, i) => i === 0 || n === (ns[i - 1] ?? 0) + 1);

const mark = (end: number, kept: number, epoch = 1): HistoryMark => ({ epoch, end, kept, alt: false });

describe('HistoryModel', () => {
  it('pages older rows by cursor up to the first row, in order, with no gaps or doubles', () => {
    const m = new HistoryModel();
    // Snapshot: 20000 rows held, this xterm got the latest 200 of them.
    m.attach(mark(20_000, 20_000), 200, 0);
    const s = m.sync(200, 0);
    expect(s.copy).toEqual([19_800, 20_000]);
    m.appendLocal(
      19_800,
      Array.from({ length: 200 }, (_, i) => row(19_800 + i)),
      [[-1, -1, 0]],
    );
    expect(m.olderAvailable).toBe(4800); // the cap (5000) less what's shown
    let pages = 0;
    while (serve(m, 0, 20_000)) pages++;
    expect(pages).toBe(Math.ceil(4800 / OLDER_PAGE));
    expect(m.rows).toBe(5000);
    const ns = numbers(m);
    expect(ns[0]).toBe(15_000);
    expect(ns.at(-1)).toBe(19_999);
    expect(contiguous(ns)).toBe(true);
    expect(m.topEdge).toBe('cap');
  });

  it('stops at the bridge oldest row and says why', () => {
    const m = new HistoryModel();
    m.attach(mark(1000, 700), 0, 0);
    while (serve(m, 300, 1000));
    expect(m.start).toBe(300);
    expect(numbers(m)).toEqual(Array.from({ length: 700 }, (_, i) => 300 + i));
    expect(m.topEdge).toBe('start');
    expect(m.olderRequest()).toBeNull();
  });

  it('one page at a time, and a page that no longer fits (or of another epoch) is dropped', () => {
    const m = new HistoryModel();
    m.attach(mark(1000, 1000), 0, 0);
    const req = m.olderRequest();
    expect(req).toMatchObject({ cursor: { epoch: 1, line: 1000 }, dir: 'older', limit: OLDER_PAGE });
    expect(m.olderRequest()).toBeNull();
    expect(m.page('older', bridgePage(2, 700, 1000, 0, 1000), null)).toEqual([]);
    expect(m.rows).toBe(0);
    m.olderRequest();
    expect(m.page('older', bridgePage(1, 600, 900, 0, 1000), null)).toEqual([]);
    m.olderRequest();
    expect(m.page('older', bridgePage(1, 700, 1000, 0, 1000), null)).toHaveLength(1);
    expect(m.start).toBe(700);
  });

  it('rows that scroll off are copied from xterm while it has them, else asked of the bridge as newer rows', () => {
    const m = new HistoryModel();
    m.attach(mark(100, 100), 0, 0);
    // 10 rows scrolled off: still in xterm's scrollback.
    expect(m.sync(10, 0).copy).toEqual([100, 110]);
    m.appendLocal(
      100,
      Array.from({ length: 10 }, (_, i) => row(100 + i)),
      [[-1, -1, 0]],
    );
    // A burst: xterm (1000 rows of scrollback) trimmed 2000 rows; its row 0 is now absolute 2100.
    const s = m.sync(1000, 2000);
    expect(s.copy).toBeUndefined();
    expect(s.request).toEqual({ cursor: { epoch: 1, line: 110 }, dir: 'newer', limit: 1000 });
    // Only one newer request at a time.
    expect(m.sync(1000, 2000).request).toBeUndefined();
    // The bridge is ahead of this xterm: never past what left its screen (3100).
    const local = m.local(1000, 2000);
    expect(local).toEqual({ lo: 2100, hi: 3100 });
    m.page('newer', bridgePage(1, 110, 1110, 0, 3200), local);
    expect(m.end).toBe(1110);
    m.page('newer', bridgePage(1, 1110, 3200, 0, 3200), local);
    expect(m.end).toBe(3100);
    expect(contiguous(numbers(m))).toBe(true);
    expect(m.sync(1000, 2000)).toEqual({ changes: [] });
  });

  it('a burst the bridge no longer holds starts over at its oldest row', () => {
    const m = new HistoryModel();
    m.attach(mark(100, 100), 0, 0);
    const s = m.sync(1000, 9000);
    expect(s.request?.cursor.line).toBe(100);
    const changes = m.page('newer', bridgePage(1, 4000, 5000, 4000, 10_100), m.local(1000, 9000));
    expect(changes[0]).toEqual({ kind: 'clear' });
    expect(m.start).toBe(4000);
    expect(m.topEdge).toBe('trimmed');
  });

  it('rows coming back onto a taller screen leave the history', () => {
    const m = new HistoryModel();
    m.attach(mark(50, 50), 50, 0);
    m.appendLocal(
      0,
      Array.from({ length: 50 }, (_, i) => row(i)),
      [[-1, -1, 0]],
    );
    expect(m.sync(45, 0).changes).toEqual([{ kind: 'trimBack', count: 5 }]);
    expect(m.end).toBe(45);
    expect(numbers(m).at(-1)).toBe(44);
  });

  it('keeps what it shows across a resync of the same epoch, starts over on a new one', () => {
    const m = new HistoryModel();
    m.attach(mark(100, 100), 10, 0);
    m.appendLocal(
      90,
      Array.from({ length: 10 }, (_, i) => row(90 + i)),
      [[-1, -1, 0]],
    );
    m.detach();
    expect(m.attach(mark(120, 120), 10, 0)).toEqual([]);
    expect(m.sync(10, 0).request).toMatchObject({ cursor: { line: 100 }, dir: 'newer' });
    m.detach();
    expect(m.attach(mark(130, 130, 2), 10, 0)).toEqual([{ kind: 'clear' }]);
    expect(m.rows).toBe(0);
    expect(m.start).toBe(120);
  });

  it('caps what it keeps: live rows past the cap drop the oldest', () => {
    const m = new HistoryModel(100);
    m.attach(mark(0, 0), 0, 0);
    const changes: HistoryChange[] = [];
    for (let i = 0; i < 15; i++) {
      m.sync((i + 1) * 10, 0);
      changes.push(
        ...m.appendLocal(
          i * 10,
          Array.from({ length: 10 }, (_, k) => row(i * 10 + k)),
          [[-1, -1, 0]],
        ),
      );
    }
    expect(m.rows).toBe(100);
    expect(numbers(m)[0]).toBe(50);
    expect(changes.filter((c) => c.kind === 'trimFront')).toHaveLength(5);
  });

  it('text() joins soft-wrapped rows', () => {
    const m = new HistoryModel();
    m.attach(mark(3, 3), 3, 0);
    m.appendLocal(0, [{ t: 'abc' }, { t: 'def', w: 1 }, { t: 'g' }], [[-1, -1, 0]]);
    expect(m.text()).toEqual(['abcdef', 'g']);
  });
});

describe('HistoryView', () => {
  const rowsOf = (v: HistoryView) => [...v.el.querySelectorAll('.th-row')].map((r) => r.textContent);
  const reserved = (v: HistoryView) => Number(v.el.querySelector<HTMLElement>('.th-spacer')?.style.getPropertyValue('--rows') || 0);

  it('prepends older pages into the reserved space: rows shown + rows reserved stay the same (nothing below moves)', () => {
    const m = new HistoryModel();
    const v = new HistoryView();
    v.apply(m.attach(mark(2000, 2000), 100, 0));
    m.sync(100, 0);
    v.apply(
      m.appendLocal(
        1900,
        Array.from({ length: 100 }, (_, i) => row(1900 + i)),
        [[-1, -1, 0]],
      ),
    );
    v.setReserved(m.olderAvailable);
    const total = () => rowsOf(v).length + reserved(v);
    const before = total();
    expect(before).toBe(2000);
    for (let i = 0; i < 3; i++) {
      v.apply(serve(m, 0, 2000) ?? []);
      v.setReserved(m.olderAvailable);
      expect(total()).toBe(before);
    }
    const shown = rowsOf(v);
    expect(shown[0]).toBe('line 1000');
    expect(shown.at(-1)).toBe('line 1999');
    v.setStatus(false, m.topEdge, m.olderAvailable > 0);
    expect(v.statusElement.textContent).toBe('Loading earlier…');
  });

  it('says where history starts, and why it ends early', () => {
    const v = new HistoryView();
    v.setStatus(false, 'start', false);
    expect(v.statusElement.textContent).toMatch(/^Start of history/);
    v.setStatus(false, 'cap', false);
    expect(v.statusElement.textContent).toMatch(/latest lines/);
    v.setStatus(true, null, true);
    expect(v.statusElement.dataset.state).toBe('loading');
  });

  it('appends small batches into the last block and trims from either end', () => {
    const v = new HistoryView();
    const chunk = (start: number, n: number) => ({ start, rows: Array.from({ length: n }, (_, i) => row(start + i)), styles: [] });
    v.apply([
      { kind: 'append', chunk: chunk(0, 10) },
      { kind: 'append', chunk: chunk(10, 5) },
    ]);
    expect(v.el.querySelectorAll('.th-chunk')).toHaveLength(1);
    v.apply([
      { kind: 'trimFront', count: 3 },
      { kind: 'trimBack', count: 2 },
    ]);
    expect(rowsOf(v)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${3 + i}`));
    v.apply([{ kind: 'clear' }]);
    expect(rowsOf(v)).toEqual([]);
  });

  it('draws styles: palette, 256 colors, truecolor, inverse, bold, dim and decorations', () => {
    expect(styleCss([-1, -1, 0])).toBe('');
    expect(styleCss([1, -1, 0])).toBe('color:var(--th-c1)');
    expect(styleCss([196, -1, 0])).toBe('color:#ff0000');
    expect(styleCss([0x1000000 | 0x010203, 4, 1])).toBe('color:#010203;background:var(--th-c4);font-weight:bold');
    expect(styleCss([-1, -1, 32])).toBe('color:var(--th-bg);background:var(--th-fg)');
    expect(styleCss([2, -1, 2 | 8 | 128])).toBe('color:var(--th-c2);opacity:.5;text-decoration:underline line-through');
    const el = rowElement({ t: 'ab cd', s: [2, 1, 1, 0, 2, 2] }, ['', 'color:red', 'font-weight:bold']);
    expect(el.innerHTML).toBe('<span style="color: red;">ab</span> <span style="font-weight: bold;">cd</span>');
  });
});
