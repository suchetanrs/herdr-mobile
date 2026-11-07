// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePrompt, type Step } from '../terminal/prompt';
import { sampleWorld } from '../test/fixtures';
import { renderWith } from '../test/render';
import { ApproveBar } from './ApproveBar';

afterEach(cleanup);

const shot = (name: string, cols = 200) =>
  parsePrompt({
    lines: fs.readFileSync(path.join(__dirname, `../terminal/fixtures/${name}.txt`), 'utf8').split('\n'),
    cols,
  });

function bar(name: string, extra: { inline?: boolean; onOpen?: () => void } = {}) {
  const onSteps = vi.fn(async (_: Step[]) => {});
  renderWith(<ApproveBar prompt={shot(name)} onSteps={onSteps} {...extra} />, sampleWorld());
  return onSteps;
}
const button = (text: string) => screen.getByText(text).closest('button') as HTMLButtonElement;

describe('ApproveBar with real Claude Code questions', () => {
  it('shows the full question, every option with its description, and the steps', () => {
    bar('ask-multi-q1');
    expect(
      screen.getByText(/and a migration path from the existing MySQL 5\.7 cluster that the warehouse team still runs\?$/),
    ).toBeTruthy();
    expect(screen.getByText('Upgrade to 8.0 in place; least work now, least headroom later')).toBeTruthy();
    expect(screen.getByText('Type something')).toBeTruthy();
    expect(screen.getByText('Chat about this')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Questions' }).textContent?.replace(/\s/g, '')).toBe('DatabaseFeaturesNameSubmit');
    // Nothing checked: the first (the cursor's) is the white one.
    expect(button('PostgreSQL').className).toContain('primary');
    expect(button('CockroachDB').className).not.toContain('primary');
  });

  it('the white one is the answer already checked, even with the cursor elsewhere', () => {
    bar('ask-multi-q1-back');
    expect(button('CockroachDB').className).toContain('primary');
    expect(button('PostgreSQL').className).not.toContain('primary');
    // The terminal's cursor still shows.
    expect(button('PostgreSQL').className).toContain('cursor');
  });

  it('a pick presses its number', async () => {
    const onSteps = bar('ask-multi-q1');
    await act(async () => fireEvent.click(button('Keep MySQL')));
    expect(onSteps).toHaveBeenCalledWith([{ keys: ['3'] }]);
  });

  it('"Type something" opens a text field; sending types it into Claude\'s field and picks it', async () => {
    const onSteps = bar('ask-multi-q1');
    // Checked after React's handler (on its root) but still inside the tap's own click: iOS raises the keyboard
    // only for a focus made there, not after a later render (the old autoFocus).
    let focusedInClick = false;
    const onDocClick = () => {
      focusedInClick = document.activeElement?.getAttribute('aria-label') === 'Your answer';
    };
    document.addEventListener('click', onDocClick);
    fireEvent.click(button('Type something'));
    document.removeEventListener('click', onDocClick);
    expect(focusedInClick).toBe(true);
    const input = screen.getByLabelText('Your answer');
    fireEvent.change(input, { target: { value: '  use 2 dbs ' } });
    await act(async () => fireEvent.submit(input.closest('form') as HTMLFormElement));
    expect(onSteps).toHaveBeenCalledWith([{ keys: ['4'] }, { keys: ['ctrl+u'] }, { paste: 'use 2 dbs' }, { keys: ['enter'] }]);
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });

  it('multi-select: boxes show the ticks, a tap toggles, Next moves on, typed text is prefilled', async () => {
    const onSteps = bar('ask-multi-q2-other-typed');
    expect(button('Search').getAttribute('aria-pressed')).toBe('true');
    expect(button('Barcode scan').getAttribute('aria-pressed')).toBe('false');
    expect(button('Search').className).toContain('primary');
    expect(button('qr codes')).toBeTruthy();
    await act(async () => fireEvent.click(button('Barcode scan')));
    expect(onSteps).toHaveBeenLastCalledWith([{ keys: ['2'] }]);
    await act(async () => fireEvent.click(button('Next')));
    expect(onSteps).toHaveBeenLastCalledWith([{ keys: ['down', 'enter'] }]);
    fireEvent.click(button('qr codes'));
    expect((screen.getByLabelText('Your answer') as HTMLInputElement).value).toBe('qr codes');
  });

  it('the review step lists the answers', () => {
    bar('ask-multi-submit');
    expect(screen.getByText('Ready to submit your answers?')).toBeTruthy();
    expect(screen.getByText('→ Search, CSV export, qr codes')).toBeTruthy();
    expect(button('Submit answers').className).toContain('primary');
  });

  it('a permission menu shows what it is about and its long options in full', () => {
    const onSteps = vi.fn(async () => {});
    renderWith(<ApproveBar prompt={shot('perm-narrow-bash', 72)} onSteps={onSteps} />, sampleWorld());
    expect(screen.getByText(/touch perm-test\.txt/)).toBeTruthy();
    expect(screen.getByText(/data\/q-runs\/r2 from this project$/)).toBeTruthy();
  });

  it('inline (spaces list): full question, no descriptions, "Type something" opens the agent', () => {
    const onOpen = vi.fn();
    const onSteps = bar('ask-multi-q1', { inline: true, onOpen });
    expect(screen.getByText(/the warehouse team still runs\?$/)).toBeTruthy();
    expect(screen.queryByText('Upgrade to 8.0 in place; least work now, least headroom later')).toBeNull();
    fireEvent.click(button('Type something'));
    expect(onOpen).toHaveBeenCalled();
    expect(onSteps).not.toHaveBeenCalled();
  });
});
