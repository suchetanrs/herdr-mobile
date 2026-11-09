import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { World } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../src/core/client.js';
import { allowLaunches, checkAppRequest, checkCall, expectRun, markStarted, PolicyError } from '../src/core/policy.js';
import type { CoreTerminal } from '../src/core/types.js';
import { BUILT_IN_PROGRAMS } from '../src/programs.js';
import { agentArgv, agentChoices, BUILT_IN, InstalledAgents, installedLine, parseInstalled, startable } from '../src/spaces/agents.js';
import { HerdrApp } from '../src/spaces/app.js';
import { CreateError, paneSize, parseRequest, SpaceCreator } from '../src/spaces/create.js';
import { checkFolder, complete, display, expand, FolderError, folderChoices, recentSpaces } from '../src/spaces/folders.js';
import type { LayoutDoc } from '../src/world/layout.js';
import { startBridge, type TestBridge, TOKEN } from './helpers/bridge.js';
import { layoutDoc } from './helpers/fixtures.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';

const SP = `sp${'a'.repeat(32)}`;
const TB = `tb${'b'.repeat(32)}`;
const ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'herdr' };
const run = (over: Record<string, unknown> = {}) => ({
  argv: [],
  cwd: '/home/me/x',
  env: { ...ENV },
  labels: { 'herdr.space': SP, 'herdr.tab': TB, 'herdr.seen': '0' },
  keep: true,
  ...over,
});

/** terminal.run as the spaces module sends it: announced first (expectRun), with the same labels and argv. */
const announced = (p: Record<string, unknown>) => {
  const l = (p.labels ?? {}) as Record<string, string>;
  expectRun(String(l['herdr.space']), String(l['herdr.tab']), Array.isArray(p.argv) ? (p.argv as string[]) : []);
  return p;
};

