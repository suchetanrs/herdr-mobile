// @vitest-environment jsdom
import type { ConversationServerMessage, ConvItem, ToolItem, World } from '@herdr-mobile/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultView } from '../screens/AgentScreen';
import { FakeWs } from '../test/fakeWs';
import { sampleWorld, term } from '../test/fixtures';
import { renderWith } from '../test/render';
import { ConversationView } from './ConversationView';
import { Markdown } from './Markdown';
import { Diff, shortPath, ToolCard } from './ToolCard';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const user = (id: string, text: string): ConvItem => ({ kind: 'user', id, ts: 0, text, source: 'prompt', images: 0 });
const reply = (id: string, text: string): ConvItem => ({ kind: 'assistant', id, ts: 0, text });
const bash = (id: string, command: string, out?: string): ToolItem => ({
  kind: 'tool',
  id,
  ts: 0,
  name: 'Bash',
  input: { type: 'bash', summary: command, command },
  ...(out !== undefined ? { result: { isError: false, text: out } } : {}),
});

/** Services wired to a fake socket, welcomed and synced, for driving conversation messages by hand. */
function live(world: World) {
  FakeWs.all = [];
  const r = renderWith(<div />, world);
  r.services.conn.start();
  const ws = FakeWs.last();
  ws.open();
  ws.receive({ t: 'welcome', v: 1, serverId: 'srv', heartbeatMs: 15000 });
  ws.receive({ t: 'snapshot', seq: 1, world, alerts: [] });
  const send = (m: ConversationServerMessage) => act(() => ws.receive(m));
  return { ...r, ws, send };
}

