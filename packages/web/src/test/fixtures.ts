import type { SpaceView, TabView, TerminalView, World } from '@herdr-mobile/protocol';

export function term(id: string, over: Partial<TerminalView> = {}): TerminalView {
  return {
    id,
    machine: null,
    spaceId: 'spA',
    tabId: 'tbA1',
    paneId: `p-${id}`,
    parent: null,
    children: [],
    name: null,
    label: 'Claude Code',
    app: 'claude-code',
    program: 'claude',
    title: '',
    status: 'idle',
    word: 'idle',
    turn: 1,
    seenTurn: 1,
    pinned: false,
    cwd: '/home/me/code/alpha',
    cols: 120,
    rows: 40,
    statusMs: 1_000,
    transcript: null,
    ...over,
  };
}

export function space(id: string, over: Partial<SpaceView> = {}): SpaceView {
  return { id, machine: null, index: 1, name: id, named: true, folder: '', status: null, tabIds: [], color: null, ...over };
}

export function tab(id: string, spaceId: string, terminals: string[], over: Partial<TabView> = {}): TabView {
  return {
    id,
    spaceId,
    index: 1,
    name: '1',
    named: false,
    status: null,
    panes: terminals.map((t) => ({ id: `p-${t}`, terminalId: t })),
    ...over,
  };
}

/**
 * alpha: tab 1 = t1 (working, with sub-agent t9 blocked) + shell t2; tab 2 = t3 (done, unseen)
 * beta: tab 1 = t4 (blocked)
 * gamma: tab 1 = t5 (idle)
 * empty: no terminals
 */
export function sampleWorld(): World {
  const t1 = term('t1', { status: 'working', word: 'working', title: '✳ fix the login bug', children: ['t9'] });
  const t9 = term('t9', { paneId: null, parent: 't1', status: 'blocked', word: 'blocked', name: 'reviewer' });
  const t2 = term('t2', { app: null, program: 'bash', label: 'bash', status: null, word: null, title: 'me@box: ~/code/alpha' });
  const t3 = term('t3', { tabId: 'tbA2', status: 'done', word: 'done', turn: 4, seenTurn: 3, title: 'Claude Code' });
  const t4 = term('t4', { spaceId: 'spB', tabId: 'tbB1', status: 'blocked', word: 'blocked', title: 'deploy' });
  const t5 = term('t5', { spaceId: 'spC', tabId: 'tbC1', status: 'idle', word: 'done' });
  return {
    core: { connected: true, version: '0.1.18', name: 'box' },
    spaceOrder: ['spA', 'spB', 'spC', 'spD'],
    spaces: {
      spA: space('spA', { name: 'alpha', index: 1, status: 'done', tabIds: ['tbA1', 'tbA2'], color: 'ansi6' }),
      spB: space('spB', { name: 'beta', index: 2, status: 'blocked', tabIds: ['tbB1'] }),
      spC: space('spC', { name: 'gamma', index: 3, status: 'idle', tabIds: ['tbC1'] }),
      spD: space('spD', { name: 'empty', index: 4, status: null, tabIds: [] }),
    },
    tabs: {
      tbA1: tab('tbA1', 'spA', ['t1', 't2'], { status: 'working' }),
      tbA2: tab('tbA2', 'spA', ['t3'], { index: 2, name: 'review', named: true, status: 'done' }),
      tbB1: tab('tbB1', 'spB', ['t4'], { status: 'blocked' }),
      tbC1: tab('tbC1', 'spC', ['t5'], { status: 'idle' }),
    },
    terminals: { t1, t2, t3, t4, t5, t9 },
  };
}
