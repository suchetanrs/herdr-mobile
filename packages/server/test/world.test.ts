import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, emptyWorld } from '@herdr-mobile/protocol';
import { describe, expect, it } from 'vitest';
import { AgentTimes } from '../src/world/agentTimes.js';
import { deriveWorld } from '../src/world/derive.js';
import { diffWorld } from '../src/world/diff.js';
import { asLayoutDoc, panesOf, qualify } from '../src/world/layout.js';
import { CheckoutResolver, folderName } from '../src/world/names.js';
import { displayStatus, rollup, seenTurnOf } from '../src/world/status.js';
import { TerminalTable } from '../src/world/terminals.js';
import { agent, layoutDoc, standardTerminals, terminal } from './helpers/fixtures.js';
import { rmDir, tmpDir } from './helpers/tmp.js';

const core = { connected: true, version: '0.1.18', name: 'box' };

function build(terms = standardTerminals(), seen: (a: string) => boolean = () => false) {
  const table = new TerminalTable();
  table.reset(10, terms);
  return deriveWorld({
    core,
    docs: [{ machine: null, doc: layoutDoc() }],
    terminals: table,
    seenLocally: seen,
    home: '/home/me',
    checkoutTop: (f) => (f.startsWith('/home/me/work/proj') ? '/home/me/work/proj' : f),
  });
}

describe('status rule (docs/labels.md)', () => {
  it('maps words to what Herdr shows', () => {
    expect(displayStatus(null, 3, 1, false)).toBeNull();
    expect(displayStatus('working', 3, 1, false)).toBe('working');
    expect(displayStatus('blocked', 3, 3, true)).toBe('blocked');
    expect(displayStatus('error', 3, 3, true)).toBe('blocked');
    expect(displayStatus('done', 3, 2, true)).toBe('done');
    expect(displayStatus('idle', 3, 3, false)).toBe('idle');
    expect(displayStatus('idle', 4, 3, true)).toBe('done');
    // No label: the client's own seen flag decides (a missing label is not 0).
    expect(displayStatus('idle', 0, null, false)).toBe('done');
    expect(displayStatus('done', 9, null, true)).toBe('idle');
  });

  it('rolls up blocked > done > working > idle', () => {
    expect(rollup([])).toBeNull();
    expect(rollup([null, 'idle'])).toBe('idle');
    expect(rollup(['idle', 'working'])).toBe('working');
    expect(rollup(['working', 'done', 'idle'])).toBe('done');
    expect(rollup(['done', 'blocked', 'working'])).toBe('blocked');
  });

  it('reads herdr.seen strictly', () => {
    expect(seenTurnOf(terminal('t', { labels: { 'herdr.seen': '4' } }))).toBe(4);
    expect(seenTurnOf(terminal('t', { labels: {} }))).toBeNull();
    expect(seenTurnOf(terminal('t', { labels: { 'herdr.seen': 'x' } }))).toBeNull();
  });
});

describe('names', () => {
  it('names folders like Herdr', () => {
    expect(folderName('/home/me', '/home/me')).toBe('~');
    expect(folderName('/home/me/', '/home/me')).toBe('~');
    expect(folderName('/home/me/src/herdr', '/home/me')).toBe('herdr');
    expect(folderName('/', '/home/me')).toBe('/');
    expect(folderName('', '/home/me')).toBe('~');
  });

  it('finds the checkout top and caches it', () => {
    let calls = 0;
    const r = new CheckoutResolver(60_000, (p) => {
      calls++;
      return p === '/src/repo/.git';
    });
    expect(r.top('/src/repo/a/b')).toBe('/src/repo');
    const n = calls;
    expect(r.top('/src/repo/a/b')).toBe('/src/repo');
    expect(calls).toBe(n);
    expect(r.top('/elsewhere/x')).toBe('/elsewhere/x');
  });
});

describe('layout', () => {
  it('walks panes in tree order and qualifies ids', () => {
    const doc = layoutDoc();
    expect(panesOf(doc.spaces?.[1]?.tabs?.[0]?.root).map((p) => p.terminal)).toEqual(['t2', 't3']);
    expect(qualify('t7', 'rohan')).toBe('rohan/t7');
    expect(qualify('t7', null)).toBe('t7');
    expect(asLayoutDoc(null)).toEqual({});
    expect(asLayoutDoc({ spaces: [{ id: 'a' }, { nope: 1 }] }).spaces).toHaveLength(1);
  });
});

