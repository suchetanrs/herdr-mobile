// @vitest-environment jsdom
import type { NewSpaceOptions } from '@herdr-mobile/protocol';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderBase } from '../lib/spaces';
import { sampleWorld, term } from '../test/fixtures';
import { renderWith } from '../test/render';
import { NewSpaceScreen } from './NewSpaceScreen';

const OPTIONS: NewSpaceOptions = {
  home: '/home/me',
  appOpen: true,
  folders: [
    { path: '/home/me/code/api', display: '~/code/api', from: 'space', label: 'api' },
    { path: '/home/me/old', display: '~/old', from: 'recent', label: 'Old' },
  ],
  starts: [
    { kind: 'agent', key: 'claude', name: 'Claude Code', installed: true },
    { kind: 'agent', key: 'codex', name: 'Codex', installed: false },
  ],
};

type Reply = { status: number; body: unknown };
let replies: Record<string, (init?: RequestInit) => Reply>;
let posted: unknown[];

beforeEach(() => {
  posted = [];
  replies = {
    '/api/new-space': () => ({ status: 200, body: OPTIONS }),
    '/api/folders': () => ({ status: 200, body: { entries: ['~/code/api/', '~/code/web/'] } }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0] as string;
      if (init?.method === 'POST') posted.push(JSON.parse(String(init.body)));
      const r = replies[path]?.(init) ?? { status: 404, body: { error: 'nope' } };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  window.location.hash = '#/new';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('New space screen', () => {
  it('offers recent folders and Herdr’s agents; not-installed ones are greyed', async () => {
    renderWith(<NewSpaceScreen />, sampleWorld());
    await screen.findByText('Claude Code');
    expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('~/code/api');
    expect(screen.getByText('~/old')).toBeTruthy();
    expect((screen.getByText('Codex').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('not installed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Terminal/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('completes typed folders from the bridge', async () => {
    renderWith(<NewSpaceScreen />, sampleWorld());
    await screen.findByText('Claude Code');
    const input = screen.getByLabelText('Folder');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '~/code/' } });
    const opt = await screen.findByRole('option', { name: '~/code/web/' });
    fireEvent.click(opt);
    expect((input as HTMLInputElement).value).toBe('~/code/web/');
  });

  it('sends folder, name and agent, then opens the agent once it shows up', async () => {
    replies['/api/spaces'] = () => ({ status: 200, body: { spaceId: 'spNew', tabId: 'tbNew', terminalId: 't42' } });
    const { services, container } = renderWith(<NewSpaceScreen />, sampleWorld());
    await screen.findByText('Claude Code');
    fireEvent.click(screen.getByText('Claude Code'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' API ' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(posted).toEqual([{ folder: '~/code/api', name: 'API', start: { kind: 'agent', key: 'claude' } }]));
    expect(window.location.hash).toBe('#/new');
    act(() => {
      services.store.handle({
        t: 'patch',
        seq: 2,
        ops: [
          { op: 'space', value: { ...sampleWorld().spaces.spA, id: 'spNew', name: 'API', tabIds: [] } as never },
          { op: 'terminal', value: term('t42', { spaceId: 'spNew' }) },
        ],
      });
    });
    await waitFor(() => expect(window.location.hash).toBe('#/a/t42'));
  });

  it('shows the bridge’s errors under their field', async () => {
    replies['/api/spaces'] = () => ({ status: 400, body: { error: 'No such folder', field: 'folder' } });
    const { container } = renderWith(<NewSpaceScreen />, sampleWorld());
    await screen.findByText('Claude Code');
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '~/nope' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect(await screen.findByText('No such folder')).toBeTruthy();
    expect(screen.getByLabelText('Folder').getAttribute('aria-invalid')).toBe('true');
    replies['/api/spaces'] = () => ({ status: 409, body: { error: 'Herdr isn’t open on the computer' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t open/);
  });

  it('warns when Herdr is closed', async () => {
    replies['/api/new-space'] = () => ({ status: 200, body: { ...OPTIONS, appOpen: false } });
    renderWith(<NewSpaceScreen />, sampleWorld());
    expect(await screen.findByText(/Herdr isn’t open on the computer/)).toBeTruthy();
  });

  it('names the placeholder after the folder', () => {
    expect(folderBase('~/code/api/')).toBe('api');
    expect(folderBase('~')).toBe('~');
    expect(folderBase('')).toBe('~');
  });
});
