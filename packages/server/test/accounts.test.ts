import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAccounts } from '../src/accounts/accounts.js';
import { accountOf, ConfigCache, findClaudeProcesses, scanAccounts } from '../src/accounts/scan.js';
import { startBridge, type TestBridge } from './helpers/bridge.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';

const SECRETS = ['sk-ant-oat01-SECRET', 'sk-ant-ort01-REFRESH', 'org-uuid-SECRET', 'acct-uuid-SECRET', 'Rohan Secret', 'example.org'];

/** A .claude.json shaped like the real one: credentials-ish fields next to the two we want. */
function claudeJson(email: string | undefined, plan: string | undefined, org = 'claude_max'): string {
  return JSON.stringify({
    numStartups: 12,
    userID: 'acct-uuid-SECRET',
    primaryApiKey: 'sk-ant-oat01-SECRET',
    projects: { '/home/me/x': { allowedTools: [], history: ['secret prompt'] } },
    oauthAccount: {
      accountUuid: 'acct-uuid-SECRET',
      emailAddress: email,
      organizationUuid: 'org-uuid-SECRET',
      organizationName: 'Rohan Secret',
      displayName: 'Rohan Secret',
      organizationType: org,
      planDisplayName: plan,
      refreshToken: 'sk-ant-ort01-REFRESH',
    },
  });
}

interface Proc {
  pid: number;
  comm: string;
  env?: Record<string, string>;
}

/** A fake /proc: <pid>/comm and <pid>/environ (NUL-separated, trailing NUL like the kernel's). */
function writeProc(root: string, procs: Proc[]): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'uptime'), '1 1\n');
  fs.mkdirSync(path.join(root, 'self'), { recursive: true });
  for (const p of procs) {
    const dir = path.join(root, String(p.pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'comm'), `${p.comm}\n`);
    if (p.env) {
      const body = Object.entries({ PATH: '/usr/bin', ...p.env })
        .map(([k, v]) => `${k}=${v}\0`)
        .join('');
      fs.writeFileSync(path.join(dir, 'environ'), body);
    }
  }
}

let dir = '';
afterEach(() => {
  if (dir) rmDir(dir);
  dir = '';
});

function fixture() {
  dir = tmpDir('acc');
  const home = path.join(dir, 'home');
  const bob = path.join(dir, 'bob');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bob, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), claudeJson('alice@example.org', 'Pro'));
  fs.writeFileSync(path.join(bob, '.claude.json'), claudeJson('bob@example.org', undefined, 'claude_max'));
  const proc = path.join(dir, 'proc');
  writeProc(proc, [
    { pid: 100, comm: 'claude', env: { HC_TERMINAL_ID: 't1' } },
    { pid: 101, comm: 'claude', env: { HC_TERMINAL_ID: 't2', CLAUDE_CONFIG_DIR: bob } },
    { pid: 102, comm: 'bash', env: { HC_TERMINAL_ID: 't3' } }, // not claude
    { pid: 103, comm: 'claude', env: { HOME: home } }, // no terminal: a claude outside Herdr
    { pid: 104, comm: 'claude' }, // environ unreadable (another user's, or gone)
    { pid: 105, comm: 'claude', env: { HC_TERMINAL_ID: 't9', HC_TERMINAL_SOCKET: '/run/other/core.sock' } }, // another core
    { pid: 106, comm: 'claude-helper', env: { HC_TERMINAL_ID: 't4' } },
  ]);
  return { home, bob, proc };
}