describe('policy: new spaces', () => {
  it('allows terminal.run only in the shape herdr-app spawns, once per announced run', () => {
    expect(() => checkCall('terminal.run', run())).toThrow(PolicyError);
    expect(() => checkCall('terminal.run', announced(run()))).not.toThrow();
    expect(() => checkCall('terminal.run', run())).toThrow(PolicyError);
    expect(() => checkCall('terminal.run', announced(run({ size: { cols: 120, rows: 40 } })))).not.toThrow();
    expectRun(SP, TB, []);
    expect(() => checkCall('terminal.run', run({ argv: agentArgv('/bin/bash', ['claude']) }))).toThrow(PolicyError);
    const bad: Array<Record<string, unknown>> = [
      run({ keep: false }),
      run({ line: 'rm -rf ~' }),
      run({ on: 'vps' }),
      run({ name: 'x' }),
      run({ wait: true }),
      run({ env: { ...ENV, LD_PRELOAD: '/x.so' } }),
      run({ labels: { 'herdr.space': SP, 'herdr.tab': TB } }),
      run({ labels: { 'herdr.space': SP, 'herdr.tab': TB, 'herdr.seen': '0', 'herdr.pinned': '1' } }),
      run({ labels: { 'herdr.space': 'spX', 'herdr.tab': TB, 'herdr.seen': '0' } }),
      run({ labels: { 'herdr.space': SP, 'herdr.tab': TB, 'herdr.seen': '5' } }),
      run({ cwd: 'relative' }),
      run({ cwd: '/home/me/\0x' }),
      run({ size: { cols: 0, rows: 4 } }),
      run({ size: { cols: 80, rows: 24, x: 1 } }),
      run({ argv: ['rm', '-rf', '/'] }),
      run({ argv: ['bash'] }),
    ];
    for (const p of bad) expect(() => checkCall('terminal.run', announced(p)), JSON.stringify(p)).toThrow(PolicyError);
  });

  it('allows exactly the launches the spaces module offered', () => {
    const claude = agentArgv('/bin/bash', ['claude']);
    expect(() => checkCall('terminal.run', announced(run({ argv: claude })))).toThrow(PolicyError);
    allowLaunches([claude, ['reviewer']]);
    expect(() => checkCall('terminal.run', announced(run({ argv: claude })))).not.toThrow();
    expect(() => checkCall('terminal.run', announced(run({ argv: ['reviewer'] })))).not.toThrow();
    expect(() => checkCall('terminal.run', announced(run({ argv: [...claude, '--dangerously-skip-permissions'] })))).toThrow(PolicyError);
    allowLaunches([]);
    expect(() => checkCall('terminal.run', announced(run({ argv: claude })))).toThrow(PolicyError);
  });

  it('allows codex only as Herdr starts it (codex --no-daemon), from the + menu’s offers', async () => {
    const dir = tmpDir('app');
    try {
      const creator = new SpaceCreator({
        core: { call: async () => ({ templates: [] }) } as never,
        store: { on() {}, off() {}, world: {} } as never,
        app: { isOpen: async () => true, renameSpace: async () => {} } as never,
        installed: { check: async () => ['codex'] },
        home: dir,
        herdrAppDir: dir,
        shell: '/bin/bash',
      });
      const offers = await creator.offers();
      const codex = agentArgv('/bin/bash', ['codex', '--no-daemon']);
      expect(offers.find((o) => o.choice.key === 'codex')?.argv).toEqual(codex);
      expect(() => checkCall('terminal.run', announced(run({ argv: codex })))).not.toThrow();
      expect(() => checkCall('terminal.run', announced(run({ argv: agentArgv('/bin/bash', ['codex']) })))).toThrow(PolicyError);
      // Not installed: offered greyed, never allowed.
      expect(() => checkCall('terminal.run', announced(run({ argv: agentArgv('/bin/bash', ['claude']) })))).toThrow(PolicyError);
    } finally {
      allowLaunches([]);
      rmDir(dir);
    }
  });

  it('ends and names only what the bridge started', () => {
    expect(() => checkCall('terminal.kill', { terminal: 't1' })).toThrow(PolicyError);
    expect(() => checkCall('terminal.rm', { terminal: 't1' })).toThrow(PolicyError);
    expect(() => checkAppRequest({ do: 'space.rename', args: { id: SP, name: 'x' } })).toThrow(PolicyError);
    markStarted('t900', SP);
    expect(() => checkCall('terminal.kill', { terminal: 't900' })).not.toThrow();
    expect(() => checkCall('terminal.rm', { terminal: 't900' })).not.toThrow();
    expect(() => checkCall('terminal.kill', { terminal: 't900', caller: 't1' })).toThrow(PolicyError);
    expect(() => checkAppRequest({ do: 'space.rename', args: { id: SP, name: 'x' } })).not.toThrow();
    expect(() => checkAppRequest({ do: 'space.rename', args: { id: SP, name: 'x'.repeat(65) } })).toThrow(PolicyError);
    expect(() => checkAppRequest({ do: 'space.close', args: { id: SP, confirmed: true } })).toThrow(PolicyError);
    expect(() => checkAppRequest({ do: 'tab.new', args: {} })).toThrow(PolicyError);
    expect(() => checkAppRequest({ status: true })).not.toThrow();
    expect(() => checkAppRequest({ status: true, raise: true })).toThrow(PolicyError);
    // Everything else stays closed.
    for (const m of ['terminal.keys', 'terminal.keep', 'doc.set', 'server.stop', 'file.write', 'terminal.put']) {
      expect(() => checkCall(m, {})).toThrow(PolicyError);
    }
  });
});

describe('request validation', () => {
  it('takes folder, optional name and what to start', () => {
    expect(parseRequest({ folder: '~/x', start: { kind: 'shell' } })).toEqual({ folder: '~/x', name: '', start: { kind: 'shell' } });
    expect(parseRequest({ folder: '~/x', name: '  api  ', start: { kind: 'agent', key: 'claude' } })).toMatchObject({
      name: 'api',
      start: { kind: 'agent', key: 'claude' },
    });
    const bad: Array<[unknown, string | undefined]> = [
      [null, undefined],
      [[], undefined],
      [{ folder: 3, start: { kind: 'shell' } }, 'folder'],
      [{ folder: '~', name: 'x'.repeat(65), start: { kind: 'shell' } }, 'name'],
      [{ folder: '~', name: 'a\u001b[31m', start: { kind: 'shell' } }, 'name'],
      [{ folder: '~', start: { kind: 'agent', key: 'claude; rm -rf ~' } }, 'start'],
      [{ folder: '~', start: { kind: 'agent', key: 'claude', argv: ['x'] } }, 'start'],
      [{ folder: '~', start: { kind: 'exec', cmd: 'x' } }, 'start'],
      [{ folder: '~', start: { kind: 'shell' }, machine: 'vps' }, undefined],
    ];
    for (const [body, field] of bad) {
      let err: unknown;
      try {
        parseRequest(body);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(body)).toBeInstanceOf(CreateError);
      expect((err as CreateError).field).toBe(field);
      expect((err as CreateError).status).toBe(400);
    }
  });
});

