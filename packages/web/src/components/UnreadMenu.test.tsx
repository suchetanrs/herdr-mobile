// @vitest-environment jsdom
import type { TerminalView } from '@herdr-mobile/protocol';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS } from '../lib/longpress';
import { SpaceScreen } from '../screens/SpaceScreen';
import { sampleWorld } from '../test/fixtures';
import { renderWith } from '../test/render';
import { UnreadMenu } from './UnreadMenu';

beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = '#/space/spA';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function rig() {
  const w = sampleWorld();
  // t6: finished and seen (idle, turn 2) in space A, so it can be marked unread.
  w.terminals.t6 = { ...(w.terminals.t3 as TerminalView), id: 't6', status: 'idle', word: 'idle', turn: 2, seenTurn: 2 };
  const tb = w.tabs.tbA2 as NonNullable<(typeof w.tabs)[string]>;
  w.tabs.tbA2 = { ...tb, panes: [...tb.panes, { id: 'p-t6', terminalId: 't6' }] };
  const r = renderWith(
    <>
      <SpaceScreen spaceId="spA" />
      <UnreadMenu />
    </>,
    w,
  );
  const send = vi.spyOn(r.services.conn, 'send').mockReturnValue(true);
  const row = (id: string) => r.container.querySelector(`[data-press="${id}"]`) as HTMLElement | null;
  const p = (el: Element, type: string, x = 50, y = 50) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }));
  return { ...r, send, row, p };
}

describe('Mark as unread', () => {
  it('only idle agents with a finished turn take a long press', () => {
    const r = rig();
    expect(r.row('t6')).toBeTruthy();
    // t3 is done already, t1 working, t2 a shell.
    expect(r.row('t3')).toBeNull();
    expect(r.row('t1')).toBeNull();
    expect(r.row('t2')).toBeNull();
  });

  it('holding a row opens the menu without opening the agent; the item sends unread', () => {
    const r = rig();
    const row = r.row('t6') as HTMLElement;
    r.p(row, 'pointerdown');
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 50));
    expect(screen.queryByText('Mark as unread')).toBeNull();
    act(() => vi.advanceTimersByTime(60));
    r.p(row, 'pointerup');
    fireEvent.click(row);
    expect(window.location.hash).toBe('#/space/spA');
    fireEvent.click(screen.getByText('Mark as unread'));
    expect(r.send).toHaveBeenCalledWith({ t: 'unread', terminalId: 't6' });
    expect(screen.queryByText('Mark as unread')).toBeNull();
  });

  it('a short tap opens the agent; moving or scrolling is not a long press', () => {
    const r = rig();
    const row = r.row('t6') as HTMLElement;
    r.p(row, 'pointerdown');
    r.p(row, 'pointermove', 50, 80);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 100));
    expect(screen.queryByText('Mark as unread')).toBeNull();
    r.p(row, 'pointerdown');
    act(() => {
      document.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    });
    expect(screen.queryByText('Mark as unread')).toBeNull();
    r.p(row, 'pointerdown');
    r.p(row, 'pointerup');
    fireEvent.click(row);
    expect(window.location.hash).toBe('#/a/t6');
  });

  it('another pane scrolling (a terminal) does not end a press', () => {
    const r = rig();
    const pane = document.createElement('div');
    document.body.append(pane);
    r.p(r.row('t6') as HTMLElement, 'pointerdown');
    act(() => {
      pane.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(screen.getByText('Mark as unread')).toBeTruthy();
    pane.remove();
  });

  it('right-click opens it too; a tap beside it closes it', () => {
    const r = rig();
    fireEvent.contextMenu(r.row('t6') as HTMLElement, { clientX: 40, clientY: 40 });
    expect(screen.getByText('Mark as unread')).toBeTruthy();
    fireEvent.pointerDown(document.querySelector('.unread-backdrop') as HTMLElement);
    expect(screen.queryByText('Mark as unread')).toBeNull();
    expect(r.send).not.toHaveBeenCalled();
  });
});
