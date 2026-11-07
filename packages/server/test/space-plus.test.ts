import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { World } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowResume, checkAppRequest, checkCall, expectRun, markStartedTab, PolicyError } from '../src/core/policy.js';
import type { CoreTerminal } from '../src/core/types.js';
import { agentArgv } from '../src/spaces/agents.js';
import { CreateError } from '../src/spaces/create.js';
import { ClaudeSessions, claudeConfigs, oneLine, TranscriptSummaries } from '../src/spaces/sessions.js';
import { parseTabRequest } from '../src/spaces/tabs.js';
import { projectDirName } from '../src/transcripts/claude.js';
import type { LayoutDoc } from '../src/world/layout.js';
import { startBridge, type TestBridge, TOKEN } from './helpers/bridge.js';
import { layoutDoc } from './helpers/fixtures.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';

const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'herdr' };
const SPX = `sp${'c'.repeat(32)}`;

const user = (text: unknown, over: Record<string, unknown> = {}) => ({
  type: 'user',
  isSidechain: false,
  message: { role: 'user', content: text },
  timestamp: '2026-11-07T10:00:00Z',
  ...over,
});
const assistant = (id: string, text = 'ok') => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
});
const jsonl = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;

/** A home with ~/.claude, ~/.claude-work (projects symlinked to ~/.claude's) and ~/.claude-solo (its own). */
function fixtureHome(root: string, folder: string) {
  const home = path.join(root, 'home');
  const enc = projectDirName(folder);
  const main = path.join(home, '.claude/projects', enc);
  const solo = path.join(home, '.claude-solo/projects', enc);
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(solo, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-work'), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude/projects'), path.join(home, '.claude-work/projects'));
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude/sessions'), path.join(home, '.claude-work/sessions'));
  fs.mkdirSync(path.join(home, '.claude-notes'), { recursive: true }); // no projects: not a config
  const login = (email: string, plan: string, last: Record<string, string> = {}) =>
    JSON.stringify({
      oauthAccount: { emailAddress: email, planDisplayName: plan, accountUuid: 'secret-uuid' },
      projects: Object.fromEntries(Object.entries(last).map(([f, id]) => [f, { lastSessionId: id }])),
    });
  fs.writeFileSync(path.join(home, '.claude.json'), login('alice@example.com', 'Max'));
  fs.writeFileSync(path.join(home, '.claude-work/.claude.json'), login('bob@example.com', 'Pro', { [folder]: U(2) }));
  fs.writeFileSync(path.join(home, '.claude-solo/.claude.json'), login('carol@example.com', ''));
  const at = (file: string, entries: unknown[], minutesAgo: number) => {
    fs.writeFileSync(file, jsonl(entries));
    const t = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(file, t, t);
  };
  // 1: a titled session, prompt behind a meta entry and a reminder; 3 entries of one reply count once.
  at(
    path.join(main, `${U(1)}.jsonl`),
    [
      { type: 'permission-mode', permissionMode: 'default' },
      user('<local-command-caveat>x</local-command-caveat>', { isMeta: true, cwd: folder }),
      user('fix the\nlogin   bug<system-reminder>ignore me</system-reminder>', { cwd: folder }),
      assistant('m1', 'a'),
      assistant('m1', 'b'),
      assistant('m1', 'c'),
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'out' }], { cwd: folder }),
      assistant('m2'),
      { type: 'ai-title', aiTitle: 'Login bug' },
      { type: 'custom-title', customTitle: 'Fix login' },
      { type: 'ai-title', aiTitle: 'Later AI title' },
    ],
    30,
  );
  // 2: newest; .claude-work's .claude.json names it this folder's last session.
  at(path.join(main, `${U(2)}.jsonl`), [user('second', { cwd: folder }), assistant('m1')], 5);
  // 3: nothing typed (only a snapshot): hidden.
  at(path.join(main, `${U(3)}.jsonl`), [{ type: 'file-history-snapshot', snapshot: {} }], 1);
  // 4: another folder that encodes the same: hidden.
  at(path.join(main, `${U(4)}.jsonl`), [user('elsewhere', { cwd: `${folder}/x`.replace('/x', '-x') })], 2);
  // 5: only the solo config has it.
  at(
    path.join(solo, `${U(5)}.jsonl`),
    [user([{ type: 'text', text: '/review' }], { cwd: folder }), user('<command-name>/review</command-name>')],
    60,
  );
  // Not sessions: a subagent file, a stray name.
  at(path.join(main, 'agent-1234.jsonl'), [user('sub', { cwd: folder })], 0);
  at(path.join(main, 'notes.jsonl'), [user('x', { cwd: folder })], 0);
  return { home, main, solo };
}

