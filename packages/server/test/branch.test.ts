import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { branchNameError, type World } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowResume, checkAppRequest, checkCall, expectRun, PolicyError } from '../src/core/policy.js';
import { agentArgv } from '../src/spaces/agents.js';
import { CreateError, type Offer } from '../src/spaces/create.js';
import { type ClaudeConfig, ClaudeSessions } from '../src/spaces/sessions.js';
import { claudeArgv, parseTabRequest, TabCreator } from '../src/spaces/tabs.js';
import { projectDirName } from '../src/transcripts/claude.js';
import { rmDir, tmpDir } from './helpers/tmp.js';

const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'herdr' };
const SPX = `sp${'c'.repeat(32)}`;
const NAMES = ['branch test é "q"', "it's $(rm -rf ~) `x` ; & | *", '日本語 ブランチ 🌿', 'a'];
const CLAUDE = agentArgv('/bin/bash', ['claude']);

/** ~/.claude (default), ~/.claude-work (projects symlinked to ~/.claude's), ~/.claude-solo (its own); U(1) in the shared store, U(5) in solo's. */
function fixture(root: string) {
  const folder = path.join(root, 'work/my app');
  const home = path.join(root, 'home');
  const enc = projectDirName(folder);
  fs.mkdirSync(folder, { recursive: true });
  for (const d of ['.claude/projects', '.claude/sessions', '.claude-solo/projects', '.claude-work'])
    fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude/projects'), path.join(home, '.claude-work/projects'));
  fs.symlinkSync(path.join(home, '.claude/sessions'), path.join(home, '.claude-work/sessions'));
  fs.mkdirSync(path.join(home, '.claude/projects', enc));
  fs.mkdirSync(path.join(home, '.claude-solo/projects', enc));
  const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd: folder })}\n`;
  const main = path.join(home, '.claude/projects', enc, `${U(1)}.jsonl`);
  const solo = path.join(home, '.claude-solo/projects', enc, `${U(5)}.jsonl`);
  fs.writeFileSync(main, line);
  fs.writeFileSync(solo, line);
  return { folder, home, main, solo };
}

/** A live `claude` running `session`, in Claude's registry and a fake /proc. */
function running(home: string, proc: string, pid: number, session: string, env: string[]) {
  fs.writeFileSync(path.join(home, '.claude/sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: session }));
  fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(proc, String(pid), 'comm'), 'claude\n');
  fs.writeFileSync(path.join(proc, String(pid), 'environ'), `${env.join('\0')}\0`);
}

describe('branch names', () => {
  it('take any one-line text up to 64 characters, nothing that could read as an option or break a line', () => {
    for (const n of [...NAMES, 'x'.repeat(64)]) expect(branchNameError(n), n).toBeNull();
    for (const n of [
      '',
      '   ',
      ' lead',
      'trail ',
      'x'.repeat(65),
      'a\nb',
      'a\rb',
      'tab\there',
      'esc\u001b[31m',
      'nel\u0085',
      'ls ',
      '-n',
      '--fork',
    ])
      expect(branchNameError(n), JSON.stringify(n)).not.toBeNull();
  });
});

describe('branch argv', () => {
  const def = { id: '.claude', dir: '/h/.claude', isDefault: true } as ClaudeConfig;
  const work = { id: '.claude-work', dir: '/h/.claude-work', isDefault: false } as ClaudeConfig;

  it('is the + menu’s Claude plus --resume <id> --fork-session --name <name>, the name one element; env for another login', () => {
    for (const name of NAMES) {
      const tail = ['--resume', U(1), '--fork-session', '--name', name];
      expect(claudeArgv(CLAUDE, def, tail)).toEqual(['/bin/bash', '-ic', '"$@"; exec "$0" -i', '/bin/bash', 'claude', ...tail]);
      expect(claudeArgv(CLAUDE, work, tail)).toEqual([
        ...CLAUDE.slice(0, 4),
        'env',
        'CLAUDE_CONFIG_DIR=/h/.claude-work',
        'claude',
        ...tail,
      ]);
    }
  });

  it('reaches the program as the same arguments through the interactive-shell wrapper (bash and sh)', () => {
    const shHome = tmpDir('sh-home');
    for (const shell of ['/bin/bash', '/bin/sh']) {
      if (!fs.existsSync(shell)) continue;
      for (const name of NAMES) {
        // The program prints each argument it got on its own line; the shell that stays after it reads EOF and leaves.
        const argv = agentArgv(shell, ['printf', '<%s>\\n', '--resume', U(1), '--fork-session', '--name', name]);
        const out = execFileSync(argv[0] as string, argv.slice(1), {
          input: '',
          encoding: 'utf8',
          timeout: 10_000,
          env: { PATH: process.env.PATH, HOME: shHome },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        expect(
          out.split('\n').filter((l) => l.startsWith('<')),
          `${shell} ${name}`,
        ).toEqual(['--resume', U(1), '--fork-session', '--name', name].map((a) => `<${a}>`));
      }
    }
    rmDir(shHome);
  });
});

describe('the login a running session uses', () => {
  let root: string;
  beforeEach(() => {
    root = tmpDir('blogin');
  });
  afterEach(() => rmDir(root));

  it('is its process’s CLAUDE_CONFIG_DIR, the default without one; unknown folders refused; not running: unknown', () => {
    const { home } = fixture(root);
    const proc = path.join(root, 'proc');
    const s = new ClaudeSessions({ home, procRoot: proc });
    expect(s.runningConfig(U(1))).toBeUndefined();
    running(home, proc, 100, U(1), ['HC_TERMINAL_ID=t7']);
    expect(s.runningConfig(U(1))?.id).toBe('.claude');
    running(home, proc, 100, U(1), [`CLAUDE_CONFIG_DIR=${home}/.claude-work`]);
    expect(s.runningConfig(U(1))?.id).toBe('.claude-work');
    running(home, proc, 100, U(1), [`CLAUDE_CONFIG_DIR=${home}/.claude-work/`]);
    expect(s.runningConfig(U(1))?.id).toBe('.claude-work');
    running(home, proc, 100, U(1), [`CLAUDE_CONFIG_DIR=${root}/elsewhere/.claude`]);
    expect(s.runningConfig(U(1))).toBeNull();
    running(home, proc, 100, U(1), ['CLAUDE_CONFIG_DIR=.claude-work']);
    expect(s.runningConfig(U(1))).toBeNull();
    fs.writeFileSync(path.join(proc, '100/comm'), 'bash\n');
    expect(s.runningConfig(U(1))).toBeUndefined();
  });
});

describe('policy: branching a conversation', () => {
  const TB = `tb${'d'.repeat(32)}`;
  let root: string;
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    root = tmpDir('bpol');
    f = fixture(root);
    allowResume(CLAUDE);
  });
  afterEach(() => {
    allowResume(null);
    rmDir(root);
  });
  const tryRun = (argv: string[], config: string | undefined, cwd = f.folder) => {
    expectRun(SPX, TB, argv, config);
    return () =>
      checkCall('terminal.run', {
        argv,
        cwd,
        env: { ...ENV },
        labels: { 'herdr.space': SPX, 'herdr.tab': TB, 'herdr.seen': '0' },
        keep: true,
      });
  };
  const branch = (id: string, name: string, dir?: string) => [
    ...CLAUDE.slice(0, 4),
    ...(dir ? ['env', `CLAUDE_CONFIG_DIR=${dir}`] : []),
    'claude',
    '--resume',
    id,
    '--fork-session',
    '--name',
    name,
  ];

  it('starts exactly `--resume <id> --fork-session --name <name>` of a session in that folder for that login', () => {
    const def = path.join(f.home, '.claude');
    const work = path.join(f.home, '.claude-work');
    const solo = path.join(f.home, '.claude-solo');
    for (const n of NAMES) expect(tryRun(branch(U(1), n), def)).not.toThrow();
    expect(tryRun(branch(U(1), 'x', work), work)).not.toThrow();
    expect(tryRun(branch(U(5), 'x', solo), solo)).not.toThrow();
    const bad: Array<[string[], string | undefined, string?]> = [
      [branch(U(5), 'x'), def], // not in that login's projects
      [branch(U(1), 'x', solo), solo],
      [branch(U(9), 'x'), def],
      [branch(U(1), 'x'), def, path.join(root, 'work')], // another folder
      [branch(U(1), 'x'), work], // another login without its env
      [branch(U(1), 'a\nb'), def],
      [branch(U(1), '--dangerously-skip-permissions'), def],
      [branch(U(1), 'x'.repeat(65)), def],
      [branch(U(1), ''), def],
      [[...branch(U(1), 'x'), 'y'], def],
      [[...branch(U(1), 'x').slice(0, -1)], def], // --name without one
      [[...CLAUDE.slice(0, 4), 'claude', '--resume', U(1), '--name', 'x', '--fork-session'], def],
      [[...CLAUDE.slice(0, 4), 'claude', '--resume', U(1), '--fork-session', '--model', 'x'], def],
      [[...CLAUDE.slice(0, 4), 'claude', '--resume', U(1), '--fork-session', '-n', 'x'], def],
      [[...CLAUDE.slice(0, 4), 'claude', '--fork-session', '--resume', U(1), '--name', 'x'], def],
    ];
    for (const [i, [argv, config, cwd]] of bad.entries())
      expect(tryRun(argv, config, cwd), `${i} ${JSON.stringify(argv)}`).toThrow(PolicyError);
    // Announced with one name, started with another.
    expectRun(SPX, TB, branch(U(1), 'a'), def);
    expect(() =>
      checkCall('terminal.run', {
        argv: branch(U(1), 'b'),
        cwd: f.folder,
        env: { ...ENV },
        labels: { 'herdr.space': SPX, 'herdr.tab': TB, 'herdr.seen': '0' },
        keep: true,
      }),
    ).toThrow(PolicyError);
  });
});

describe('branch requests', () => {
  it('take an agent of the space and a valid name, nothing else', () => {
    expect(parseTabRequest({ start: { kind: 'branch', terminal: 't7', name: 'branch test é "q"' } })).toEqual({
      kind: 'branch',
      terminal: 't7',
      name: 'branch test é "q"',
    });
    const bad = [
      { start: { kind: 'branch', terminal: 't7' } },
      { start: { kind: 'branch', name: 'x' } },
      { start: { kind: 'branch', terminal: 't7', name: 'x', session: U(1) } },
      { start: { kind: 'branch', terminal: 't7', name: 'x', config: '.claude' } },
      { start: { kind: 'branch', terminal: '../t7', name: 'x' } },
      { start: { kind: 'branch', terminal: 't7', name: 7 } },
      { start: { kind: 'branch', terminal: 't7', name: 'a\nb' } },
      { start: { kind: 'branch', terminal: 't7', name: '-x' } },
      { start: { kind: 'branch', terminal: 't7', name: 'y'.repeat(65) } },
    ];
    for (const b of bad) expect(() => parseTabRequest(b), JSON.stringify(b)).toThrow(CreateError);
    try {
      parseTabRequest({ start: { kind: 'branch', terminal: 't7', name: '' } });
    } catch (e) {
      expect((e as CreateError).field).toBe('name');
    }
  });
});

describe('branching an agent’s conversation into a new tab', () => {
  let root: string;
  let f: ReturnType<typeof fixture>;
  let proc: string;
  let world: World;
  let store: EventEmitter & { world: World };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const renames: Array<[string, string]> = [];

  const offer: Offer = { choice: { kind: 'agent', key: 'claude', name: 'Claude Code', installed: true }, argv: CLAUDE };
  const creator = (over: Partial<ConstructorParameters<typeof TabCreator>[0]> = {}) =>
    new TabCreator({
      core: {
        async call<T>(method: string, params: Record<string, unknown> = {}) {
          checkCall(method, params); // what CoreClient does before sending
          calls.push({ method, params });
          const address = `t${calls.length + 100}`;
          const labels = params.labels as Record<string, string>;
          // Herdr adopts it into the space.
          setTimeout(() => {
            world.terminals[address] = { id: address, tabId: labels['herdr.tab'] } as never;
            store.emit('patch');
          }, 5);
          return { address } as T;
        },
      },
      store,
      app: { isOpen: async () => true, renameTab: async (id: string, name: string) => void renames.push([id, name]) },
      offers: async () => [offer],
      sessions: new ClaudeSessions({ home: f.home, procRoot: proc }),
      home: root,
      ...over,
    });

  beforeEach(() => {
    root = tmpDir('bmake');
    f = fixture(root);
    proc = path.join(root, 'proc');
    fs.mkdirSync(proc);
    calls.length = 0;
    renames.length = 0;
    world = {
      spaces: { [SPX]: { id: SPX, machine: null, folder: f.folder, tabIds: ['tbA'], name: 'S' } },
      spaceOrder: [SPX],
      tabs: { tbA: { id: 'tbA', panes: [{ terminalId: 't7' }] } },
      terminals: {
        t7: { id: 't7', machine: null, spaceId: SPX, tabId: 'tbA', program: 'claude', cwd: f.folder, transcript: fs.realpathSync(f.main) },
        t8: { id: 't8', machine: null, spaceId: SPX, tabId: 'tbA', program: 'bash', cwd: f.folder, transcript: null },
        t9: { id: 't9', machine: null, spaceId: 'spOther', program: 'claude', cwd: f.folder, transcript: fs.realpathSync(f.main) },
      },
    } as unknown as World;
    store = Object.assign(new EventEmitter(), { world });
  });
  afterEach(() => {
    allowResume(null);
    rmDir(root);
  });

  it('starts the fork in the same space, in the agent’s folder, with its login, and names the tab', async () => {
    running(f.home, proc, 100, U(1), ['HC_TERMINAL_ID=t7']);
    const name = 'branch test é "q"';
    const r = await creator().create(SPX, { start: { kind: 'branch', terminal: 't7', name } });
    const run = calls.find((c) => c.method === 'terminal.run')?.params;
    expect(run).toMatchObject({
      cwd: fs.realpathSync(f.folder),
      keep: true,
      env: ENV,
      labels: { 'herdr.space': SPX, 'herdr.tab': r.tabId, 'herdr.seen': '0' },
    });
    expect(run?.argv).toEqual([...CLAUDE, '--resume', U(1), '--fork-session', '--name', name]);
    expect(renames).toEqual([[r.tabId, name]]);
    expect(() => checkAppRequest({ do: 'tab.rename', args: { id: r.tabId, name } })).not.toThrow();
  });

  it('uses the login the source claude runs under (another one: env CLAUDE_CONFIG_DIR first)', async () => {
    running(f.home, proc, 100, U(1), [`CLAUDE_CONFIG_DIR=${f.home}/.claude-work`]);
    await creator().create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'w' } });
    expect(((calls[0]?.params.argv ?? []) as string[]).slice(4)).toEqual([
      'env',
      `CLAUDE_CONFIG_DIR=${f.home}/.claude-work`,
      'claude',
      '--resume',
      U(1),
      '--fork-session',
      '--name',
      'w',
    ]);
  });

  it('works for a session that isn’t running any more (its owner login), and from the space folder when the agent moved', async () => {
    world.terminals.t7 = { ...world.terminals.t7, cwd: root } as never;
    await creator().create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'gone' } });
    expect(calls[0]?.params).toMatchObject({ cwd: fs.realpathSync(f.folder) });
    expect(((calls[0]?.params.argv ?? []) as string[]).slice(4)).toEqual(['claude', '--resume', U(1), '--fork-session', '--name', 'gone']);
  });

  it('refuses non-Claude agents, other spaces, unknown logins and lost folders; nothing starts', async () => {
    const c = creator();
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 't8', name: 'x' } })).rejects.toMatchObject({ status: 400 });
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 't9', name: 'x' } })).rejects.toMatchObject({ status: 404 });
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 'nope', name: 'x' } })).rejects.toMatchObject({ status: 404 });
    running(f.home, proc, 100, U(1), [`CLAUDE_CONFIG_DIR=${root}/other/.claude`]);
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'x' } })).rejects.toMatchObject({ status: 400 });
    // Running under solo, which can't see this transcript.
    running(f.home, proc, 100, U(1), [`CLAUDE_CONFIG_DIR=${f.home}/.claude-solo`]);
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'x' } })).rejects.toMatchObject({ status: 409 });
    fs.rmSync(path.join(proc, '100'), { recursive: true });
    fs.renameSync(f.main, `${f.main}.gone`);
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'x' } })).rejects.toMatchObject({ status: 409 });
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'bad\nname' } })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it('counts towards the new-tab limit', async () => {
    const c = creator({ maxPerWindow: 1 });
    await c.create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'one' } });
    await expect(c.create(SPX, { start: { kind: 'branch', terminal: 't7', name: 'two' } })).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });
});
