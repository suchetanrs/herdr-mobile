// @vitest-environment jsdom
import type { SpaceSessions } from '@herdr-mobile/protocol';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceScreen } from '../screens/SpaceScreen';
import { sampleWorld, term } from '../test/fixtures';
import { renderWith } from '../test/render';
import { AddToSpace, shortPath } from './AddToSpace';

const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const SESSIONS: SpaceSessions = {
  folder: '/home/me/code/alpha',
  display: '~/code/alpha',
  appOpen: true,
  claudeInstalled: true,
  configs: [
    { id: '.claude', label: 'alice · max', isDefault: true },
    { id: '.claude-work', label: 'bob · pro', isDefault: false },
  ],
  sessions: [
    {
      id: U(1),
      title: 'Fix login',
      prompt: 'fix the login bug',
      modifiedMs: Date.now() - 5 * 60_000,
      messages: 12,
      config: '.claude',
      openIn: null,
      runningElsewhere: false,
    },
    {
      id: U(2),
      title: null,
      prompt: 'write the docs',
      modifiedMs: Date.now() - 3 * 3600_000,
      messages: 4,
      config: '.claude-work',
      openIn: 't3',
      runningElsewhere: false,
    },
    {
      id: U(3),
      title: null,
      prompt: 'elsewhere',
      modifiedMs: Date.now() - 86_400_000,
      messages: 2,
      config: '.claude',
      openIn: null,
      runningElsewhere: true,
    },
  ],
};

type Reply = { status: number; body: unknown };
let replies: Record<string, (init?: RequestInit) => Reply>;
let posted: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  posted = [];
  replies = { '/api/spaces/spA/sessions': () => ({ status: 200, body: SESSIONS }) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0] as string;
      if (init?.method === 'POST') posted.push({ url: path, body: JSON.parse(String(init.body)) });
      const r = replies[path]?.(init) ?? { status: 404, body: { error: 'nope' } };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  window.location.hash = '#/s/spA';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the + of a space', () => {
  it('shortens long folders to their end', () => {
    expect(shortPath('~/code/alpha')).toBe('~/code/alpha');
    expect(shortPath('~/work/acme-app/infra/web_client/data/run', 32)).toBe('…/infra/web_client/data/run');
    expect(shortPath(`~/${'x'.repeat(40)}`, 10)).toBe(`…/${'x'.repeat(40)}`);
  });

  it('shows in a local space’s top bar and opens Terminal | Claude session', async () => {
    renderWith(<SpaceScreen spaceId="spA" />, sampleWorld());
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    const dialog = await screen.findByRole('dialog', { name: 'New tab' });
    expect(dialog.textContent).toMatch(/Terminal/);
    expect(dialog.textContent).toMatch(/Claude session/);
    expect(await screen.findByText('A shell in ~/code/alpha')).toBeTruthy();
  });

  it('isn’t offered for another machine’s space', () => {
    const w = sampleWorld();
    (w.spaces.spA as { machine: string | null }).machine = 'vps';
    renderWith(<SpaceScreen spaceId="spA" />, w);
    expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull();
  });

  it('Terminal adds a shell tab and opens it once it shows up', async () => {
    replies['/api/spaces/spA/tabs'] = () => ({ status: 200, body: { spaceId: 'spA', tabId: 'tbNew', terminalId: 't42' } });
    const close = vi.fn();
    const { services } = renderWith(<AddToSpace spaceId="spA" onClose={close} />, sampleWorld());
    fireEvent.click(await screen.findByRole('button', { name: /Terminal/ }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/spaces/spA/tabs', body: { start: { kind: 'shell' } } }]));
    expect(window.location.hash).toBe('#/s/spA');
    act(() => {
      services.store.handle({ t: 'patch', seq: 2, ops: [{ op: 'terminal', value: term('t42', { tabId: 'tbNew' }) }] });
    });
    await waitFor(() => expect(window.location.hash).toBe('#/a/t42'));
    expect(close).toHaveBeenCalled();
  });

  it('Claude session -> New starts Claude Code; -> Resume lists sessions, newest first, with their login', async () => {
    replies['/api/spaces/spA/tabs'] = () => ({ status: 200, body: { spaceId: 'spA', tabId: 'tbNew', terminalId: 't43' } });
    renderWith(<AddToSpace spaceId="spA" onClose={() => {}} />, sampleWorld());
    fireEvent.click(await screen.findByRole('button', { name: /Claude session/ }));
    await screen.findByRole('dialog', { name: 'Claude session' });
    // Two resumable (the open one and the one running elsewhere don't count).
    expect(screen.getByText('1 session in this folder')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Resume session/ }));
    await screen.findByRole('dialog', { name: 'Resume a session' });
    const rows = await screen.findAllByRole('button', { name: /ago/ });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Fix loginfix the login bug5m ago · 12 messages · alice · max$/),
      expect.stringMatching(/^write the docs3h ago · 4 messages · bob · proOpen$/),
      expect.stringMatching(/^elsewhere1d ago · 2 messages · alice · maxRunning elsewhere$/),
    ]);
    expect((rows[2] as HTMLButtonElement).disabled).toBe(true);
    // Resume with another login.
    fireEvent.click(screen.getByRole('button', { name: 'bob · pro' }));
    fireEvent.click(rows[0] as HTMLElement);
    await waitFor(() =>
      expect(posted.at(-1)).toEqual({
        url: '/api/spaces/spA/tabs',
        body: { start: { kind: 'resume', session: U(1), config: '.claude-work' } },
      }),
    );
  });

  it('an open session opens where it runs; New sends claude', async () => {
    replies['/api/spaces/spA/tabs'] = () => ({ status: 200, body: { spaceId: 'spA', tabId: 'tbNew', terminalId: 't44' } });
    const close = vi.fn();
    renderWith(<AddToSpace spaceId="spA" onClose={close} />, sampleWorld());
    fireEvent.click(await screen.findByRole('button', { name: /Claude session/ }));
    fireEvent.click(screen.getByRole('button', { name: /Resume session/ }));
    fireEvent.click(await screen.findByRole('button', { name: /write the docs/ }));
    expect(window.location.hash).toBe('#/a/t3');
    expect(close).toHaveBeenCalled();
    expect(posted).toEqual([]);
    cleanup();
    renderWith(<AddToSpace spaceId="spA" onClose={() => {}} />, sampleWorld());
    fireEvent.click(await screen.findByRole('button', { name: /Claude session/ }));
    fireEvent.click(screen.getByRole('button', { name: /New session/ }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/spaces/spA/tabs', body: { start: { kind: 'claude' } } }]));
  });

  it('shows the bridge’s errors inline and stays open', async () => {
    replies['/api/spaces/spA/tabs'] = () => ({ status: 409, body: { error: 'Herdr isn’t open on the computer' } });
    renderWith(<AddToSpace spaceId="spA" onClose={() => {}} />, sampleWorld());
    fireEvent.click(await screen.findByRole('button', { name: /Terminal/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t open/);
    expect(screen.getByRole('dialog', { name: 'New tab' })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Terminal/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('greys out Claude when it isn’t installed, and says when Herdr is closed', async () => {
    replies['/api/spaces/spA/sessions'] = () => ({ status: 200, body: { ...SESSIONS, claudeInstalled: false, appOpen: false } });
    renderWith(<AddToSpace spaceId="spA" onClose={() => {}} />, sampleWorld());
    expect(await screen.findByText(/Herdr isn’t open on the computer/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Claude session/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