describe('folders', () => {
  let home: string;
  let outside: string;
  beforeEach(() => {
    const root = tmpDir('home');
    home = path.join(root, 'me');
    outside = path.join(root, 'elsewhere');
    for (const d of ['code/herdr', 'code/hm', 'Code2', '.secret', 'docs']) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(home, 'code/notes.txt'), 'x');
    fs.symlinkSync(outside, path.join(home, 'code/escape'));
    fs.symlinkSync(path.join(home, 'docs'), path.join(home, 'code/docs-link'));
  });
  afterEach(() => rmDir(path.dirname(home)));

  it('expands ~ and relative paths from the home folder', () => {
    expect(expand('~', home)).toBe(home);
    expect(expand('~/code', home)).toBe(path.join(home, 'code'));
    expect(expand('code', home)).toBe(path.join(home, 'code'));
    expect(() => expand('~root/x', home)).toThrow(FolderError);
    expect(() => expand('', home)).toThrow(FolderError);
    expect(() => expand('x'.repeat(1025), home)).toThrow(FolderError);
    expect(display(path.join(home, 'code'), home)).toBe('~/code');
  });

  it('accepts existing folders in the home folder only', () => {
    expect(checkFolder('~/code/herdr', home)).toBe(fs.realpathSync(path.join(home, 'code/herdr')));
    expect(checkFolder('~/code/docs-link', home)).toBe(fs.realpathSync(path.join(home, 'docs')));
    expect(() => checkFolder('~/nope', home)).toThrow('No such folder');
    expect(() => checkFolder('~/code/notes.txt', home)).toThrow('not a folder');
    expect(() => checkFolder('~/../elsewhere', home)).toThrow('home folder');
    expect(() => checkFolder('~/code/../../elsewhere', home)).toThrow('home folder');
    expect(() => checkFolder('~/code/escape', home)).toThrow('home folder');
    expect(() => checkFolder('/etc', home)).toThrow('home folder');
    // A folder Herdr already has a space in may be outside it.
    expect(checkFolder(outside, home, [outside])).toBe(fs.realpathSync(outside));
  });

  it('completes sub-folders, hidden ones only when asked, never outside home', () => {
    expect(complete('~/', home)).toEqual(['~/code/', '~/Code2/', '~/docs/']);
    expect(complete('~/co', home)).toEqual(['~/code/', '~/Code2/']);
    expect(complete('~/code/', home)).toEqual(['~/code/docs-link/', '~/code/escape/', '~/code/herdr/', '~/code/hm/']);
    expect(complete('~/code/h', home)).toEqual(['~/code/herdr/', '~/code/hm/']);
    expect(complete('~/.s', home)).toEqual(['~/.secret/']);
    expect(complete('', home)).toEqual(['~/code/', '~/Code2/', '~/docs/']);
    expect(complete('/etc/', home)).toEqual([]);
    expect(complete('~/../', home)).toEqual([]);
    expect(complete('~/code/escape/', home)).toEqual([]);
    expect(complete('~/missing/', home)).toEqual([]);
  });

  it('offers open spaces’ folders then recently closed ones, existing ones once', () => {
    const appDir = path.join(path.dirname(home), 'herdr-app');
    fs.mkdirSync(appDir);
    fs.writeFileSync(
      path.join(appDir, 'view.json'),
      JSON.stringify({
        recent: [
          { name: 'Old', folder: path.join(home, 'docs') },
          { name: 'Gone', folder: path.join(home, 'gone') },
        ],
      }),
    );
    const world = {
      spaceOrder: ['s1', 's2', 's3'],
      spaces: {
        s1: { id: 's1', machine: null, name: 'Herdr', folder: path.join(home, 'code/herdr') },
        s2: { id: 's2', machine: 'vps', name: 'Remote', folder: '/srv' },
        s3: { id: 's3', machine: null, name: 'Again', folder: path.join(home, 'code/herdr') },
      },
    } as unknown as World;
    const got = folderChoices(world, recentSpaces(appDir), home);
    expect(got.map((f) => [f.display, f.from, f.label])).toEqual([
      ['~/code/herdr', 'space', 'Herdr'],
      ['~/docs', 'recent', 'Old'],
    ]);
  });
});

