// @vitest-environment jsdom
import type { TerminalView } from '@herdr-mobile/protocol';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleWorld } from '../test/fixtures';
import { renderWith } from '../test/render';
import { AgentMenu } from './AgentMenu';
import { ClaudeSettingSheet } from './ClaudeSettingSheet';

type Reply = { status: number; body: unknown };
let calls: Array<{ url: string; method: string; body: unknown }>;
let onGet: (url: string) => Reply;
let onPost: (url: string, body: { value: string }) => Reply;
let releasePost: (() => void) | null;

const MODELS = {
  kind: 'model',
  options: [
    { value: 'Sonnet 5.5', label: 'Sonnet 5.5', detail: 'Most efficient for simpler tasks' },
    { value: 'Haiku 5.5', label: 'Haiku 5.5', detail: 'Fastest for quick answers' },
    { value: 'Haiku 4.5', label: 'Haiku 4.5', detail: 'Fastest for quick answers' },
  ],
  current: 'Haiku 5.5',
};

beforeEach(() => {
  calls = [];
  releasePost = null;
  onGet = () => ({ status: 200, body: MODELS });
  onPost = (_u, b) => ({ status: 200, body: { kind: 'model', value: b.value, message: `Set model to ${b.value} for this session only` } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (method === 'POST') await new Promise<void>((r) => (releasePost = r));
      const r = method === 'POST' ? onPost(url, body) : onGet(url);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const worldWith = (over: Partial<TerminalView> = {}) => {
  const w = sampleWorld();
  w.terminals.t1 = { ...(w.terminals.t1 as TerminalView), word: 'idle', status: 'idle', ...over };
  return w;
};
const rows = () => screen.getAllByRole('radio') as HTMLButtonElement[];

describe('Choose model / effort level', () => {
  it('opens from the ⋯ menu, lists Claude’s models with the one in use ticked', async () => {
    const w = worldWith();
    renderWith(<AgentMenu t={w.terminals.t1 as TerminalView} />, w);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Choose model/ }));
    expect(screen.getByRole('dialog', { name: 'Choose model' })).toBeTruthy();
    expect(screen.getByText('Asking Claude…')).toBeTruthy();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(calls).toEqual([{ url: '/api/agents/t1/claude/model', method: 'GET', body: undefined }]);
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(rows()[0]?.textContent).toContain('Most efficient for simpler tasks');
  });

  it('a tap switches: spinner on that row, then the tick moves, Claude’s confirmation shows, and it closes', async () => {
    const w = worldWith();
    const onClose = vi.fn();
    renderWith(<ClaudeSettingSheet t={w.terminals.t1 as TerminalView} kind="model" onClose={onClose} />, w);
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rows()[2] as HTMLButtonElement);
    await waitFor(() => expect(releasePost).not.toBeNull());
    expect(rows()[2]?.getAttribute('aria-busy')).toBe('true');
    expect(rows().every((r) => r.disabled)).toBe(true);
    expect(calls[1]).toEqual({ url: '/api/agents/t1/claude/model', method: 'POST', body: { value: 'Haiku 4.5' } });
    await act(async () => releasePost?.());
    expect((await screen.findByRole('status')).textContent).toContain('Set model to Haiku 4.5 for this session only');
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('shows Claude’s note when it asked to confirm a switch mid-conversation', async () => {
    onPost = (_u, b) => ({
      status: 200,
      body: {
        kind: 'model',
        value: b.value,
        message: `Set model to ${b.value} for this session only`,
        note: 'Your next response will be slower',
      },
    });
    const w = worldWith();
    renderWith(<ClaudeSettingSheet t={w.terminals.t1 as TerminalView} kind="model" onClose={() => {}} />, w);
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rows()[0] as HTMLButtonElement);
    await waitFor(() => expect(releasePost).not.toBeNull());
    await act(async () => releasePost?.());
    expect((await screen.findByRole('status')).textContent).toContain('Your next response will be slower');
  });

  it('shows the bridge’s refusal inline and keeps the list', async () => {
    onPost = () => ({ status: 502, body: { error: 'Claude didn’t confirm the change' } });
    const w = worldWith();
    renderWith(<ClaudeSettingSheet t={w.terminals.t1 as TerminalView} kind="effort" onClose={() => {}} />, w);
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rows()[0] as HTMLButtonElement);
    await waitFor(() => expect(releasePost).not.toBeNull());
    await act(async () => releasePost?.());
    expect((await screen.findByRole('alert')).textContent).toContain('Claude didn’t confirm the change');
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(rows().every((r) => !r.disabled)).toBe(true);
  });

  it('a load error offers Try again', async () => {
    let n = 0;
    onGet = () =>
      n++ === 0
        ? { status: 409, body: { error: 'Claude’s message box has a draft: send or clear it first' } }
        : { status: 200, body: MODELS };
    const w = worldWith();
    renderWith(<ClaudeSettingSheet t={w.terminals.t1 as TerminalView} kind="model" onClose={() => {}} />, w);
    expect((await screen.findByRole('alert')).textContent).toContain('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it('while Claude is busy: says why, asks nothing, and reads the list once it is idle again', async () => {
    const w = worldWith({ word: 'working', status: 'working' });
    const { rerender } = renderWith(<ClaudeSettingSheet t={w.terminals.t1 as TerminalView} kind="model" onClose={() => {}} />, w);
    expect(screen.getByRole('status').textContent).toContain('Claude is working: wait until it’s idle');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
    rerender(
      <ClaudeSettingSheet t={{ ...(w.terminals.t1 as TerminalView), word: 'idle', status: 'idle' }} kind="model" onClose={() => {}} />,
    );
    await waitFor(() => expect(rows()).toHaveLength(3));
    // Busy again while open: rows disabled with the reason.
    rerender(
      <ClaudeSettingSheet
        t={{ ...(w.terminals.t1 as TerminalView), word: 'working', status: 'working' }}
        kind="model"
        onClose={() => {}}
      />,
    );
    expect(rows().every((r) => r.disabled)).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Claude is working');
  });
});