describe('conversation client', () => {
  beforeEach(() => {
    FakeWs.all = [];
  });

  it('opens, merges live items and results, pages back, starts over on a new session, re-opens after a reconnect', () => {
    const { services, ws, send } = live(sampleWorld());
    const c = services.conversations.open('t1');
    const open = ws.json().find((m) => m.t === 'conv.open') as { req: number };
    expect(open).toMatchObject({ terminalId: 't1' });
    expect(c.get().status).toBe('loading');

    const source = { format: 'claude', session: 's1', path: '/h/.claude/projects/p/s1.jsonl' };
    send({
      t: 'conv.opened',
      req: open.req,
      stream: 4,
      terminalId: 't1',
      source,
      meta: { title: 'x' },
      v: 1,
      items: [user('u2', 'two')],
      before: 100,
    });
    expect(c.get()).toMatchObject({ status: 'live', before: 100, meta: { title: 'x' } });

    send({ t: 'conv.items', stream: 4, items: [bash('b1', 'ls')] });
    send({ t: 'conv.items', stream: 4, items: [], results: [{ id: 'b1', result: { isError: false, text: 'a.txt' } }] });
    expect((c.get().items[1] as ToolItem).result?.text).toBe('a.txt');
    // The same entry again (a re-sent tool call) keeps its result.
    send({ t: 'conv.items', stream: 4, items: [bash('b1', 'ls')] });
    expect(c.get().items).toHaveLength(2);
    expect((c.get().items[1] as ToolItem).result?.text).toBe('a.txt');

    c.loadOlder();
    const more = ws.json().find((m) => m.t === 'conv.more') as { req: number; before: number };
    expect(more.before).toBe(100);
    expect(c.get().loadingOlder).toBe(true);
    // An older page with a tool whose result came in an even newer page: the result waits for it.
    send({ t: 'conv.page', req: more.req, stream: 4, items: [user('u1', 'one'), bash('b0', 'pwd')], before: null, results: [] });
    expect(c.get().items.map((i) => i.id)).toEqual(['u1', 'b0', 'u2', 'b1']);
    expect(c.get()).toMatchObject({ before: null, loadingOlder: false });

    const epoch = c.get().epoch;
    send({
      t: 'conv.reset',
      stream: 4,
      reason: 'session',
      source: { ...source, session: 's2' },
      meta: {},
      items: [user('n1', 'fresh')],
      before: null,
    });
    expect(c.get().items.map((i) => i.id)).toEqual(['n1']);
    expect(c.get().epoch).toBe(epoch + 1);

    // Reconnect: the stream is opened again on the new socket.
    act(() => ws.close());
    act(() => services.conn.retryNow());
    const ws2 = FakeWs.last();
    ws2.open();
    ws2.receive({ t: 'welcome', v: 1, serverId: 'srv', heartbeatMs: 15000 });
    expect(ws2.json().some((m) => m.t === 'conv.open' && m.terminalId === 't1')).toBe(true);
    c.close();
    services.conn.stop();
  });

  it('keeps a result that arrives before its tool call', () => {
    const { services, ws, send } = live(sampleWorld());
    const c = services.conversations.open('t1');
    const open = ws.json().find((m) => m.t === 'conv.open') as { req: number };
    const source = { format: 'claude', session: 's1', path: '/p.jsonl' };
    send({
      t: 'conv.opened',
      req: open.req,
      stream: 1,
      terminalId: 't1',
      source,
      meta: {},
      v: 1,
      items: [reply('r', 'done')],
      before: 50,
      results: [{ id: 'old', result: { isError: true, text: 'boom' } }],
    });
    c.loadOlder();
    const more = ws.json().find((m) => m.t === 'conv.more') as { req: number };
    send({ t: 'conv.page', req: more.req, stream: 1, items: [bash('old', 'make')], before: null });
    expect((c.get().items[0] as ToolItem).result).toMatchObject({ isError: true, text: 'boom' });
    services.conn.stop();
  });

  it('re-opens after a reconnect without a gap: replaces a page that does not join, merges results that came meanwhile', () => {
    const { services, ws } = live(sampleWorld());
    const c = services.conversations.open('t1');
    const source = { format: 'claude', session: 's1', path: '/p.jsonl' };
    const opened = (
      req: number,
      stream: number,
      items: ConvItem[],
      results?: { id: string; result: { isError: boolean; text: string } }[],
    ) =>
      act(() =>
        FakeWs.last().receive({
          t: 'conv.opened',
          req,
          stream,
          terminalId: 't1',
          source,
          meta: {},
          v: 1,
          items,
          before: 10,
          ...(results ? { results } : {}),
        }),
      );
    opened((ws.json().find((m) => m.t === 'conv.open') as { req: number }).req, 1, [user('u1', 'one'), bash('b1', 'make')]);
    const epoch = c.get().epoch;

    // Back soon: the new page overlaps. The tool finished meanwhile; its result comes with the page.
    act(() => ws.close());
    act(() => services.conn.retryNow());
    const ws2 = FakeWs.last();
    ws2.open();
    ws2.receive({ t: 'welcome', v: 1, serverId: 'srv', heartbeatMs: 15000 });
    const req2 = (ws2.json().find((m) => m.t === 'conv.open') as { req: number }).req;
    opened(req2, 2, [bash('b1', 'make'), reply('r1', 'built')], [{ id: 'b1', result: { isError: false, text: 'ok' } }]);
    expect(c.get().items.map((i) => i.id)).toEqual(['u1', 'b1', 'r1']);
    expect((c.get().items[1] as ToolItem).result?.text).toBe('ok');
    expect(c.get().epoch).toBe(epoch);

    // Away for many turns: the newest page doesn't join what's shown. Show it alone, not glued on with a hole.
    act(() => ws2.close());
    act(() => services.conn.retryNow());
    const ws3 = FakeWs.last();
    ws3.open();
    ws3.receive({ t: 'welcome', v: 1, serverId: 'srv', heartbeatMs: 15000 });
    const req3 = (ws3.json().find((m) => m.t === 'conv.open') as { req: number }).req;
    opened(req3, 3, [user('u9', 'nine'), reply('r9', 'later')]);
    expect(c.get().items.map((i) => i.id)).toEqual(['u9', 'r9']);
    expect(c.get().before).toBe(10);
    expect(c.get().epoch).toBe(epoch + 1);
    services.conn.stop();
  });

  it('says when an agent has no transcript', () => {
    const { services, ws, send } = live(sampleWorld());
    const c = services.conversations.open('t2');
    const open = ws.json().find((m) => m.t === 'conv.open') as { req: number };
    send({ t: 'conv.error', req: open.req, code: 'no_transcript', message: 'none' });
    expect(c.get().status).toBe('none');
    services.conn.stop();
  });
});