describe('agents', () => {
  it('match the web app’s programs table (herdr-app 0.1.14 defaults/programs.json)', () => {
    const file = fileURLToPath(new URL('../../web/src/lib/programs.json', import.meta.url));
    const table = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      programs: Record<string, { name: string; match?: string[]; run?: string[] }>;
    };
    const pick = ({ name, match, run }: { name?: string; match?: string[]; run?: string[] }) => ({
      name,
      ...(match ? { match } : {}),
      ...(run ? { run } : {}),
    });
    expect(Object.fromEntries(Object.entries(BUILT_IN_PROGRAMS).map(([k, e]) => [k, pick(e)]))).toEqual(
      Object.fromEntries(Object.entries(table.programs).map(([k, e]) => [k, pick(e)])),
    );
    const fromTable = Object.entries(table.programs)
      .filter(([, e]) => e.run?.length)
      .map(([key, e]) => ({ key, name: e.name, run: e.run }));
    expect([...BUILT_IN].sort((a, b) => a.key.localeCompare(b.key))).toEqual(fromTable.sort((a, b) => a.key.localeCompare(b.key)));
    expect(BUILT_IN.find((s) => s.key === 'codex')?.run).toEqual(['codex', '--no-daemon']);
    expect(BUILT_IN_PROGRAMS.kimi?.match).toEqual(['kimi-code', 'kimicodecli']);
  });

  it('come most-picked first, with the person’s programs.json on top', () => {
    const dir = tmpDir('app');
    try {
      expect(
        startable(dir)
          .slice(0, 9)
          .map((s) => s.key),
      ).toEqual(['claude', 'codex', 'pi', 'opencode', 'cursor', 'copilot', 'amp', 'gemini', 'grok']);
      fs.writeFileSync(
        path.join(dir, 'programs.json'),
        JSON.stringify({
          programs: {
            claude: { run: ['claude', '--verbose'] },
            mine: { name: 'Mine', run: ['mine'] },
            unnamed: { run: ['unnamed'] },
            long: { run: ['x', 'a\nb'] },
            'bad key': { run: ['x'] },
          },
        }),
      );
      const list = startable(dir);
      expect(list.find((s) => s.key === 'claude')).toEqual({ key: 'claude', name: 'Claude Code', run: ['claude', '--verbose'] });
      expect(list.find((s) => s.key === 'codex')).toEqual({ key: 'codex', name: 'Codex', run: ['codex', '--no-daemon'] });
      expect(list.find((s) => s.key === 'mine')).toEqual({ key: 'mine', name: 'Mine', run: ['mine'] });
      expect(list.find((s) => s.key === 'unnamed')).toEqual({ key: 'unnamed', name: 'unnamed', run: ['unnamed'] });
      // Never offered (so never allowed): a word with a newline, a key Herdr's menus wouldn't take.
      expect(list.find((s) => s.key === 'long')).toBeUndefined();
      expect(list.find((s) => s.key === 'bad key')).toBeUndefined();
      // A wrong type anywhere: Herdr refuses the whole file and keeps its built-ins; so do we.
      fs.writeFileSync(
        path.join(dir, 'programs.json'),
        JSON.stringify({ programs: { claude: { run: ['claude', '--verbose'] }, bad: { run: 'x' } } }),
      );
      expect(startable(dir)).toEqual(startable(path.join(dir, 'missing')));
    } finally {
      rmDir(dir);
    }
  });

  it('start in the interactive shell, which stays (window.rs unix_agent_argv)', () => {
    expect(agentArgv('/bin/bash', ['claude'])).toEqual(['/bin/bash', '-ic', '"$@"; exec "$0" -i', '/bin/bash', 'claude']);
    expect(agentArgv('/usr/bin/fish', ['pi'])).toEqual([
      '/usr/bin/fish',
      '-ic',
      'command $argv[2..]; exec $argv[1] -i',
      '/usr/bin/fish',
      'pi',
    ]);
  });

  it('are checked the way programs.rs does it', async () => {
    expect(installedLine(['claude', "o'x"], false)).toBe(
      "unalias -- 'claude' 2>/dev/null; command -v 'claude' >/dev/null 2>&1 && printf 'herdr-has:%s\\n' 'claude'; " +
        "unalias -- 'o'\\''x' 2>/dev/null; command -v 'o'\\''x' >/dev/null 2>&1 && printf 'herdr-has:%s\\n' 'o'\\''x';",
    );
    expect(parseInstalled('\u001b]0;prompt\u0007herdr-has:claude\nhello herdr-has:pi\n', ['claude', 'codex', 'pi'])).toEqual([
      'claude',
      'pi',
    ]);
    let calls = 0;
    let now = 0;
    const checker = new InstalledAgents(
      '/bin/bash',
      async () => {
        calls++;
        return 'herdr-has:claude\n';
      },
      () => now,
    );
    expect(await checker.check(['claude', 'codex'])).toEqual(['claude']);
    await checker.check(['claude', 'codex']);
    expect(calls).toBe(1);
    now = 61_000;
    await checker.check(['claude', 'codex']);
    expect(calls).toBe(2);
    expect(agentChoices(BUILT_IN, ['codex']).map((c) => [c.key, c.installed])).toEqual([
      ['codex', true],
      ['claude', false],
      ['pi', false],
    ]);
  });
});