describe('finding claude processes in /proc', () => {
  it('takes comm == claude with a terminal id, the config dir or ~/.claude.json, and skips other cores', async () => {
    const { home, bob, proc } = fixture();
    const found = await findClaudeProcesses({ procRoot: proc, home, coreSocket: '/run/user/1000/herdr-core/default.sock' });
    expect(found.map((p) => [p.terminal, p.configFile]).sort()).toEqual([
      ['t1', path.join(home, '.claude.json')],
      ['t2', path.join(bob, '.claude.json')],
    ]);
    // Without a core socket to compare with, as accounts.py: the other core's one counts too.
    const all = await findClaudeProcesses({ procRoot: proc, home });
    expect(all.map((p) => p.terminal).sort()).toEqual(['t1', 't2', 't9']);
  });

  it('says when a claude environment is unreadable (EACCES), once in the log, with only the pid', async () => {
    const { home, proc } = fixture();
    writeProc(proc, [{ pid: 107, comm: 'claude', env: { HC_TERMINAL_ID: 't7' } }]);
    fs.chmodSync(path.join(proc, '107', 'environ'), 0o000);
    const denied: number[] = [];
    const found = await findClaudeProcesses({ procRoot: proc, home, coreSocket: '/x.sock', onDenied: (pid) => denied.push(pid) });
    expect(found.map((p) => p.terminal).sort()).toEqual(['t1', 't2']);
    expect(denied).toEqual([107]);
    const warns: unknown[] = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (o: unknown) => warns.push(o) };
    const acc = new ClaudeAccounts({ procRoot: proc, home, coreSocket: '/x.sock', onChange: () => {}, logger });
    await acc.scan();
    await acc.scan();
    expect(warns).toEqual([{ claudePid: 107 }]);
  });

  it('a missing /proc is nothing found', async () => {
    dir = tmpDir('acc');
    expect(await findClaudeProcesses({ procRoot: path.join(dir, 'nope'), home: dir })).toEqual([]);
  });
});

describe('the account in a .claude.json (accounts.py rules)', () => {
  it('email local part and plan, lower case; organizationType when no plan name', () => {
    expect(accountOf(JSON.parse(claudeJson('alice@example.org', 'Pro')))).toEqual({ name: 'alice', plan: 'pro' });
    expect(accountOf(JSON.parse(claudeJson('bob@example.org', undefined, 'claude_max')))).toEqual({ name: 'bob', plan: 'claude_max' });
    expect(accountOf(JSON.parse(claudeJson('carol@example.org', '', '')))).toEqual({ name: 'carol', plan: '' });
  });

  it('a logged-out config is "?" (as accounts.py), a broken one nothing', () => {
    expect(accountOf({ numStartups: 1 })).toEqual({ name: '?', plan: '' });
    expect(accountOf({ oauthAccount: null })).toEqual({ name: '?', plan: '' });
    expect(accountOf({ oauthAccount: { emailAddress: '' } })).toEqual({ name: '?', plan: '' });
    expect(accountOf([])).toBeNull();
    expect(accountOf('x')).toBeNull();
    expect(accountOf({ oauthAccount: 'x' })).toBeNull();
    expect(accountOf({ oauthAccount: { emailAddress: 5 } })).toBeNull();
    expect(accountOf({ oauthAccount: { planDisplayName: ['x'] } })).toBeNull();
  });

  it('holds only name and plan, without control characters, at most 64 chars', () => {
    const a = accountOf({ oauthAccount: { emailAddress: `a\u001b[31mb${'x'.repeat(100)}@y`, planDisplayName: 'Max\n' } });
    expect(Object.keys(a ?? {}).sort()).toEqual(['name', 'plan']);
    expect(a?.name).toBe(`a[31mb${'x'.repeat(58)}`);
    expect(a?.plan).toBe('max');
  });
});