describe('deriveWorld', () => {
  const w = build();

  it('builds spaces -> tabs -> panes with Herdr names', () => {
    expect(w.spaceOrder).toEqual(['spA', 'spB']);
    expect(w.spaces.spA?.name).toBe('Alpha');
    // Unnamed space: its first terminal's checkout.
    expect(w.spaces.spB).toMatchObject({ name: 'proj', named: false, tabIds: ['tbB1', 'tbB2'], index: 2 });
    expect(w.tabs.tbB1).toMatchObject({ name: '1', named: false, index: 1 });
    expect(w.tabs.tbB2).toMatchObject({ name: 'review', named: true });
    // The pane whose terminal is gone is dropped.
    expect(w.tabs.tbB2?.panes.map((p) => p.terminalId)).toEqual(['t4']);
  });

  it('applies the status rule and rolls up per tab and space (sub-agents excluded)', () => {
    expect(w.terminals.t1?.status).toBe('done');
    expect(w.terminals.t2?.status).toBe('working');
    expect(w.terminals.t3?.status).toBeNull();
    expect(w.terminals.t4?.status).toBe('idle');
    expect(w.terminals.t5?.status).toBe('blocked');
    expect(w.tabs.tbA1?.status).toBe('done');
    // t5 is blocked but is t2's sub-agent: the tab is only "working".
    expect(w.tabs.tbB1?.status).toBe('working');
    expect(w.spaces.spB?.status).toBe('working');
  });

  it('places sub-agents with their parent and leaves paneless terminals out', () => {
    expect(w.terminals.t2?.children).toEqual(['t5']);
    expect(w.terminals.t5).toMatchObject({ parent: 't2', spaceId: 'spB', tabId: 'tbB1', paneId: null });
    expect(w.terminals.t6).toBeUndefined();
  });

  it('can list unplaced live terminals for diagnostics', () => {
    const table = new TerminalTable();
    table.reset(1, standardTerminals());
    const world = deriveWorld({
      core,
      docs: [{ machine: null, doc: layoutDoc() }],
      terminals: table,
      seenLocally: () => false,
      home: '/home/me',
      checkoutTop: (f) => f,
      includeUnplaced: true,
    });
    expect(world.terminals.t6).toMatchObject({ spaceId: null, tabId: null, paneId: null, status: 'working' });
  });

  it('labels terminals and extracts the transcript', () => {
    expect(w.terminals.t1).toMatchObject({ label: 'Claude Code', app: 'claude-code', program: 'claude', turn: 3, seenTurn: 2 });
    expect(w.terminals.t4?.label).toBe('reviewer');
    expect(w.terminals.t3?.label).toBe('bash');
    expect(w.terminals.t1?.transcript).toBe('/home/me/.claude/projects/p/t1.jsonl');
  });

  it('qualifies ids of another machine', () => {
    const table = new TerminalTable();
    table.reset(1, [agent('rohan/t7', 'working', 1, 1)]);
    const world = deriveWorld({
      core,
      docs: [
        { machine: null, doc: {} },
        {
          machine: 'rohan',
          doc: {
            spaces: [
              {
                id: 'sp1',
                name: '',
                folder: '/srv',
                tabs: [{ id: 'tb1', root: { type: 'block', id: 'p1', content: { terminal: 't7' } } }],
              },
            ],
          },
        },
      ],
      terminals: table,
      seenLocally: () => false,
      home: '/home/me',
      checkoutTop: () => {
        throw new Error('remote folders are not looked up locally');
      },
    });
    expect(world.spaceOrder).toEqual(['rohan/sp1']);
    expect(world.spaces['rohan/sp1']).toMatchObject({ machine: 'rohan', name: 'proj' });
    expect(world.terminals['rohan/t7']).toMatchObject({ machine: 'rohan', paneId: 'rohan/p1', tabId: 'rohan/tb1' });
  });
});