const world = (terminals: Record<string, Partial<World['terminals'][string]>> = {}): World =>
  ({
    spaces: {},
    spaceOrder: [],
    tabs: {},
    terminals: Object.fromEntries(
      Object.entries(terminals).map(([id, t]) => [id, { id, machine: null, spaceId: 'sp1', program: 'claude', transcript: null, ...t }]),
    ),
  }) as unknown as World;

describe('resumable Claude sessions', () => {
  let root: string;
  let folder: string;
  beforeEach(() => {
    root = tmpDir('sess');
    folder = path.join(root, 'work/my_app');
    fs.mkdirSync(folder, { recursive: true });
  });
  afterEach(() => rmDir(root));

  it('finds the config folders, the default first, symlinked projects resolved', () => {
    const { home } = fixtureHome(root, folder);
    const cs = claudeConfigs(home);
    expect(cs.map((c) => c.id)).toEqual(['.claude', '.claude-solo', '.claude-work']);
    expect(cs[0]).toMatchObject({ isDefault: true, stateFile: path.join(home, '.claude.json') });
    expect(cs[2]?.projects).toBe(cs[0]?.projects);
    expect(cs[1]?.projects).not.toBe(cs[0]?.projects);
  });

  it('lists each session once, newest first, with title, first prompt, count and its config', () => {
    const { home } = fixtureHome(root, folder);
    const s = new ClaudeSessions({ home, procRoot: path.join(root, 'proc') });
    const list = s.list(folder, world());
    expect(list.map((x) => x.id)).toEqual([U(2), U(1), U(5)]);
    expect(list[1]).toMatchObject({
      title: 'Fix login',
      prompt: 'fix the login bug',
      messages: 3,
      config: '.claude',
      openIn: null,
      runningElsewhere: false,
    });
    // .claude-work's state names U(2) as this folder's last session: it is that login's.
    expect(list[0]).toMatchObject({ title: null, prompt: 'second', messages: 2, config: '.claude-work' });
    expect(list[2]).toMatchObject({ prompt: '/review', config: '.claude-solo' });
    expect(list[0]?.modifiedMs).toBeGreaterThan(list[1]?.modifiedMs ?? 0);
    const choices = s.choices(s.configs());
    expect(choices).toEqual([
      { id: '.claude', label: 'alice · max', isDefault: true },
      { id: '.claude-solo', label: 'carol', isDefault: false },
      { id: '.claude-work', label: 'bob · pro', isDefault: false },
    ]);
    expect(JSON.stringify({ list, choices })).not.toMatch(/secret-uuid|example\.com/);
    expect(s.list(path.join(root, 'nowhere'), world())).toEqual([]);
  });

  it('marks sessions running in a shown terminal (open) or elsewhere, from the registry and live claude processes', () => {
    const { home, main } = fixtureHome(root, folder);
    const proc = path.join(root, 'proc');
    const reg = (pid: number, session: string, env: string[]) => {
      fs.writeFileSync(path.join(home, '.claude/sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: session, cwd: folder }));
      fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
      fs.writeFileSync(path.join(proc, String(pid), 'comm'), 'claude\n');
      fs.writeFileSync(path.join(proc, String(pid), 'environ'), `${env.join('\0')}\0`);
    };
    reg(100, U(1), ['HC_TERMINAL_ID=t7', 'HOME=/x']);
    reg(200, U(5), []);
    // A registry entry whose process is gone, and one whose pid now runs something else.
    fs.writeFileSync(path.join(home, '.claude/sessions/300.json'), JSON.stringify({ pid: 300, sessionId: U(2) }));
    fs.mkdirSync(path.join(proc, '400'));
    fs.writeFileSync(path.join(proc, '400/comm'), 'bash\n');
    fs.writeFileSync(path.join(home, '.claude/sessions/400.json'), JSON.stringify({ pid: 400, sessionId: U(2) }));
    const s = new ClaudeSessions({ home, procRoot: proc });
    let list = s.list(folder, world({ t7: {} }));
    const by = (id: string) => list.find((x) => x.id === id);
    expect(by(U(1))).toMatchObject({ openIn: 't7', runningElsewhere: false });
    expect(by(U(5))).toMatchObject({ openIn: null, runningElsewhere: true });
    expect(by(U(2))).toMatchObject({ openIn: null, runningElsewhere: false });
    expect(s.isRunning(U(5))).toBe(true);
    expect(s.isRunning(U(2))).toBe(false);
    // Not in a shown terminal: running elsewhere.
    list = s.list(folder, world({}));
    expect(by(U(1))).toMatchObject({ openIn: null, runningElsewhere: true });
    // Found through a shown terminal's transcript (agent-resume label), claude in front.
    fs.rmSync(path.join(proc, '100'), { recursive: true });
    list = s.list(folder, world({ t9: { transcript: fs.realpathSync(path.join(main, `${U(2)}.jsonl`)) } }));
    expect(by(U(2))).toMatchObject({ openIn: 't9' });
    list = s.list(folder, world({ t9: { program: 'bash', transcript: fs.realpathSync(path.join(main, `${U(2)}.jsonl`)) } }));
    expect(by(U(2))).toMatchObject({ openIn: null });
  });

  it('resolves a session only by uuid, in that folder, for a config that can see it', () => {
    const { home } = fixtureHome(root, folder);
    const s = new ClaudeSessions({ home });
    expect(s.resolve(folder, U(1), undefined)?.id).toBe('.claude');
    expect(s.resolve(folder, U(2), undefined)?.id).toBe('.claude-work');
    expect(s.resolve(folder, U(1), '.claude-work')?.id).toBe('.claude-work');
    expect(s.resolve(folder, U(5), undefined)?.id).toBe('.claude-solo');
    expect(s.resolve(folder, U(5), '.claude')).toBeNull();
    expect(s.resolve(folder, U(1), '.claude-solo')).toBeNull();
    expect(s.resolve(folder, U(1), '.claude-nope')).toBeNull();
    expect(s.resolve(path.join(root, 'work'), U(1), undefined)).toBeNull();
    expect(s.resolve(folder, '../../x', undefined)).toBeNull();
    expect(s.resolve(folder, 'agent-1234', undefined)).toBeNull();
  });

  it('reads a transcript once, then only what was appended', () => {
    const { main } = fixtureHome(root, folder);
    const file = path.join(main, `${U(2)}.jsonl`);
    const t = new TranscriptSummaries();
    expect(t.get(file)?.messages).toBe(2);
    const first = t.bytesRead;
    expect(t.get(file)?.messages).toBe(2);
    expect(t.bytesRead).toBe(first);
    const more = jsonl([user('third'), assistant('m9')]);
    fs.appendFileSync(file, more);
    expect(t.get(file)).toMatchObject({ messages: 4, prompt: 'second' });
    expect(t.bytesRead).toBe(first + Buffer.byteLength(more));
    // A half-written line waits for its end.
    fs.appendFileSync(file, JSON.stringify(user('fourth')).slice(0, 20));
    expect(t.get(file)?.messages).toBe(4);
    fs.appendFileSync(file, `${JSON.stringify(user('fourth')).slice(20)}\n`);
    expect(t.get(file)?.messages).toBe(5);
    // Replaced (shorter): read again from the start.
    fs.writeFileSync(file, jsonl([user('new')]));
    expect(t.get(file)).toMatchObject({ messages: 1, prompt: 'new' });
  });

  it('cleans text to one line', () => {
    expect(oneLine('a\u001b[31m\n\tb  c')).toBe('a [31m b c');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('policy: new tabs', () => {
  const TB = `tb${'d'.repeat(32)}`;
  const claude = agentArgv('/bin/bash', ['claude']);
  let root: string;
  let folder: string;
  let home: string;
  beforeEach(() => {
    root = tmpDir('pol');
    folder = path.join(root, 'work/my_app');
    fs.mkdirSync(folder, { recursive: true });
    ({ home } = fixtureHome(root, folder));
  });
  afterEach(() => {
    allowResume(null);
    rmDir(root);
  });
  const run = (argv: string[], over: Record<string, unknown> = {}) => ({
    argv,
    cwd: folder,
    env: { ...ENV },
    labels: { 'herdr.space': SPX, 'herdr.tab': TB, 'herdr.seen': '0' },
    keep: true,
    ...over,
  });
  const tryRun = (argv: string[], config?: string, over: Record<string, unknown> = {}) => {
    expectRun(SPX, TB, argv, config);
    return () => checkCall('terminal.run', run(argv, over));
  };

  it('resumes only `claude --resume <uuid>` of a session in that folder, with that config', () => {
    const def = path.join(home, '.claude');
    const work = path.join(home, '.claude-work');
    const solo = path.join(home, '.claude-solo');
    const resume = (id: string, dir?: string) => [
      ...claude.slice(0, 4),
      ...(dir ? ['env', `CLAUDE_CONFIG_DIR=${dir}`] : []),
      'claude',
      '--resume',
      id,
    ];
    expect(tryRun(resume(U(1)), def)).toThrow(PolicyError); // no Claude launch offered yet
    allowResume(claude);
    expect(tryRun(resume(U(1)), def)).not.toThrow();
    expect(tryRun(resume(U(1), work), work)).not.toThrow();
    expect(tryRun(resume(U(5), solo), solo)).not.toThrow();
    const bad: Array<[string[], string | undefined, Record<string, unknown>?]> = [
      [resume(U(1)), undefined], // not announced as a resume
      [resume(U(5)), def], // not in the default config's projects
      [resume(U(1), solo), solo], // solo can't see it
      [resume(U(1)), work], // a non-default config without CLAUDE_CONFIG_DIR
      [resume(U(1), work), def], // env names another config
      [resume(U(9)), def], // no such session
      [resume(U(1)), def, { cwd: path.join(root, 'work') }], // another folder
      [resume('../../etc/passwd'), def],
      [resume(`${U(1)} `), def],
      [[...resume(U(1)), '--dangerously-skip-permissions'], def],
      [[...claude.slice(0, 4), 'claude', '--dangerously-skip-permissions', '--resume', U(1)], def],
      [[...claude.slice(0, 4), 'env', 'LD_PRELOAD=/x.so', 'claude', '--resume', U(1)], def],
      [[...claude.slice(0, 4), 'env', `CLAUDE_CONFIG_DIR=${root}/evil`, 'claude', '--resume', U(1)], `${root}/evil`],
      [['/bin/sh', '-c', 'claude --resume x', '/bin/sh', 'claude', '--resume', U(1)], def],
      [resume(U(1)), `${home}/.claude/../.claude`],
    ];
    for (const [i, [argv, config, over]] of bad.entries())
      expect(tryRun(argv, config, over), `${i} ${JSON.stringify(argv)}`).toThrow(PolicyError);
  });

  it('runs once per announcement, exactly the announced argv', () => {
    allowResume(claude);
    expectRun(SPX, TB, []);
    expect(() => checkCall('terminal.run', run(claude))).toThrow(PolicyError);
    expectRun(SPX, TB, []);
    expect(() => checkCall('terminal.run', run([]))).not.toThrow();
    expect(() => checkCall('terminal.run', run([]))).toThrow(PolicyError);
  });

  it('names and ends only the tabs it added; never the space they are in', () => {
    const tab = `tb${'e'.repeat(32)}`;
    expect(() => checkAppRequest({ do: 'tab.rename', args: { id: tab, name: 'Claude Code' } })).toThrow(PolicyError);
    expect(() => checkCall('terminal.kill', { terminal: 't777' })).toThrow(PolicyError);
    markStartedTab('t777', tab);
    expect(() => checkAppRequest({ do: 'tab.rename', args: { id: tab, name: 'Claude Code' } })).not.toThrow();
    expect(() => checkAppRequest({ do: 'tab.rename', args: { id: tab, name: 'x'.repeat(65) } })).toThrow(PolicyError);
    expect(() => checkAppRequest({ do: 'tab.rename', args: { id: tab, name: 'x', extra: 1 } })).toThrow(PolicyError);
    expect(() => checkAppRequest({ do: 'tab.close', args: { id: tab } })).toThrow(PolicyError);
    expect(() => checkAppRequest({ do: 'space.rename', args: { id: SPX, name: 'x' } })).toThrow(PolicyError);
    expect(() => checkCall('terminal.kill', { terminal: 't777' })).not.toThrow();
  });
});

describe('new tab requests', () => {
  it('take the shell, Claude, or a resume of a uuid with an optional config, nothing else', () => {
    expect(parseTabRequest({ start: { kind: 'shell' } })).toEqual({ kind: 'shell' });
    expect(parseTabRequest({ start: { kind: 'claude' } })).toEqual({ kind: 'claude' });
    expect(parseTabRequest({ start: { kind: 'resume', session: U(1) } })).toEqual({ kind: 'resume', session: U(1) });
    expect(parseTabRequest({ start: { kind: 'resume', session: U(1), config: '.claude-work' } })).toEqual({
      kind: 'resume',
      session: U(1),
      config: '.claude-work',
    });
    const bad = [
      null,
      [],
      {},
      { start: { kind: 'shell' }, folder: '/' },
      { start: { kind: 'shell', argv: ['x'] } },
      { start: { kind: 'agent', key: 'codex' } },
      { start: { kind: 'resume' } },
      { start: { kind: 'resume', session: 'abc' } },
      { start: { kind: 'resume', session: `${U(1)}\n` } },
      { start: { kind: 'resume', session: U(1), config: '/etc' } },
      { start: { kind: 'resume', session: U(1), config: '../.claude' } },
      { start: { kind: 'resume', session: U(1), args: '--dangerously-skip-permissions' } },
    ];
    for (const b of bad) expect(() => parseTabRequest(b), JSON.stringify(b)).toThrow(CreateError);
  });
});

/** The Herdr window's control socket: answers status, records `do` requests. */
class FakeApp {
  readonly requests: Array<Record<string, unknown>> = [];
  private server: net.Server | null = null;
  constructor(
    readonly socketPath: string,
    private readonly onDo: (cmd: string, args: Record<string, unknown>) => void = () => {},
  ) {}
  async listen(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (c: string) => {
        buf += c;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        this.requests.push(msg);
        if (msg.do) this.onDo(String(msg.do), msg.args as Record<string, unknown>);
        sock.end(`${JSON.stringify(msg.status ? { space: 'x', errors: [] } : { ok: true })}\n`);
      });
    });
    const server = this.server;
    await new Promise<void>((r) => server.listen(this.socketPath, r));
  }
  async close(): Promise<void> {
    const server = this.server;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}

function request(
  base: string,
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: Number(port),
        path: pathname,
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    req.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}

describe('a new tab in an open space, through the bridge', () => {
  let tb: TestBridge;
  let app: FakeApp | null;
  let root: string;
  let folder: string;
  let doc: LayoutDoc;

  beforeEach(async () => {
    root = tmpDir('plus');
    folder = path.join(root, 'work/my_app');
    fs.mkdirSync(folder, { recursive: true });
    const { home } = fixtureHome(root, folder);
    doc = layoutDoc();
    const spA = doc.spaces?.[0];
    if (spA) spA.id = SPX;
    tb = await startBridge({ home: root, claudeHome: home, installedAgents: { check: async () => ['claude'] } }, (core) => {
      const t1 = core.terminals.get('t1') as CoreTerminal;
      core.terminals.set('t1', {
        ...t1,
        cwd: folder,
        foreground: { ...(t1.foreground as object), cwd: folder } as CoreTerminal['foreground'],
      });
      core.docs.set('herdr-app', { value: structuredClone(doc), version: 7 });
      // The Herdr window adopting a labeled terminal into the space it names, as a new tab (window.rs `adopt`).
      core.onRun = (t) => {
        const space = doc.spaces?.find((s) => s.id === t.labels?.['herdr.space']);
        const tab = t.labels?.['herdr.tab'];
        if (!space || !tab) return;
        space.tabs?.push({
          id: tab,
          name: '',
          root: { type: 'row', id: tab, children: [{ type: 'block', id: `p${tab}`, content: { terminal: t.address } }] } as never,
        });
        setTimeout(() => core.setDoc('herdr-app', structuredClone(doc)), 20);
      };
    });
    app = new FakeApp(path.join(tb.dir, 'herdr-app', 'herdr-app.sock'), (cmd, args) => {
      if (cmd !== 'tab.rename') return;
      const t = doc.spaces?.flatMap((s) => s.tabs ?? []).find((x) => x.id === args.id);
      if (t) t.name = String(args.name);
      tb.core.setDoc('herdr-app', structuredClone(doc));
    });
    await app.listen();
  });
  afterEach(async () => {
    await app?.close();
    await tb.stop();
    rmDir(root);
  });

  const runs = () => tb.core.calls.filter((c) => c.method === 'terminal.run');

  it('lists the folder’s sessions and the logins that can resume them', async () => {
    const r = await request(tb.base, 'GET', `/api/spaces/${SPX}/sessions`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ folder: fs.realpathSync(folder), display: '~/work/my_app', appOpen: true, claudeInstalled: true });
    expect((r.body.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual([U(2), U(1), U(5)]);
    expect((r.body.configs as Array<{ id: string }>).map((c) => c.id)).toEqual(['.claude', '.claude-solo', '.claude-work']);
    expect((await request(tb.base, 'GET', `/api/spaces/sp${'0'.repeat(32)}/sessions`)).status).toBe(404);
    expect((await request(tb.base, 'GET', '/api/spaces/spB/sessions')).status).toBe(404);
  });

  it('adds a shell tab, a Claude tab and a resumed session to the space, as the + menu does', async () => {
    const shell = await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'shell' } });
    expect(shell.status, JSON.stringify(shell.body)).toBe(200);
    const { tabId, terminalId } = shell.body as { tabId: string; terminalId: string };
    expect(tabId).toMatch(/^tb[0-9a-f]{32}$/);
    expect(runs().at(-1)?.params).toMatchObject({
      argv: [],
      cwd: fs.realpathSync(folder),
      env: ENV,
      keep: true,
      labels: { 'herdr.space': SPX, 'herdr.tab': tabId, 'herdr.seen': '0' },
    });
    expect(tb.bridge.store.world.terminals[terminalId]).toMatchObject({ spaceId: SPX, tabId });
    expect(tb.bridge.store.world.spaces[SPX]?.tabIds).toContain(tabId);
    expect(app?.requests.some((m) => m.do)).toBe(false); // a terminal tab keeps Herdr's number

    const c = await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'claude' } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const argv = runs().at(-1)?.params.argv as string[];
    expect(argv.slice(1)).toEqual(['-ic', '"$@"; exec "$0" -i', argv[0], 'claude']);
    expect(app?.requests).toContainEqual({ do: 'tab.rename', args: { id: c.body.tabId, name: 'Claude Code' } });

    const r = await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'resume', session: U(2) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rv = runs().at(-1)?.params.argv as string[];
    expect(rv.slice(4)).toEqual(['env', `CLAUDE_CONFIG_DIR=${path.join(root, 'home/.claude-work')}`, 'claude', '--resume', U(2)]);
    const r2 = await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'resume', session: U(1), config: '.claude' } });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect((runs().at(-1)?.params.argv as string[] | undefined)?.slice(4)).toEqual(['claude', '--resume', U(1)]);
    // Six within ten minutes is fine; the seventh is refused before anything starts.
    expect((await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'shell' } })).status).toBe(200);
    expect((await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'shell' } })).status).toBe(200);
    const n = runs().length;
    const limited = await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'shell' } });
    expect(limited.status).toBe(429);
    expect(runs().length).toBe(n);
  });

  it('refuses unknown spaces, sessions of other folders or logins, and open sessions; nothing starts', async () => {
    const cases: Array<[string, unknown, number]> = [
      [`sp${'0'.repeat(32)}`, { start: { kind: 'shell' } }, 404],
      ['spB', { start: { kind: 'shell' } }, 404],
      [SPX, { start: { kind: 'resume', session: U(9) } }, 400],
      [SPX, { start: { kind: 'resume', session: U(5), config: '.claude' } }, 400],
      [SPX, { start: { kind: 'resume', session: U(3).replace('0', 'x') } }, 400],
      [SPX, { start: { kind: 'exec', argv: ['rm'] } }, 400],
    ];
    for (const [space, body, status] of cases) {
      const r = await request(tb.base, 'POST', `/api/spaces/${space}/tabs`, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(typeof r.body.error).toBe('string');
    }
    expect(runs()).toHaveLength(0);
    await app?.close();
    app = null;
    const closed = await request(tb.base, 'POST', `/api/spaces/${SPX}/tabs`, { start: { kind: 'shell' } });
    expect(closed.status).toBe(409);
    expect(runs()).toHaveLength(0);
  });

  it('ends a terminal the window never adopts', async () => {
    tb.core.onRun = null;
    const { TabCreator } = await import('../src/spaces/tabs.js');
    const { ClaudeSessions: CS } = await import('../src/spaces/sessions.js');
    const { CoreClient } = await import('../src/core/client.js');
    const { HerdrApp } = await import('../src/spaces/app.js');
    const client = new CoreClient({ socketPath: tb.core.socketPath });
    client.start();
    try {
      await until(() => client.connected);
      const creator = new TabCreator({
        core: client,
        store: tb.bridge.store,
        app: new HerdrApp(path.join(tb.dir, 'herdr-app')),
        offers: async () => [],
        sessions: new CS({ home: path.join(root, 'home') }),
        home: root,
        adoptTimeoutMs: 200,
      });
      await expect(creator.create(SPX, { start: { kind: 'shell' } })).rejects.toThrow(/didn’t pick up/);
      expect(tb.core.calls.filter((c) => c.method === 'terminal.kill' || c.method === 'terminal.rm').map((c) => c.method)).toEqual([
        'terminal.kill',
        'terminal.rm',
      ]);
      await expect(creator.create(SPX, { start: { kind: 'claude' } })).rejects.toThrow(/isn’t installed/);
    } finally {
      client.stop();
    }
  });
});
