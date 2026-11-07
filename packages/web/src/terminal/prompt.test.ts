import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { highlighted, nextSteps, otherSteps, parsePrompt, pickSteps, tabSteps, typingIntoOther } from './prompt';

/** A real screen, captured with `hc read` from Claude Code 2.1.319 (fixtures/README). */
function shot(name: string): string[] {
  return fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}.txt`, import.meta.url)), 'utf8').split('\n');
}
const wide = (name: string) => parsePrompt({ lines: shot(name), cols: 200 });
const narrow = (name: string) => parsePrompt({ lines: shot(name), cols: 72 });

const DB_Q =
  'Which database should the new inventory service use for its primary store, considering that we need strong consistency for stock counts, cheap horizontal reads for the catalog pages, and a migration path from the existing MySQL 5.7 cluster that the warehouse team still runs?';

describe('parsePrompt: AskUserQuestion', () => {
  it('reads the whole wrapped question, every option with its description, and the steps', () => {
    const p = wide('ask-multi-q1');
    expect(p?.kind).toBe('ask');
    expect(p?.question).toBe(DB_Q);
    expect(p?.options.map((o) => o.label)).toEqual(['PostgreSQL', 'CockroachDB', 'Keep MySQL', 'Type something', 'Chat about this']);
    expect(p?.options[0]?.description).toBe(
      'Strong consistency, rich SQL, logical replication from MySQL via a one-off migration job; the team already knows it well',
    );
    expect(p?.options[3]).toEqual({ key: '4', label: 'Type something', other: true });
    expect(p?.options[4]?.extra).toBe(true);
    expect(p?.multi).toBeUndefined();
    expect(p?.cursor).toBe(0);
    expect(p?.tabs).toEqual([
      { label: 'Database', answered: false, submit: false },
      { label: 'Features', answered: false, submit: false },
      { label: 'Name', answered: false, submit: false },
      { label: 'Submit', answered: false, submit: true },
    ]);
    // Plain text can't tell which tab is on screen (it's a background color): see the marks test.
    expect(p?.tab).toBeNull();
  });

  it("follows the terminal's cursor", () => {
    const p = wide('ask-multi-q1-cursor2');
    expect(p?.cursor).toBe(1);
    expect([...highlighted(p as NonNullable<typeof p>)]).toEqual([1]);
  });

  it('marks the answer chosen before (✔) and highlights it, not the cursor row', () => {
    const p = wide('ask-multi-q1-back');
    expect(p?.cursor).toBe(0);
    expect(p?.options[1]).toMatchObject({ label: 'CockroachDB', checked: true });
    expect(p?.options.filter((o) => o.checked)).toHaveLength(1);
    expect(p?.tabs?.map((t) => t.answered)).toEqual([true, true, false, false]);
    expect([...highlighted(p as NonNullable<typeof p>)]).toEqual([1]);
  });

  it('highlights the first option when nothing is checked', () => {
    const p = wide('ask-multi-q3');
    expect(p?.question).toBe('What should the service be called?');
    expect([...highlighted(p as NonNullable<typeof p>)]).toEqual([0]);
  });

  it('reads multi-select: boxes, ticks, the Next row', () => {
    const p = wide('ask-multi-q2-checked');
    expect(p?.multi).toBe(true);
    expect(p?.question).toBe('Which features should the first release include?');
    expect(p?.options.map((o) => [o.label, Boolean(o.checked)])).toEqual([
      ['Search', true],
      ['Barcode scan', false],
      ['CSV export', true],
      ['Type something', false],
      ['Chat about this', false],
    ]);
    expect(p?.options[1]?.description).toBe('Scan items with the phone camera');
    expect(p?.next).toBe('Next');
    expect(p?.cursor).toBe(2);
    expect([...highlighted(p as NonNullable<typeof p>)]).toEqual([0, 2]);
    expect(wide('ask-multi-q2-next')?.cursor).toBe('next');
  });

  it('reads what is typed in "Type something" (and that typing there ticks it)', () => {
    const multi = wide('ask-multi-q2-other-typed');
    expect(multi?.options[3]).toMatchObject({ label: 'Type something', other: true, text: 'qr codes', checked: true });
    expect(typingIntoOther(multi)).toBe(true);
    const single = wide('ask-multi-q1-other-typed');
    expect(single?.options[3]).toMatchObject({ other: true, text: 'v2 db' });
    expect(single?.options[1]?.checked).toBe(true);
    expect(typingIntoOther(single)).toBe(true);
    expect(typingIntoOther(wide('ask-multi-q1-other-cursor'))).toBe(true);
    expect(typingIntoOther(wide('ask-multi-q1'))).toBe(false);
    // Enter on a typed multi-select answer unticks it.
    const enter = narrow('ask-narrow-multi-other-enter')?.options[3];
    expect(enter?.text).toBe('pineapple');
    expect(enter?.checked).toBeUndefined();
  });

  it('reads a narrow terminal (wrapped question) and a single question alone', () => {
    const p = narrow('ask-narrow-multi');
    expect(p?.question).toBe('Which toppings do you want on the pizza that we are ordering for the whole team tonight after the release?');
    expect(p?.options[0]).toMatchObject({ label: 'Mushrooms', description: 'Earthy, and vegetarian friendly for most of the team' });
    expect(p?.next).toBe('Submit');
    expect(p?.tabs?.map((t) => t.label)).toEqual(['Toppings', 'Submit']);
    expect(p?.tab).toBe(0);
    const one = narrow('ask-narrow-single');
    expect(one?.question).toBe('Which size?');
    expect(one?.tabs).toEqual([{ label: 'Size', answered: false, submit: false }]);
    expect(one?.tab).toBe(0);
    expect(one?.options.map((o) => o.label)).toEqual(['Large', 'Medium', 'Type something', 'Chat about this']);
  });

  it('reads the review step: every answer, the warning, Submit / Cancel', () => {
    const p = wide('ask-multi-submit');
    expect(p?.kind).toBe('review');
    expect(p?.tab).toBe(3);
    expect(p?.question).toBe('Ready to submit your answers?');
    expect(p?.review).toEqual([
      { question: DB_Q, answer: 'v2 db' },
      { question: 'Which features should the first release include?', answer: 'Search, CSV export, qr codes' },
      { question: 'What should the service be called?', answer: 'inventory-api' },
    ]);
    expect(p?.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel']);
    const partial = wide('ask-review-unanswered');
    expect(partial?.warning).toBe('You have not answered all questions');
    expect(partial?.review).toEqual([{ question: 'Which pets?', answer: 'Dog, hamster' }]);
  });

  it('tells the tab on screen from its colored background', () => {
    const lines = shot('ask-multi-q2');
    const bar = lines.findIndex((l) => l.includes('☐ Features'));
    const line = lines[bar] ?? '';
    // As Claude Code draws it: " ☐ Features " on a lavender background.
    const at = line.indexOf('☐ Features') - 1;
    const marks = lines.map((_, i) => (i === bar ? ' '.repeat(at) + '#'.repeat(' ☐ Features '.length) : undefined));
    const p = parsePrompt({ lines, marks, cols: 200 });
    expect(p?.tab).toBe(1);
    expect(tabSteps(p as NonNullable<typeof p>, 0)).toEqual([{ keys: ['left'] }]);
    expect(tabSteps(p as NonNullable<typeof p>, 3)).toEqual([{ keys: ['right', 'right'] }]);
  });
});

describe('parsePrompt: permission menus', () => {
  it('reads a narrow permission prompt: question, what it is about, wrapped options in full', () => {
    const p = narrow('perm-narrow-bash');
    expect(p?.kind).toBe('menu');
    expect(p?.question).toBe('Do you want to proceed?');
    expect(p?.detail).toContain('touch perm-test.txt');
    expect(p?.detail?.[0]).toBe('Bash command');
    expect(p?.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and always allow access to /home/user/work/warehouse-inventory/claude-question-captures/data/q-runs/r2 from this project',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No',
    ]);
    expect(p?.cursor).toBe(0);
    expect(p?.tabs).toBeUndefined();
  });

  it('reads a boxed menu, ignores lists that are not menus, and keeps the newest menu', () => {
    const screen = [
      '╭──────────────────────────────────────────╮',
      '│ Bash command                              │',
      '│   rm -rf build                            │',
      '│ Do you want to proceed?                   │',
      '│ ❯ 1. Yes                                  │',
      "│   2. Yes, and don't ask again for rm      │",
      '│   3. No, and tell Claude what to do       │',
      '╰──────────────────────────────────────────╯',
    ];
    const p = parsePrompt(screen);
    expect(p?.question).toBe('Do you want to proceed?');
    expect(p?.options).toEqual([
      { key: '1', label: 'Yes' },
      { key: '2', label: "Yes, and don't ask again for rm" },
      { key: '3', label: 'No, and tell Claude what to do' },
    ]);
    expect(p?.detail).toEqual(['Bash command', 'rm -rf build']);
    expect(parsePrompt(['just some output', '1. a list item'])).toBeNull();
    expect(parsePrompt([...screen, ...Array(80).fill('')])?.options).toHaveLength(3);
    expect(parsePrompt(['1. old', '2. old', 'Pick one', '1. new', '2. newer'])?.options[1]?.label).toBe('newer');
  });

  it('keeps a long option whole (the old reader dropped options over 80 characters)', () => {
    const long = 'Yes, and allow everything under a very long folder name that goes on and on past eighty characters';
    expect(parsePrompt(['Proceed?', '❯ 1. Yes', `  2. ${long}`, '  3. No'])?.options[1]?.label).toBe(long);
  });
});

describe('answer steps', () => {
  it('a single-select pick is its number; a multi-select pick ticks with its number', () => {
    const p = wide('ask-multi-q1');
    expect(pickSteps(p as NonNullable<typeof p>, 1)).toEqual([{ keys: ['2'] }]);
    const m = wide('ask-multi-q2');
    expect(pickSteps(m as NonNullable<typeof m>, 2)).toEqual([{ keys: ['3'] }]);
  });

  it('"Type something", single-select: its number, clear, paste, Enter', () => {
    const p = wide('ask-multi-q1');
    expect(otherSteps(p as NonNullable<typeof p>, 'use 2 dbs')).toEqual([
      { keys: ['4'] },
      { keys: ['ctrl+u'] },
      { paste: 'use 2 dbs' },
      { keys: ['enter'] },
    ]);
  });

  it('"Type something", multi-select: arrows from the cursor, clear, paste, no Enter (it would untick)', () => {
    const p = wide('ask-multi-q2-checked'); // cursor on 3
    expect(otherSteps(p as NonNullable<typeof p>, 'QR')).toEqual([{ keys: ['down'] }, { keys: ['ctrl+u'] }, { paste: 'QR' }]);
    const atNext = wide('ask-multi-q2-next');
    expect(otherSteps(atNext as NonNullable<typeof atNext>, 'QR')[0]).toEqual({ keys: ['up'] });
  });

  it('Next / Submit: down to the row, Enter', () => {
    const p = wide('ask-multi-q2'); // cursor on 1 of 4
    expect(nextSteps(p as NonNullable<typeof p>)).toEqual([{ keys: ['down', 'down', 'down', 'down', 'enter'] }]);
    const atNext = wide('ask-multi-q2-next');
    expect(nextSteps(atNext as NonNullable<typeof atNext>)).toEqual([{ keys: ['enter'] }]);
  });

  it('leaves the free-text field before switching tabs', () => {
    const p = wide('ask-multi-q1-other-typed');
    const withTab = { ...(p as NonNullable<typeof p>), tab: 0 };
    expect(tabSteps(withTab, 1)).toEqual([{ keys: ['up', 'right'] }]);
  });
});