// Regression (task 3b): the desktop shot of 01:43 showed an "AWS" space the
// bridge "didn't list". Root cause: the shot was stale. AWS (spaces[5] of
// data/doc_herdr-app.json at 01:4x, two unnamed tabs with t1w + t25) closed at
// 01:44:56 when its last terminals exited, and the desktop moved it to Recent.
// These pin both halves: an open space like it is listed in the desktop's place,
// and a space whose terminals all ended closes the way the desktop closes it.
describe('a space like the desktop\'s "AWS" (task 3b)', () => {
  const aws = () =>
    ({
      id: 'sp4b72',
      name: 'AWS',
      folder: '/home/me/ROSCon',
      tabs: [
        {
          id: 'tbe4',
          name: '',
          root: { type: 'row', id: 'tbe4', children: [{ type: 'block', id: 'pd85', content: { terminal: 't1w' } }] },
        },
        {
          id: 'tbd9',
          name: '',
          root: { type: 'row', id: 'tbd9', children: [{ type: 'block', id: 'p285', content: { terminal: 't25' } }] },
        },
      ],
    }) as never;
  const doc = () => ({ spaces: [...(layoutDoc().spaces ?? []), aws()] });
  const derive = (terms: ReturnType<typeof standardTerminals>) => {
    const table = new TerminalTable();
    table.reset(1, terms);
    return deriveWorld({
      core,
      docs: [{ machine: null, doc: doc() }],
      terminals: table,
      seenLocally: () => true,
      home: '/home/me',
      checkoutTop: (f) => f,
    });
  };
  const live = () => [
    ...standardTerminals(),
    agent('t1w', 'done', 13, 13, { labels: { 'herdr.seen': '13', 'herdr.space': 'sp4b72', 'herdr.tab': 'tbe4' } }),
    agent('t25', 'done', 1, 1, { labels: { 'herdr.seen': '1', 'herdr.space': 'sp4b72', 'herdr.tab': 'tbd9' } }),
  ];
  const ended = (t: ReturnType<typeof terminal>, reason: string) => ({
    ...t,
    state: 'finished',
    reason,
    exit_code: 130,
    finished_ms: 1793996090691,
    foreground: null,
  });

  it('lists it last, with its name, tabs 1 and 2 and its rollup', () => {
    const w = derive(live());
    expect(w.spaceOrder).toEqual(['spA', 'spB', 'sp4b72']);
    expect(w.spaces.sp4b72).toMatchObject({ name: 'AWS', index: 3, tabIds: ['tbe4', 'tbd9'], status: 'idle' });
    expect(w.tabs.tbe4).toMatchObject({ name: '1', status: 'idle' });
    expect(w.tabs.tbd9?.name).toBe('2');
  });

  it('closes a pane whose terminal exited, then its tab, then its space (window.rs check_closed)', () => {
    const [t1w, t25] = live().slice(-2) as [ReturnType<typeof terminal>, ReturnType<typeof terminal>];
    const oneLeft = derive([...standardTerminals(), ended(t1w, 'exited'), t25]);
    expect(oneLeft.spaces.sp4b72?.tabIds).toEqual(['tbd9']);
    // Numbered among the tabs left, as the desktop does once it drops the closed one (REVIEW P2-9).
    expect(oneLeft.tabs.tbd9?.name).toBe('1');
    expect(oneLeft.terminals.t1w).toBeUndefined();
    const none = derive([...standardTerminals(), ended(t1w, 'exited'), ended(t25, 'killed')]);
    expect(none.spaceOrder).toEqual(['spA', 'spB']);
    expect(none.spaces.sp4b72).toBeUndefined();
  });

  it('keeps a pane whose terminal ended another way, and tabs that were empty in the doc', () => {
    const [t1w, t25] = live().slice(-2) as [ReturnType<typeof terminal>, ReturnType<typeof terminal>];
    const w = derive([...standardTerminals(), ended(t1w, 'failed'), ended(t25, 'exited')]);
    expect(w.spaces.sp4b72?.tabIds).toEqual(['tbe4']);
    const empty = deriveWorld({
      core,
      docs: [
        {
          machine: null,
          doc: { spaces: [{ id: 'spE', name: 'E', tabs: [{ id: 'tbE', name: '', root: { type: 'row', id: 'tbE', children: [] } }] }] },
        },
      ],
      terminals: new TerminalTable(),
      seenLocally: () => true,
      home: '/home/me',
      checkoutTop: (f) => f,
    });
    expect(empty.spaces.spE?.tabIds).toEqual(['tbE']);
  });
});

