// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleWorld, term } from '../test/fixtures';
import { renderWith } from '../test/render';
import { AgentMenu, branchable, branchName } from './AgentMenu';

const T = '/home/me/.claude/projects/-home-me-code-alpha/00000001-0000-4000-8000-000000000000.jsonl';
type Reply = { status: number; body: unknown };
let reply: () => Reply;
let posted: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  posted = [];
  reply = () => ({ status: 200, body: { spaceId: 'spA', tabId: 'tbNew', terminalId: 't42' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body)) });
      const r = reply();
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  window.location.hash = '#/a/t1/conversation';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const worldWith = (over: Parameters<typeof term>[1] = {}) => {
  const w = sampleWorld();
  w.terminals.t1 = { ...(w.terminals.t1 as ReturnType<typeof term>), transcript: T, ...over };
  return w;
};

describe('the agent’s ⋯ menu', () => {
  it('branches only local Claude Code agents in a space with a known session', () => {
    expect(branchable(term('t1', { transcript: T }))).toBe(true);
    expect(branchable(term('t1'))).toBe(false);
    expect(branchable(term('t1', { transcript: T, program: 'codex' }))).toBe(false);
    expect(branchable(term('t1', { transcript: T, machine: 'vps' }))).toBe(false);
    expect(branchable(term('t1', { transcript: T, spaceId: null }))).toBe(false);
    expect(branchable(term('t1', { transcript: '/x/agent-1.jsonl' }))).toBe(false);
    expect(branchName('Claude Code')).toBe('Claude Code (branch)');
    expect(branchName('x'.repeat(80))).toHaveLength(64);
  });

  it('opens with Branch out, Choose model, Choose effort level and a disabled placeholder; Branch out disabled without a session', () => {
    const w = worldWith({ transcript: null, word: 'done', status: 'done' });
    renderWith(<AgentMenu t={w.terminals.t1 as ReturnType<typeof term>} />, w);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Branch out from this conversation'),
      expect.stringContaining('Choose model'),
      expect.stringContaining('Choose effort level'),
      expect.stringContaining('More features coming soon'),
    ]);
    expect(items.map((i) => (i as HTMLButtonElement).disabled)).toEqual([true, false, false, true]);
  });

  it('disables Choose model / effort with the reason while Claude is busy, and for other programs', () => {
    for (const [over, hint] of [
      [{ word: 'working', status: 'working' }, 'Claude is working: wait until it’s idle'],
      [{ word: 'blocked', status: 'blocked' }, 'Claude is waiting for an answer'],
      [{ program: 'codex' }, 'Only for Claude Code on this computer'],
      [{ machine: 'vps' }, 'Only for Claude Code on this computer'],
    ] as const) {
      const w = worldWith(over as Parameters<typeof term>[1]);
      renderWith(<AgentMenu t={w.terminals.t1 as ReturnType<typeof term>} />, w);
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      for (const name of [/Choose model/, /Choose effort level/]) {
        const item = screen.getByRole('menuitem', { name }) as HTMLButtonElement;
        expect(item.disabled).toBe(true);
        expect(item.textContent).toContain(hint);
      }
      cleanup();
    }
  });

  it('asks for a name, sends it as given (quotes, accents), and opens the new agent once it shows', async () => {
    const w = worldWith();
    const { services } = renderWith(<AgentMenu t={w.terminals.t1 as ReturnType<typeof term>} />, w);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Branch out/ }));
    const input = screen.getByRole('textbox', { name: 'Name of the new conversation' }) as HTMLInputElement;
    expect(input.value).toBe('fix the login bug (branch)'); // the agent's name (its title)
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Give it a name')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Create/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '-x' } });
    expect((screen.getByRole('button', { name: /Create/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' branch test é "q" ' } });
    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: '/api/spaces/spA/tabs',
      body: { start: { kind: 'branch', terminal: 't1', name: 'branch test é "q"' } },
    });
    expect(window.location.hash).toBe('#/a/t1/conversation');
    act(() => {
      services.store.handle({ t: 'patch', seq: 2, ops: [{ op: 'terminal', value: term('t42', { tabId: 'tbNew' }) }] });
    });
    await waitFor(() => expect(window.location.hash).toBe('#/a/t42/terminal'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the bridge’s error in the sheet and stays', async () => {
    reply = () => ({ status: 409, body: { error: 'Herdr isn’t open on the computer' } });
    const w = worldWith();
    renderWith(<AgentMenu t={w.terminals.t1 as ReturnType<typeof term>} />, w);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Branch out/ }));
    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Herdr isn’t open');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Create/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