describe('markdown', () => {
  it('renders markdown as elements, never raw HTML', () => {
    const { container } = render(
      <Markdown
        text={
          '# Title\n\nSome **bold** and `code` <img src=x onerror=alert(1)>\n\n- [x] done\n\n[ok](https://a.b) [bad](javascript:alert(1))\n\n```py\nx = 1\n```'
        }
      />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://a.b']);
    expect(container.querySelector('input[type=checkbox]')).not.toBeNull();
    expect(container.querySelector('pre.hljs .hljs-number')?.textContent).toBe('1');
  });
});

describe('tool cards', () => {
  it('shows a command with the first line of its output, and the whole output when opened', () => {
    render(<ToolCard t={bash('b', 'npm test', 'PASS 3\nall good')} cwd={null} />);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText(/PASS 3\s+\+1 lines/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/all good/)).toBeTruthy();
  });

  it('draws an edit as a numbered diff', () => {
    const { container } = render(<Diff hunks={[{ oldStart: 10, newStart: 10, lines: [' a', '-b', '+c'] }]} path="/x/y.txt" />);
    const rows = [...container.querySelectorAll('.diff-line')].map((r) => r.textContent);
    expect(rows).toEqual(['10a', '11-b', '11+c']);
    const more = render(<Diff hunks={[{ oldStart: 13, newStart: 13, lines: [' a', '+b', ' c'] }]} />);
    expect([...more.container.querySelectorAll('.diff-n')].map((n) => n.textContent)).toEqual(['13', '14', '15']);
    expect(shortPath('/home/me/code/alpha/src/a.ts', '/home/me/code/alpha')).toBe('src/a.ts');
    expect(shortPath('/home/me/notes.md', '/srv')).toBe('~/notes.md');
  });

  it('marks the call a blocked agent is waiting on', () => {
    const { container } = render(<ToolCard t={bash('b', 'rm -rf build')} cwd={null} waiting />);
    expect(container.querySelector('.is-waiting')).not.toBeNull();
    expect(screen.getByText('Needs you')).toBeTruthy();
  });
});

describe('conversation view', () => {
  it('renders the chat and the working row, and offers the terminal when there is no transcript', () => {
    const world = sampleWorld();
    const t1 = world.terminals.t1;
    if (!t1) throw new Error('fixture');
    const { services, ws, send } = live(world);
    const view = render(<ConversationView t={t1} onStop={() => {}} onShowTerminal={() => {}} />, {
      wrapper: ({ children }) => <ServicesProvider services={services}>{children}</ServicesProvider>,
    });
    const open = ws
      .json()
      .filter((m) => m.t === 'conv.open')
      .at(-1) as { req: number };
    send({
      t: 'conv.opened',
      req: open.req,
      stream: 9,
      terminalId: 't1',
      source: { format: 'claude', session: 's', path: '/p.jsonl' },
      meta: { model: 'claude-opus-5-5', contextTokens: 120_000, costUsd: 1.5 },
      v: 1,
      items: [user('u', 'Fix the login bug'), reply('a', 'On it: **found** it.'), bash('b', 'npm test')],
      before: null,
    });
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByText('found')).toBeTruthy();
    expect(screen.getByText('opus-5-5 · 120k context · $1.50')).toBeTruthy();
    expect(screen.getByText('Start of this session')).toBeTruthy();
    expect(screen.getByText(/^Working/)).toBeTruthy();
    view.unmount();
    expect(ws.json().some((m) => m.t === 'conv.close' && m.stream === 9)).toBe(true);
    services.conn.stop();
  });
});

describe('default tab', () => {
  it('opens Conversation for an agent with a transcript, else Terminal, and remembers a pick per agent', () => {
    expect(defaultView(term('t1', { transcript: '/x.jsonl' }))).toBe('conversation');
    expect(defaultView(term('t2'))).toBe('terminal');
    localStorage.setItem('hm.view.t1', JSON.stringify('terminal'));
    expect(defaultView(term('t1', { transcript: '/x.jsonl' }))).toBe('terminal');
  });
});

import { ServicesContext } from '../hooks/app';
import type { Services } from '../lib/app';

function ServicesProvider({ services, children }: { services: Services; children: React.ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}
