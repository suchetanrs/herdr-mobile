import type { CoreTerminal } from '../../src/core/types.js';
import type { LayoutDoc } from '../../src/world/layout.js';

/** A terminal record shaped like `events.subscribe` snapshots (data/events_sample.txt). */
export function terminal(address: string, over: Partial<CoreTerminal> = {}): CoreTerminal {
  return {
    address,
    argv: ['/bin/bash'],
    cols: 173,
    rows: 41,
    created_ms: 1793960571053,
    cwd: '/home/me/work/proj',
    die_with_parent: false,
    exit_code: null,
    finished_ms: null,
    foreground: { argv: ['bash'], cwd: '/home/me/work/proj', name: 'bash', pid: 4000 },
    identity: 'ghostty',
    keep: true,
    labels: {},
    name: null,
    notify: true,
    parent: null,
    pid: 3000,
    reason: null,
    reported: false,
    rm: false,
    screen: 'exact',
    signal: null,
    state: 'live',
    status: null,
    status_ms: null,
    template: null,
    title: 'me@box: ~',
    turn: 0,
    ...over,
  };
}

export function agent(address: string, state: string, turn: number, seen: number | null, over: Partial<CoreTerminal> = {}): CoreTerminal {
  return terminal(address, {
    foreground: { argv: ['claude'], cwd: '/home/me/work/proj', name: 'claude', pid: 5000 },
    reported: true,
    status: { app: 'claude-code', state },
    status_ms: 1793986987174,
    turn,
    labels: {
      ...(seen === null ? {} : { 'herdr.seen': String(seen) }),
      'agent-resume': JSON.stringify({ agent: 'claude', session: 's1', transcript: `/home/me/.claude/projects/p/${address}.jsonl` }),
    },
    title: 'working on it',
    ...over,
  });
}

const block = (id: string, terminal: string) => ({ type: 'block', id, content: { terminal } });
const row = (id: string, ...children: unknown[]) => ({ type: 'row', id, children });

/**
 * Layout like data/doc_herdr-app.json: a named space with one tab, an unnamed
 * space (named after its first terminal's checkout) with two tabs, one of them
 * split, and a named tab.
 */
export function layoutDoc(): LayoutDoc {
  return {
    spaces: [
      {
        id: 'spA',
        name: 'Alpha',
        folder: '/home/me/alpha',
        tabs: [{ id: 'tbA1', name: '', root: row('tbA1', block('pA1', 't1')) as never }],
      },
      {
        id: 'spB',
        name: '',
        folder: '/home/me',
        tabs: [
          {
            id: 'tbB1',
            name: '',
            root: row('tbB1', block('pB1', 't2'), { type: 'column', id: 'c1', children: [block('pB2', 't3')] }) as never,
          },
          { id: 'tbB2', name: 'review', root: row('tbB2', block('pB3', 't4'), block('pGone', 't99')) as never },
        ],
      },
    ],
  };
}

/** t1: done (unseen turn), t2: working, t3: plain bash, t4: idle (seen), t5: sub-agent of t2 (blocked), t6: paneless agent. */
export function standardTerminals(): CoreTerminal[] {
  return [
    agent('t1', 'done', 3, 2),
    agent('t2', 'working', 5, 5, { cwd: '/home/me/work/proj/sub', foreground: { name: 'claude', cwd: '/home/me/work/proj/sub' } }),
    terminal('t3'),
    agent('t4', 'idle', 7, 7, { name: 'reviewer' }),
    agent('t5', 'blocked', 1, 0, { parent: 't2' }),
    agent('t6', 'working', 0, 0),
  ];
}
