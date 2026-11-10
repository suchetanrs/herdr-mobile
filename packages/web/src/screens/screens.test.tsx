// @vitest-environment jsdom
import type { SpaceView, TerminalView } from '@herdr-mobile/protocol';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApproveBar } from '../components/ApproveBar';
import { Composer } from '../components/Composer';
import { KeyBar, withCtrl } from '../components/KeyBar';
import { StatusGlyph } from '../components/Status';
import { drafts } from '../lib/drafts';
import { sampleWorld, term } from '../test/fixtures';
import { renderWith } from '../test/render';
import { SpaceScreen } from './SpaceScreen';
import { SpacesScreen } from './SpacesScreen';

afterEach(cleanup);

describe('Spaces screen', () => {
  it('files spaces by what they need and lists the agents that put them there', () => {
    renderWith(<SpacesScreen />, sampleWorld());
    const heads = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(heads).toEqual(['Needs you1', 'Done1', 'Idle2']);
    const beta = screen.getByText('beta').closest('.space-card') as HTMLElement;
    expect(within(beta).getAllByText('Needs you').length).toBeGreaterThan(0);
    expect(within(beta).getByText('deploy')).toBeTruthy();
    expect(screen.getByText(/5 agents/)).toBeTruthy();
    expect(screen.getByText(/2 need you/)).toBeTruthy();
  });

  it('updates live: a status patch moves a space without a reload', () => {
    const { services } = renderWith(<SpacesScreen />, sampleWorld());
    act(() => {
      services.store.handle({
        t: 'patch',
        seq: 2,
        ops: [
          { op: 'terminal', value: term('t5', { spaceId: 'spC', tabId: 'tbC1', status: 'working', word: 'working' }) },
          { op: 'space', value: { ...sampleWorld().spaces.spC, status: 'working' } as never },
        ],
      });
    });
    const working = screen.getByText('Working').closest('section') as HTMLElement;
    expect(within(working).getByText('gamma')).toBeTruthy();
    act(() => {
      services.store.handle({
        t: 'patch',
        seq: 3,
        ops: [
          { op: 'delSpace', id: 'spD' },
          { op: 'spaceOrder', value: ['spA', 'spB', 'spC'] },
        ],
      });
    });
    expect(screen.queryByText('empty')).toBeNull();
  });
});

describe('Spaces screen extras', () => {
  it('puts pinned agents first, chips live sub-agents, marks drafts, lists idle spaces compactly', () => {
    localStorage.clear();
    drafts.set('t3', 'half a thought');
    const w = sampleWorld();
    w.terminals.t3 = { ...(w.terminals.t3 as TerminalView), pinned: true };
    w.terminals.t1 = { ...(w.terminals.t1 as TerminalView), pinned: true };
    const { container } = renderWith(<SpacesScreen />, w);
    const heads = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.replace(/\s+/g, ''));
    expect(heads[0]).toBe('Pinned2');
    const [lead, done] = [...container.querySelectorAll('.list-card .agent-line')] as HTMLElement[];
    // t1 has a live sub-agent, blocked: "+1" in the blocked color.
    expect(lead?.querySelector('.sub-chip')?.textContent).toBe('+1');
    expect(lead?.querySelector('.sub-chip')?.className).toContain('t-blocked');
    expect(done?.textContent).toContain('alpha');
    expect(done?.querySelector('.draft-mark')).toBeTruthy();
    // Idle spaces: one compact line each, no card.
    expect([...container.querySelectorAll('.space-line-name')].map((n) => n.textContent)).toEqual(['gamma', 'empty']);
    drafts.set('t3', '');
  });

  it('re-renders lists for what they show, not for terminal resizes or pings (REVIEW P2-16)', () => {
    let renders = 0;
    const { services } = renderWith(
      <Profiler id="spaces" onRender={() => renders++}>
        <SpacesScreen embedded />
      </Profiler>,
      sampleWorld(),
    );
    const before = renders;
    act(() => {
      // The desktop resized its window: every pane's size changes, nothing a list shows does.
      services.store.handle({ t: 'patch', seq: 2, ops: [{ op: 'terminal', value: { ...sampleWorld().terminals.t1, cols: 99 } as never }] });
      services.store.setConn({ rttMs: 42 });
    });
    const t1 = services.store.getState().world.terminals.t1;
    expect(t1?.cols).toBe(99);
    expect(renders).toBe(before);
  });
});

describe('Space screen', () => {
  it('shows its tabs and nests sub-agents under their parent', () => {
    const { container } = renderWith(<SpaceScreen spaceId="spA" />, sampleWorld());
    const names = [...container.querySelectorAll('.agent-row-name')].map((n) => n.textContent);
    expect(names).toEqual(['fix the login bug', 'reviewer', 'bash', 'review']);
    expect(container.querySelector('.agent-row.sub .tree')).toBeTruthy();
    // Each name once (REVIEW P2-17): tab 1 has two terminals, so a header; tab 2 is one terminal, so one row
    // carrying the tab's number, and no pill strip for two tabs.
    expect([...container.querySelectorAll('.group-head')].map((h) => h.textContent?.replace(/\s+/g, ''))).toEqual(['12terminals']);
    expect(screen.getAllByText('fix the login bug')).toHaveLength(1);
    expect(container.querySelectorAll('.tab-pill')).toHaveLength(0);
    const review = screen.getByText('review').closest('.agent-row') as HTMLElement;
    expect(review.querySelector('.tab-no')?.textContent).toBe('2');
    expect(screen.getAllByText('review')).toHaveLength(1);
  });

  it("a folder icon opens the space's files (local spaces with a folder only)", () => {
    renderWith(<SpaceScreen spaceId="spA" />, sampleWorld());
    fireEvent.click(screen.getByRole('button', { name: 'Files in this space' }));
    expect(window.location.hash).toBe('#/s/spA/files');
    cleanup();
    const w = sampleWorld();
    w.spaces.spD = { ...(w.spaces.spD as SpaceView), folder: '' };
    renderWith(<SpaceScreen spaceId="spD" />, w);
    expect(screen.queryByRole('button', { name: 'Files in this space' })).toBeNull();
  });
});

