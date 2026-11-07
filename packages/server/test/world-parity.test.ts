import { afterEach, describe, expect, it } from 'vitest';
import { deriveWorld } from '../src/world/derive.js';
import { TerminalTable } from '../src/world/terminals.js';
import { startBridge, type TestBridge } from './helpers/bridge.js';
import { agent, layoutDoc, standardTerminals, terminal } from './helpers/fixtures.js';
import { sleep, until } from './helpers/tmp.js';
import { Client } from './helpers/wsClient.js';

let tb: TestBridge | null = null;
afterEach(async () => {
  await tb?.stop();
  tb = null;
});

const core = { connected: true, version: '0.1.18', name: 'box' };

function derive(terms = standardTerminals(), doc = layoutDoc(), machine: string | null = null) {
  const table = new TerminalTable();
  table.reset(10, terms);
  return deriveWorld({
    core,
    docs: [{ machine, doc }],
    terminals: table,
    seenLocally: () => true,
    home: '/home/me',
    checkoutTop: (f) => f,
  });
}

describe('world parity with Herdr desktop (task 6b)', () => {
  it('an agent without a herdr.seen label starts seen, so idle after a bridge restart, not done (REVIEW P1-6)', async () => {
    // t1 finished a turn before the bridge started, and has no herdr.seen (the desktop didn't create it).
    tb = await startBridge({}, (core) => core.terminals.set('t1', agent('t1', 'done', 3, null)));
    expect(tb.bridge.store.world.terminals.t1?.seenTurn).toBeNull();
    expect(tb.bridge.store.world.terminals.t1?.status).toBe('idle');
    expect(tb.bridge.store.world.spaces.spA?.status).toBe('idle');
  });

  it('ignores an older layout doc reply that arrives after a newer one (REVIEW P2-6)', async () => {
    tb = await startBridge({});
    const older = layoutDoc();
    (older.spaces?.[0] as { name: string }).name = 'Old name';
    const newer = layoutDoc();
    (newer.spaces?.[0] as { name: string }).name = 'New name';
    tb.core.replyDelays['doc.get'] = [150];
    tb.core.setDoc('herdr-app', older);
    await sleep(20);
    tb.core.setDoc('herdr-app', newer);
    await until(() => tb?.bridge.store.world.spaces.spA?.name === 'New name', 2000);
    await sleep(300);
    expect(tb.bridge.store.world.spaces.spA?.name).toBe('New name');
  });

  it('a blocked agent whose pane arrives after its word still rings (REVIEW P2-7)', async () => {
    tb = await startBridge({});
    const c = new Client(tb.wsUrl());
    await until(() => c.world);
    tb.core.emit('created', 't8', agent('t8', 'working', 1, 1));
    await sleep(50);
    tb.core.status('t8', 'blocked');
    await sleep(700);
    expect(c.of('alert')).toHaveLength(0);
    const doc = layoutDoc();
    (doc.spaces?.[0]?.tabs ?? []).push({ id: 'tbA2', name: '', root: { type: 'block', id: 'pA2', content: { terminal: 't8' } } as never });
    tb.core.setDoc('herdr-app', doc);
    await until(() => c.of('alert').length === 1, 3000);
    expect(c.of('alert')[0]?.alert).toMatchObject({ kind: 'blocked', terminalId: 't8' });
    c.close();
  });

  it('a working/blocked flap inside one 500 ms tick does not alert (REVIEW P2-12)', async () => {
    tb = await startBridge({});
    const c = new Client(tb.wsUrl());
    await until(() => c.world);
    tb.core.status('t2', 'blocked');
    await sleep(120);
    tb.core.status('t2', 'working');
    await sleep(900);
    expect(c.of('alert')).toHaveLength(0);
    // A real block (held across a tick) does.
    tb.core.status('t2', 'blocked');
    await until(() => c.of('alert').length === 1, 2000);
    c.close();
  });

  it('sub-agents: only live ones are listed, a paneless one is never "done", and one with its own pane keeps it (REVIEW P2-8)', () => {
    const terms = [
      ...standardTerminals(),
      agent('t20', 'done', 2, 0, { parent: 't2' }),
      agent('t21', 'done', 1, 0, { parent: 't2', state: 'finished', reason: 'exited' }),
      agent('t22', 'error', 1, 0, { parent: 't2' }),
      agent('t23', 'working', 1, 1, { parent: 't1' }),
    ];
    const doc = layoutDoc();
    (doc.spaces?.[1]?.tabs ?? []).push({ id: 'tbB3', name: '', root: { type: 'block', id: 'pB9', content: { terminal: 't23' } } as never });
    const w = derive(terms, doc);
    expect(w.terminals.t2?.children).toEqual(['t20', 't22', 't5']);
    expect(w.terminals.t21).toBeUndefined();
    expect(w.terminals.t20?.status).toBe('idle');
    expect(w.terminals.t22?.status).toBe('blocked');
    expect(w.terminals.t23).toMatchObject({ tabId: 'tbB3', paneId: 'pB9' });
  });

  it('tabs are numbered among the tabs still shown (REVIEW P2-9)', () => {
    const terms = standardTerminals().map((t) =>
      t.address === 't2' || t.address === 't3' ? { ...t, state: 'finished', reason: 'exited' } : t,
    );
    const w = derive(terms);
    // tbB1's panes exited, so tbB1 is closed: "review" is now tab 1 of spB.
    expect(w.spaces.spB?.tabIds).toEqual(['tbB2']);
    expect(w.tabs.tbB2?.index).toBe(1);
    const unnamed = layoutDoc();
    (unnamed.spaces?.[1]?.tabs?.[1] as { name: string }).name = '';
    expect(derive(terms, unnamed).tabs.tbB2?.name).toBe('1');
  });

  it("names a remote machine's unnamed space after the git checkout there (REVIEW P2-11)", async () => {
    tb = await startBridge({});
    // Its doc names terminals unqualified; the core lists them as rohan/<id>.
    for (const t of standardTerminals()) tb.core.emit('created', `rohan/${t.address}`, { ...t, address: `rohan/${t.address}` });
    tb.core.emit('created', 'rohan/t2', {
      ...terminal('rohan/t2'),
      cwd: '/srv/repo/sub/dir',
      foreground: { argv: ['bash'], name: 'bash', cwd: '/srv/repo/sub/dir', pid: 1 },
    });
    tb.core.docs.set('rohan:herdr-app', { value: layoutDoc(), version: 1 });
    tb.core.execResults['/srv/repo/sub/dir'] = '/srv/repo\nmain\n';
    tb.core.machines = ['rohan'];
    await until(() => tb?.bridge.store.world.spaces['rohan/spB']?.name === 'repo', 4000);
    const exec = tb.core.calls.find((x) => x.method === 'machine.exec');
    expect(exec?.params).toEqual({
      on: 'rohan',
      argv: ['git', '-C', '/srv/repo/sub/dir', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      timeout: 10,
    });
  });
});