describe('pane size', () => {
  it('is the most common grid of a terminal alone in its tab here', () => {
    const w = {
      tabs: {
        a: { panes: [{ terminalId: 't1' }] },
        b: { panes: [{ terminalId: 't2' }] },
        c: { panes: [{ terminalId: 't3' }] },
        d: { panes: [{ terminalId: 't4' }, { terminalId: 't5' }] },
      },
      terminals: {
        t1: { machine: null, cols: 173, rows: 41 },
        t2: { machine: null, cols: 173, rows: 41 },
        t3: { machine: 'vps', cols: 80, rows: 24 },
        t4: { machine: null, cols: 86, rows: 41 },
      },
    } as unknown as World;
    expect(paneSize(w)).toEqual({ cols: 173, rows: 41 });
    expect(paneSize({ tabs: {}, terminals: {} } as unknown as World)).toBeNull();
  });
});

/** A Herdr window stand-in on herdr-app.sock: answers `status`, applies `space.rename` to the doc. */
class FakeApp {
  readonly requests: unknown[] = [];
  private server: net.Server | null = null;
  constructor(
    readonly socketPath: string,
    private readonly onDo: (cmd: string, args: Record<string, unknown>) => unknown = () => ({ ok: true }),
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
        const reply = msg.status ? { space: 'spA', errors: [] } : this.onDo(String(msg.do), msg.args as Record<string, unknown>);
        sock.end(`${JSON.stringify(reply)}\n`);
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

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [host, port] = base.split(':');
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: Number(port),
        path: '/api/spaces',
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
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
    req.end(data);
  });
}

function get(base: string, pathname: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const [host, port] = base.split(':');
  return new Promise((resolve, reject) => {
    http
      .get({ host, port: Number(port), path: pathname, headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      })
      .on('error', reject);
  });
}