describe('Claude accounts (my-agents parity)', () => {
  it('shows "name, plan" on top-level agent rows only, live', () => {
    const w = sampleWorld();
    w.terminals.t1 = { ...(w.terminals.t1 as TerminalView), account: { name: 'alice', plan: 'pro' } };
    w.terminals.t9 = { ...(w.terminals.t9 as TerminalView), account: { name: 'alice', plan: 'pro' } };
    const { container, services } = renderWith(<SpaceScreen spaceId="spA" />, w);
    const accounts = [...container.querySelectorAll('.agent-row .account')];
    expect(accounts.map((a) => a.textContent)).toEqual(['alice, pro']);
    // Before the age, like the desktop list.
    expect(accounts[0]?.nextElementSibling?.className).toBe('age');
    act(() => {
      services.store.handle({
        t: 'patch',
        seq: 2,
        ops: [{ op: 'terminal', value: { ...(w.terminals.t3 as TerminalView), account: { name: 'bob', plan: '' } } }],
      });
    });
    expect([...container.querySelectorAll('.agent-row .account')].map((a) => a.textContent)).toEqual(['alice, pro', 'bob']);
  });
});

describe('pieces', () => {
  it("draws Herdr's status marks", () => {
    const { container, rerender } = renderWith(<StatusGlyph status="working" />, sampleWorld());
    expect(container.querySelector('.st-working .spin')).toBeTruthy();
    rerender(<StatusGlyph status="blocked" />);
    expect(screen.getByText('Needs you')).toBeTruthy();
    rerender(<StatusGlyph status="blocked" compact />);
    expect(screen.getByText('!')).toBeTruthy();
    rerender(<StatusGlyph status="done" />);
    expect(container.querySelector('.st-done')).toBeTruthy();
    rerender(<StatusGlyph status={null} />);
    expect(container.querySelector('.st')).toBeNull();
  });

  it('keeps a draft per agent', () => {
    localStorage.clear();
    vi.useFakeTimers();
    const onSend = vi.fn(async () => {});
    const { rerender } = renderWith(<Composer terminalId="t1" placeholder="Message" onSend={onSend} coarse />, sampleWorld());
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'half a thought' } });
    act(() => vi.advanceTimersByTime(300));
    rerender(<Composer terminalId="t3" placeholder="Message" onSend={onSend} coarse />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    rerender(<Composer terminalId="t1" placeholder="Message" onSend={onSend} coarse />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('half a thought');
    vi.useRealTimers();
  });

  it('answers a blocked prompt with one tap on the option the screen offers', async () => {
    const onSteps = vi.fn(async () => {});
    renderWith(
      <ApproveBar
        prompt={{
          kind: 'menu',
          question: 'Do you want to proceed?',
          cursor: 0,
          options: [
            { key: '1', label: 'Yes' },
            { key: '2', label: 'No, and tell Claude' },
          ],
        }}
        onSteps={onSteps}
      />,
      sampleWorld(),
    );
    expect(screen.getByText('Do you want to proceed?')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText('No, and tell Claude')));
    expect(onSteps).toHaveBeenCalledWith([{ keys: ['2'] }]);
  });

  it('offers no guessed answers while the screen is still being read', () => {
    renderWith(<ApproveBar prompt={null} onSteps={async () => {}} reading />, sampleWorld());
    expect(screen.getByText('Reading the question…')).toBeTruthy();
    expect(screen.queryByText('Yes')).toBeNull();
    expect(screen.getByText('Dismiss')).toBeTruthy();
  });

  it('has a sticky ctrl: tap for one key, double tap to lock', () => {
    const onCtrl = vi.fn();
    const onKey = vi.fn();
    renderWith(<KeyBar onKey={onKey} ctrl="off" onCtrl={onCtrl} />, sampleWorld());
    fireEvent.click(screen.getByText('ctrl'));
    fireEvent.click(screen.getByText('ctrl'));
    expect(onCtrl.mock.calls.map((c) => c[0])).toEqual(['once', 'locked']);
    // Keys fire when a tap lifts (a pan across the bar never presses one: KeyBar.test.tsx).
    fireEvent.pointerDown(screen.getByLabelText('Escape'), { isPrimary: true, pointerId: 1 });
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.pointerUp(screen.getByLabelText('Escape'), { isPrimary: true, pointerId: 1 });
    expect(onKey).toHaveBeenCalledWith('esc');
    expect(withCtrl('c', 'once')).toBe('ctrl+c');
    expect(withCtrl('up', 'locked')).toBe('up');
    expect(withCtrl('c', 'off')).toBe('c');
  });
});