describe('config cache', () => {
  it('reads each config once while it is unchanged, again when it changes, never a vanished one', async () => {
    const { home, bob, proc } = fixture();
    const cache = new ConfigCache();
    const opts = { procRoot: proc, home, coreSocket: '/run/user/1000/herdr-core/default.sock' };
    const first = await scanAccounts(opts, cache);
    expect(Object.fromEntries(first)).toEqual({ t1: { name: 'alice', plan: 'pro' }, t2: { name: 'bob', plan: 'claude_max' } });
    expect(cache.reads).toBe(2);
    await scanAccounts(opts, cache);
    await scanAccounts(opts, cache);
    expect(cache.reads).toBe(2);
    // A /login as someone else rewrites the file.
    const file = path.join(bob, '.claude.json');
    fs.writeFileSync(file, claudeJson('carol@example.org', 'Max'));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const third = await scanAccounts(opts, cache);
    expect(third.get('t2')).toEqual({ name: 'carol', plan: 'max' });
    expect(cache.reads).toBe(3);
    // Unparsable: no account for its terminals.
    fs.writeFileSync(file, '{"oauthAccount": ');
    fs.utimesSync(file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    expect((await scanAccounts(opts, cache)).has('t2')).toBe(false);
    fs.rmSync(path.join(home, '.claude.json'));
    expect((await scanAccounts(opts, cache)).has('t1')).toBe(false);
  });
});

describe('ClaudeAccounts', () => {
  it('local addresses only; tells when the map changes, not when it stays', async () => {
    const { home, proc } = fixture();
    let changes = 0;
    const acc = new ClaudeAccounts({ procRoot: proc, home, coreSocket: '/run/x.sock', onChange: () => changes++ });
    await acc.scan();
    expect(changes).toBe(1);
    expect(acc.get('t1')).toEqual({ name: 'alice', plan: 'pro' });
    expect(acc.get('vps/t1')).toBeNull();
    expect(acc.get('t3')).toBeNull();
    await acc.scan();
    expect(changes).toBe(1);
    fs.rmSync(path.join(proc, '100'), { recursive: true });
    await acc.scan();
    expect(changes).toBe(2);
    expect(acc.get('t1')).toBeNull();
    acc.stop();
  });
});

describe('accounts in the world', () => {
  let b: TestBridge | null = null;
  afterEach(async () => {
    await b?.stop();
    b = null;
  });

  it('puts {name, plan} on local agents, updates when a terminal starts claude, and sends nothing else', async () => {
    const { home, proc } = fixture();
    b = await startBridge({ claudeAccounts: true, procRoot: proc, home });
    const world = () => b?.bridge.store.world;
    await until(() => world()?.terminals.t2?.account);
    expect(world()?.terminals.t1?.account).toEqual({ name: 'alice', plan: 'pro' });
    expect(world()?.terminals.t2?.account).toEqual({ name: 'bob', plan: 'claude_max' });
    expect(world()?.terminals.t4?.account).toBeNull();
    for (const t of Object.values(world()?.terminals ?? {})) if (t.account) expect(Object.keys(t.account).sort()).toEqual(['name', 'plan']);

    // t4 starts claude: its foreground changes, the bridge scans at once (not on the 10 s interval).
    writeProc(proc, [{ pid: 200, comm: 'claude', env: { HC_TERMINAL_ID: 't4' } }]);
    b.core.emit('foreground', 't4', { name: 'claude', cwd: '/home/me' });
    await until(() => world()?.terminals.t4?.account, 2000);
    expect(world()?.terminals.t4?.account).toEqual({ name: 'alice', plan: 'pro' });
    // ...and exits it.
    fs.rmSync(path.join(proc, '200'), { recursive: true });
    b.core.emit('foreground', 't4', { name: 'bash', cwd: '/home/me' });
    await until(() => world()?.terminals.t4 && world()?.terminals.t4?.account === null, 2000);

    // What clients get (/api/world): none of the config's other fields.
    const body = await new Promise<string>((resolve, reject) => {
      import('node:http').then(({ default: http }) =>
        http
          .get(`http://${b?.base}/api/world`, { headers: { authorization: 'Bearer test-token-0123456789-abcdefghijklmnop' } }, (res) => {
            let s = '';
            res.on('data', (d) => {
              s += d;
            });
            res.on('end', () => resolve(s));
          })
          .on('error', reject),
      );
    });
    expect(body).toContain('"account":{"name":"alice","plan":"pro"}');
    for (const secret of SECRETS) expect(body).not.toContain(secret);
  });

  it('is off unless configured (no /proc scan in test bridges)', async () => {
    const { home, proc } = fixture();
    b = await startBridge({ procRoot: proc, home });
    await until(() => b?.bridge.store.world.terminals.t1);
    expect(b.bridge.store.world.terminals.t1?.account).toBeUndefined();
  });
});