describe('making a space through the bridge', () => {
  let tb: TestBridge;
  let app: FakeApp | null = null;
  let home: string;
  let homeRoot: string;

  /** The Herdr window adopting a labeled terminal: appends a space under the label's id (window.rs `adopt`). */
  const adopt = (doc: () => LayoutDoc, set: (d: LayoutDoc) => void) => (t: CoreTerminal) => {
    const space = t.labels?.['herdr.space'];
    const tab = t.labels?.['herdr.tab'];
    if (!space || !tab) return;
    const d = doc();
    d.spaces?.push({
      id: space,
      name: '',
      folder: t.cwd ?? '',
      tabs: [
        {
          id: tab,
          name: '',
          root: { type: 'row', id: tab, children: [{ type: 'block', id: `p${space}`, content: { terminal: t.address } }] } as never,
        },
      ],
    });
    set(d);
  };

  beforeEach(async () => {
    homeRoot = tmpDir('nshome');
    home = path.join(homeRoot, 'me');
    fs.mkdirSync(path.join(home, 'work/api'), { recursive: true });
    let doc = layoutDoc();
    tb = await startBridge({ home, installedAgents: { check: async () => ['claude'] } }, (core) => {
      core.templates = [{ name: 'reviewer', description: 'Reviews', command: 'claude' }];
      core.onRun = adopt(
        () => doc,
        (d) => {
          doc = d;
          setTimeout(() => core.setDoc('herdr-app', structuredClone(doc)), 20);
        },
      );
    });
    app = new FakeApp(path.join(tb.dir, 'herdr-app', 'herdr-app.sock'), (cmd, args) => {
      if (cmd === 'space.rename') {
        const s = doc.spaces?.find((x) => x.id === args.id);
        if (s) s.name = String(args.name);
        tb.core.setDoc('herdr-app', structuredClone(doc));
      }
      return { ok: true };
    });
    await app.listen();
  });
  afterEach(async () => {
    await app?.close();
    app = null;
    await tb.stop();
    rmDir(homeRoot);
  });

  it('offers folders, the installed agents and core templates', async () => {
    const r = await get(tb.base, '/api/new-space');
    expect(r.status).toBe(200);
    expect(r.body.appOpen).toBe(true);
    const starts = r.body.starts as Array<{ kind: string; key: string; installed: boolean }>;
    expect(starts.slice(0, 3).map((s) => [s.kind, s.key, s.installed])).toEqual([
      ['agent', 'claude', true],
      ['agent', 'codex', false],
      ['agent', 'pi', false],
    ]);
    expect(starts.at(-1)).toMatchObject({ kind: 'template', key: 'reviewer', installed: true });
    const c = await get(tb.base, `/api/folders?path=${encodeURIComponent('~/w')}`);
    expect(c.body).toEqual({ entries: ['~/work/'] });
  });

  it('starts a labeled, kept terminal that Herdr adopts, then names the space', async () => {
    const r = await post(tb.base, { folder: '~/work/api', name: 'API', start: { kind: 'agent', key: 'claude' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { spaceId, tabId, terminalId } = r.body as { spaceId: string; tabId: string; terminalId: string };
    expect(spaceId).toMatch(/^sp[0-9a-f]{32}$/);
    expect(tabId).toMatch(/^tb[0-9a-f]{32}$/);
    const call = tb.core.calls.find((c) => c.method === 'terminal.run');
    expect(call?.params).toMatchObject({
      cwd: fs.realpathSync(path.join(home, 'work/api')),
      keep: true,
      env: ENV,
      labels: { 'herdr.space': spaceId, 'herdr.tab': tabId, 'herdr.seen': '0' },
    });
    const argv = (call?.params.argv ?? []) as string[];
    expect(argv.slice(1)).toEqual(['-ic', '"$@"; exec "$0" -i', argv[0], 'claude']);
    expect(tb.bridge.store.world.spaces[spaceId]).toBeDefined();
    expect(tb.bridge.store.world.spaceOrder.at(-1)).toBe(spaceId);
    expect(app?.requests).toContainEqual({ do: 'space.rename', args: { id: spaceId, name: 'API' } });
    await until(() => tb.bridge.store.world.spaces[spaceId]?.name === 'API');
    expect(tb.bridge.store.world.terminals[terminalId]?.spaceId).toBe(spaceId);
    // The shell: no argv (the core picks the machine's shell, as space.new without argv); no name: no rename.
    const before = app?.requests.length ?? 0;
    const r2 = await post(tb.base, { folder: '~/work', start: { kind: 'shell' } });
    expect(r2.status).toBe(200);
    expect(tb.core.calls.filter((c) => c.method === 'terminal.run').at(-1)?.params.argv).toEqual([]);
    expect(app?.requests.slice(before).some((m) => (m as { do?: string }).do)).toBe(false);
  });

  it('refuses what isn’t offered, folders outside home, and too many at once; inline errors name the field', async () => {
    const cases: Array<[unknown, number, string | undefined]> = [
      [{ folder: '~/work', start: { kind: 'agent', key: 'codex' } }, 400, 'start'],
      [{ folder: '~/work', start: { kind: 'agent', key: 'nope' } }, 400, 'start'],
      [{ folder: '~/../', start: { kind: 'shell' } }, 400, 'folder'],
      [{ folder: '/etc', start: { kind: 'shell' } }, 400, 'folder'],
      [{ folder: '~/missing', start: { kind: 'shell' } }, 400, 'folder'],
    ];
    for (const [body, status, field] of cases) {
      const r = await post(tb.base, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.body.field).toBe(field);
    }
    expect(tb.core.calls.some((c) => c.method === 'terminal.run')).toBe(false);
    // Cross-site posts never reach it.
    const x = await post(
      tb.base,
      { folder: '~/work', start: { kind: 'shell' } },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    );
    expect(x.status).toBe(403);
    expect((await post(tb.base, 'nope', { 'content-type': 'text/plain' })).status).toBe(415);
    // Six an hour... per ten minutes; the seventh is refused before anything starts.
    for (let i = 0; i < 6; i++) expect((await post(tb.base, { folder: '~/work', start: { kind: 'shell' } })).status).toBe(200);
    const runs = tb.core.calls.filter((c) => c.method === 'terminal.run').length;
    const limited = await post(tb.base, { folder: '~/work', start: { kind: 'shell' } });
    expect(limited.status).toBe(429);
    expect(tb.core.calls.filter((c) => c.method === 'terminal.run').length).toBe(runs);
  });

  it('refuses while Herdr is closed, and ends a terminal Herdr never adopts', async () => {
    await app?.close();
    app = null;
    const r = await post(tb.base, { folder: '~/work', start: { kind: 'shell' } });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/isn’t open/);
    expect(tb.core.calls.some((c) => c.method === 'terminal.run')).toBe(false);
    expect(await new HerdrApp(path.join(tb.dir, 'herdr-app')).isOpen()).toBe(false);
  });
});

describe('a window that never adopts', () => {
  it('kills and removes the terminal again', async () => {
    const homeRoot = tmpDir('nshome');
    const home = path.join(homeRoot, 'me');
    fs.mkdirSync(path.join(home, 'work'), { recursive: true });
    const tb = await startBridge({ home, installedAgents: { check: async () => [] } });
    const app = new FakeApp(path.join(tb.dir, 'herdr-app', 'herdr-app.sock'));
    await app.listen();
    const client = new CoreClient({ socketPath: tb.core.socketPath });
    client.start();
    try {
      await until(() => client.connected);
      const creator = new SpaceCreator({
        core: client,
        store: tb.bridge.store,
        app: new HerdrApp(path.join(tb.dir, 'herdr-app')),
        installed: { check: async () => [] },
        home,
        herdrAppDir: path.join(tb.dir, 'herdr-app'),
        shell: '/bin/bash',
        adoptTimeoutMs: 200,
      });
      await expect(creator.create({ folder: '~/work', start: { kind: 'shell' } })).rejects.toThrow(/didn’t pick up/);
      const address =
        tb.core.calls.find((c) => c.method === 'terminal.run') &&
        [...tb.core.calls].reverse().find((c) => c.method === 'terminal.kill')?.params.terminal;
      expect(address).toBeTruthy();
      expect(tb.core.calls.filter((c) => c.method === 'terminal.kill' || c.method === 'terminal.rm').map((c) => c.method)).toEqual([
        'terminal.kill',
        'terminal.rm',
      ]);
      expect(tb.core.terminals.has(String(address))).toBe(false);
    } finally {
      client.stop();
      await app.close();
      await tb.stop();
      rmDir(homeRoot);
    }
  });
});
