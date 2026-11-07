import { describe, expect, it } from 'vitest';
import { sampleWorld, term } from '../test/fixtures';
import {
  accountLabel,
  agentTag,
  attentionCounts,
  inbox,
  rollup,
  shownStatus,
  spaceCounts,
  spaceTerminals,
  tabLabel,
  terminalName,
  UNPLACED,
  unplacedSpace,
} from './model';

describe('world model', () => {
  it('files spaces into Needs you / Working / Done / Idle by their rollup', () => {
    const groups = inbox(sampleWorld());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sections.map((s) => [s.id, s.spaces.map((x) => x.name)])).toEqual([
      ['blocked', ['beta']],
      ['done', ['alpha']],
      ['idle', ['gamma', 'empty']],
    ]);
  });

  it('groups by machine when another machine has spaces', () => {
    const w = sampleWorld();
    w.spaces.spC = { ...(w.spaces.spC as NonNullable<typeof w.spaces.spC>), machine: 'rohan' };
    expect(inbox(w).map((g) => g.machine)).toEqual([null, 'rohan']);
  });

  it('names rows like Herdr: a telling title for an unnamed tab, the tab name when named, the program for shells', () => {
    const w = sampleWorld();
    expect(tabLabel(w.tabs.tbA1 as NonNullable<typeof w.tabs.tbA1>, w)).toBe('fix the login bug');
    expect(terminalName(w.terminals.t1 as NonNullable<typeof w.terminals.t1>, w)).toBe('fix the login bug');
    expect(terminalName(w.terminals.t3 as NonNullable<typeof w.terminals.t3>, w)).toBe('review');
    // user@host titles say nothing: the program's name.
    expect(terminalName(w.terminals.t2 as NonNullable<typeof w.terminals.t2>, w)).toBe('bash');
    expect(terminalName(w.terminals.t9 as NonNullable<typeof w.terminals.t9>, w)).toBe('reviewer');
  });

  it("nests sub-agents under their parent, and a sub-agent's done reads idle", () => {
    const w = sampleWorld();
    expect(spaceTerminals(w, 'spA').map((t) => t.id)).toEqual(['t1', 't9', 't2', 't3']);
    expect(shownStatus(term('x', { parent: 't1', status: 'done' }))).toBe('idle');
    expect(shownStatus(term('x', { parent: 't1', word: 'error', status: 'blocked' }))).toBe('blocked');
  });

  it('counts agents and attention', () => {
    const w = sampleWorld();
    expect(spaceCounts(w, 'spA')).toMatchObject({ agents: 3, terminals: 4, tabs: 2, working: 1, blocked: 1, done: 1 });
    expect(attentionCounts(w)).toEqual({ blocked: 2, done: 1, agents: 5 });
    expect(rollup(['idle', null, 'working', 'done'])).toBe('done');
  });

  it('puts terminals in no pane into a made-up space (diagnostics mode)', () => {
    const w = sampleWorld();
    expect(unplacedSpace(w)).toBeNull();
    w.terminals.t7 = term('t7', { spaceId: null, tabId: null, paneId: null, status: 'working' });
    expect(unplacedSpace(w)?.status).toBe('working');
    expect(spaceTerminals(w, UNPLACED).map((t) => t.id)).toEqual(['t7']);
    expect(
      inbox(w)[0]
        ?.sections.find((s) => s.id === 'working')
        ?.spaces.map((s) => s.id),
    ).toEqual([UNPLACED]);
  });
});

describe('account labels (my-agents `account`)', () => {
  it('"name, plan", just the name without a plan; non-Claude agents show their program in lower case', () => {
    expect(accountLabel(term('t1', { account: { name: 'alice', plan: 'pro' } }))).toBe('alice, pro');
    expect(accountLabel(term('t1', { account: { name: 'bob', plan: '' } }))).toBe('bob');
    expect(accountLabel(term('t1'))).toBeNull();
    expect(agentTag(term('t1', { account: { name: 'alice', plan: 'max' } }))).toBe('alice, max');
    expect(agentTag(term('t1'))).toBeNull(); // Claude without a known account: nothing, as my-agents
    expect(agentTag(term('t1', { app: 'codex', program: 'codex' }))).toBe('codex');
  });
});