describe('agent ages like the desktop agents list', () => {
  it('uses the agents mod stamp when it is for the current state (done = idle), else the core status_ms', () => {
    const dir = tmpDir('times');
    try {
      fs.mkdirSync(path.join(dir, 'data', 'agents'), { recursive: true });
      const changed = { t1: { s: 'idle', at: 111 }, t2: { s: 'idle', at: 222 }, t4: { s: 'idle', at: 444 } };
      fs.writeFileSync(path.join(dir, 'data', 'agents', 'store.json'), JSON.stringify({ changed: JSON.stringify(changed) }));
      const times = new AgentTimes(dir, () => {});
      times.read();
      const table = new TerminalTable();
      table.reset(1, standardTerminals());
      const w = deriveWorld({
        core,
        docs: [{ machine: null, doc: layoutDoc() }],
        terminals: table,
        seenLocally: () => false,
        home: '/home/me',
        checkoutTop: (f) => f,
        statusSince: (id, st) => times.since(id, st),
      });
      expect(w.terminals.t1?.statusMs).toBe(111); // done counts as idle
      expect(w.terminals.t4?.statusMs).toBe(444);
      expect(w.terminals.t2?.statusMs).toBe(1793986987174); // working now: the stamp is stale
    } finally {
      rmDir(dir);
    }
  });
});

describe('diffWorld + applyPatch', () => {
  it('turns one world into the other', () => {
    const a = build();
    const terms = standardTerminals().filter((t) => t.address !== 't4');
    terms[0] = agent('t1', 'blocked', 3, 2);
    const b = build(terms);
    const ops = diffWorld(a, b);
    expect(ops.some((o) => o.op === 'delTerminal' && o.id === 't4')).toBe(true);
    expect(applyPatch(structuredClone(a), ops)).toEqual(b);
    expect(diffWorld(b, b)).toEqual([]);
    expect(applyPatch(emptyWorld(), diffWorld(emptyWorld(), b))).toEqual(b);
  });
});

describe('TerminalTable', () => {
  it('applies events as the schema says and ignores stale seq', () => {
    const t = new TerminalTable();
    t.reset(10, [agent('t1', 'working', 1, 1)]);
    expect(t.apply({ seq: 9, type: 'turn', terminal: 't1', data: { turn: 5 } })).toBe(false);
    t.apply({
      seq: 11,
      type: 'status',
      terminal: 't1',
      data: { status: { app: 'claude-code', state: 'done' }, records: {}, reported: true },
    });
    t.apply({ seq: 12, type: 'turn', terminal: 't1', data: { turn: 2, state: 'done' } });
    t.apply({ seq: 13, type: 'size', terminal: 't1', data: { cols: 80, rows: 24 } });
    t.apply({ seq: 14, type: 'labels', terminal: 't1', data: { labels: { 'herdr.seen': '2' } } });
    expect(t.get('t1')).toMatchObject({ status: { state: 'done' }, turn: 2, cols: 80, rows: 24, labels: { 'herdr.seen': '2' } });
    t.apply({ seq: 15, type: 'created', terminal: 't2', data: terminal('t2') });
    t.apply({ seq: 16, type: 'finished', terminal: 't2', data: { reason: 'exited', exit_code: 0, signal: null, finished_ms: 5 } });
    expect(t.get('t2')).toMatchObject({ state: 'finished', reason: 'exited' });
    expect(t.get('t2')?.foreground).toBeUndefined();
    t.apply({ seq: 17, type: 'lost', terminal: 't1', data: { reason: 'signaled', exit_code: null, signal: 9, finished_ms: null } });
    expect(t.get('t1')).toMatchObject({ state: 'live', pid: null });
    t.apply({ seq: 18, type: 'removed', terminal: 't2', data: {} });
    expect(t.get('t2')).toBeUndefined();
    // A labels event carrying a record adds the terminal.
    t.apply({ seq: 19, type: 'labels', terminal: 't3', data: { labels: {}, record: terminal('t3') } });
    expect(t.get('t3')).toBeDefined();
  });
});
