import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { SnapshotMessage, World } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type Bridge, createBridge } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { CoreTerminal } from '../src/core/types.js';
import { signIn } from './helpers/bridge.js';
import { FakeCore } from './helpers/fakeCore.js';
import { layoutDoc, standardTerminals } from './helpers/fixtures.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';
import { Client, useCookie } from './helpers/wsClient.js';

const TOKEN = 'test-token-0123456789-abcdefghijklmnop';
let dir: string;
let core: FakeCore;
let bridge: Bridge;
let base: string;
let cookie = '';

beforeEach(async () => {
  dir = tmpDir('bridge');
  core = new FakeCore(path.join(dir, 'core.sock'));
  for (const t of standardTerminals()) core.terminals.set(t.address, t);
  core.docs.set('herdr-app', { value: layoutDoc(), version: 7 });
  await core.listen();
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    socketPath: core.socketPath,
    configDir: path.join(dir, 'cfg'),
    token: TOKEN,
    doneGraceMs: 100,
    heartbeatMs: 15_000,
    logLevel: 'silent',
    home: '/home/me',
    includeUnplaced: false,
    seenSync: false,
    streamGraceMs: 200,
    machinePollMs: 50,
    webDir: path.join(dir, 'web'),
    herdrAppDir: path.join(dir, 'herdr-app'),
  };
  bridge = createBridge(config);
  await bridge.start();
  const port = (bridge.http.server.address() as AddressInfo).port;
  base = `127.0.0.1:${port}`;
  await until(() => bridge.store.world.spaceOrder.length === 2 && bridge.store.world.core.connected);
  cookie = await signIn(base);
  useCookie(cookie);
});

afterEach(async () => {
  await bridge.stop();
  await core.close();
  rmDir(dir);
});

const wsUrl = (q = '') => `ws://${base}/ws${q}`;

describe('bridge end to end (fake core)', () => {
  it('sends the world on connect', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    expect(c.of('welcome')[0]).toMatchObject({ v: 1 });
    const w = c.world as World;
    expect(w.spaceOrder).toEqual(['spA', 'spB']);
    // Real checkout lookup: the fixture folder has no .git, so the folder itself names it.
    expect(w.spaces.spB?.name).toBe('sub');
    expect(w.terminals.t1?.status).toBe('done');
    expect(w.core).toMatchObject({ connected: true, version: '0.1.18', name: 'fakebox' });
    c.close();
  });

  it('streams a status change as a patch well under 500 ms, plus Herdr-style alerts', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    const t0 = Date.now();
    core.status('t4', 'blocked');
    await until(() => c.world?.terminals.t4?.status === 'blocked');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(c.world?.tabs.tbB2?.status).toBe('blocked');
    expect(c.world?.spaces.spB?.status).toBe('blocked');
    await until(() => c.of('alert').length === 1);
    expect(c.of('alert')[0]?.alert).toMatchObject({ kind: 'blocked', title: 'reviewer needs you', body: 'sub / review', terminalId: 't4' });

    // working -> done with nobody looking: "finished" after the grace period.
    core.status('t2', 'done');
    core.turn('t2');
    await until(() => c.of('alert').length === 2);
    expect(c.of('alert')[1]?.alert).toMatchObject({ kind: 'done', title: 'Claude Code finished', body: 'sub / 1' });
    expect(c.world?.terminals.t2?.status).toBe('done');

    // Sub-agent blocked again and a paneless agent finishing: no alerts.
    core.status('t5', 'working');
    core.status('t5', 'blocked');
    core.status('t6', 'done');
    await new Promise((r) => setTimeout(r, 250));
    expect(c.of('alert')).toHaveLength(2);
    c.close();
  });

  it('drops a finished alert when the desktop marks the turn seen during the grace period', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    core.status('t2', 'idle');
    core.turn('t2');
    core.labels('t2', { 'herdr.seen': '6' });
    await until(() => c.world?.terminals.t2?.status === 'idle');
    await new Promise((r) => setTimeout(r, 250));
    expect(c.of('alert')).toHaveLength(0);
    c.close();
  });

  it('does not alert for a finish the person is watching (looking)', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    c.ws.send(JSON.stringify({ t: 'looking', terminalIds: ['t2'] }));
    await new Promise((r) => setTimeout(r, 30));
    core.status('t2', 'done');
    await until(() => c.world?.terminals.t2?.word === 'done');
    await new Promise((r) => setTimeout(r, 250));
    expect(c.of('alert')).toHaveLength(0);
    c.close();
  });

  it('follows layout doc changes', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    const doc = layoutDoc();
    doc.spaces = doc.spaces?.slice(1);
    core.setDoc('herdr-app', doc);
    await until(() => c.world?.spaceOrder.length === 1);
    expect(c.world?.spaces.spA).toBeUndefined();
    expect(c.world?.terminals.t1).toBeUndefined();
    expect(c.world?.spaces.spB?.index).toBe(1);
    c.close();
  });

  it('closes a space live when its last terminals exit, as the desktop does (task 3b, "AWS")', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world?.spaces.spA);
    // spA's only pane is t1: it exits -> its tab and then the space close, before any doc write.
    core.emit('finished', 't1', { reason: 'exited', exit_code: 130, signal: null, finished_ms: Date.now() });
    await until(() => c.world && !c.world.spaces.spA);
    expect(c.world?.spaceOrder).toEqual(['spB']);
    expect(c.world?.terminals.t1).toBeUndefined();
    c.close();
  });

  it('brings in the spaces of a machine added while running', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    core.terminals.set('rohan/t7', { ...standardTerminals()[0], address: 'rohan/t7' } as CoreTerminal);
    core.emit('created', 'rohan/t7', core.terminals.get('rohan/t7'));
    core.docs.set('rohan:herdr-app', {
      value: {
        spaces: [
          { id: 'sp9', name: 'GPU', folder: '/srv', tabs: [{ id: 'tb9', root: { type: 'block', id: 'p9', content: { terminal: 't7' } } }] },
        ],
      },
      version: 1,
    });
    core.machines = ['rohan'];
    await until(() => c.world?.spaces['rohan/sp9']);
    expect(c.world?.spaceOrder).toEqual(['spA', 'spB', 'rohan/sp9']);
    core.machines = [];
    await until(() => c.world && !c.world.spaces['rohan/sp9']);
    c.close();
  });

  it('resumes from the last seq after a reconnect, else sends a snapshot', async () => {
    const a = new Client(wsUrl());
    await until(() => a.world);
    const { serverId } = a;
    const seq = a.seq;
    a.close();
    core.status('t1', 'working');
    core.emit('size', 't3', { cols: 100, rows: 30 });
    await until(() => bridge.store.world.terminals.t3?.cols === 100);
    const b = new Client(wsUrl(), { t: 'hello', v: 1, resume: { serverId, seq } });
    await until(
      () =>
        b.of('patch').length >= 1 && b.msgs.some((m) => m.t === 'patch' && m.ops.some((o) => o.op === 'terminal' && o.value.id === 't3')),
    );
    expect(b.of('snapshot')).toHaveLength(0);
    expect(b.of('patch')[0]?.seq).toBe(seq + 1);
    b.close();
    const c = new Client(wsUrl(), { t: 'hello', v: 1, resume: { serverId: 'another-server', seq } });
    await until(() => c.of('snapshot').length === 1);
    expect((c.of('snapshot')[0] as SnapshotMessage).world.terminals.t1?.status).toBe('working');
    c.close();
  });

  it('rejects a wrong protocol version', async () => {
    const c = new Client(wsUrl(), { t: 'hello', v: 99 });
    await until(() => c.of('error').length === 1);
    expect(c.of('error')[0]?.code).toBe('version');
  });

  it('survives a core restart: reports it down, then resyncs', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    await core.close();
    await until(() => c.world?.core.connected === false);
    core.terminals.set('t1', { ...(core.terminals.get('t1') as CoreTerminal), status: { app: 'claude-code', state: 'blocked' } });
    core.seq = 1;
    await core.listen();
    await until(() => c.world?.core.connected === true && c.world.terminals.t1?.status === 'blocked', 4000);
    // The world it knew stayed while the core was away; t1 needing you while we were away still alerts.
    await until(() => c.of('alert').some((m) => m.alert.terminalId === 't1' && m.alert.kind === 'blocked'));
    c.close();
  });

  it('guards HTTP and WS with the session', async () => {
    expect((await fetch(`http://${base}/api/health`)).status).toBe(200);
    expect((await fetch(`http://${base}/api/world`)).status).toBe(401);
    expect((await fetch(`http://${base}/api/world?token=${TOKEN}`)).status).toBe(401);
    const viaCookie = await fetch(`http://${base}/api/world`, { headers: { cookie } });
    const body = (await viaCookie.json()) as { world: World };
    expect(body.world.spaceOrder).toEqual(['spA', 'spB']);
    // Local tools may use the token as a bearer header (loopback only).
    const viaHeader = await fetch(`http://${base}/api/world`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(viaHeader.status).toBe(200);
    // An old ?token= page link doesn't sign in; it is only taken out of the address.
    const page = await fetch(`http://${base}/agents?token=${TOKEN}&x=1`, { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/agents?x=1');
    expect(page.headers.get('set-cookie')).toBeNull();

    const bad = new WebSocket(wsUrl(), { headers: { cookie: `hm_session=${'w'.repeat(43)}` } });
    const status = await new Promise<number>((resolve) => bad.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  // biome-ignore lint/suspicious/noExplicitAny: a JSON body checked with toMatchObject
  type Json = Record<string, any>;
  it('health reports the core connection and versions, and nothing private', async () => {
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    const h = (await (await fetch(`http://${base}/api/health`, auth)).json()) as Json;
    expect(h).toMatchObject({ ok: true, status: 'ok', core: { connected: true, version: '0.1.18', reconnects: 0, lastError: null } });
    expect(h.bridge).toMatchObject({ version: '0.1.0', protocol: 1, conversationProtocol: 1, node: process.version });
    expect(JSON.stringify(h)).not.toContain(TOKEN);
    await core.close();
    await until(() => !bridge.store.world.core.connected);
    expect(await (await fetch(`http://${base}/api/health`)).json()).toEqual({ ok: true });
    const down = (await (await fetch(`http://${base}/api/health`, auth)).json()) as Json;
    expect(down).toMatchObject({ ok: true, status: 'degraded', core: { connected: false } });
    await core.listen();
    await until(() => bridge.store.world.core.connected, 4000);
    const back = (await (await fetch(`http://${base}/api/health`, auth)).json()) as Json;
    expect(back.core).toMatchObject({ connected: true, reconnects: 1 });
  });

  it('sends security headers on pages and API without breaking them', async () => {
    fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'web', 'index.html'), '<!doctype html><title>Herdr</title>');
    for (const url of ['/', '/api/health', '/api/world']) {
      const r = await fetch(`http://${base}${url}`);
      expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('rate-limits failed sign-ins per address; signed-in devices are never blocked', async () => {
    const attempt = (token: string) =>
      fetch(`http://${base}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    for (let i = 0; i < 29; i++) expect((await attempt('nope')).status).toBe(401);
    // Requests without a session (not a token attempt) don't count.
    for (let i = 0; i < 5; i++) expect((await fetch(`http://${base}/api/world`)).status).toBe(401);
    expect((await attempt('nope')).status).toBe(401);
    const blocked = await attempt(TOKEN);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // A device that is already signed in still gets in (REVIEW P1-9).
    expect((await fetch(`http://${base}/api/world`, { headers: { cookie } })).status).toBe(200);
    const ws = new WebSocket(wsUrl(), { headers: { cookie } });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.close();
    // Health stays open (monitoring).
    expect((await fetch(`http://${base}/api/health`)).status).toBe(200);
  });

  it('refuses WebSockets from other sites', async () => {
    const ws = new WebSocket(wsUrl(), { headers: { origin: 'http://evil.example', cookie } });
    const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
    const ok = new WebSocket(wsUrl(), { headers: { origin: `http://${base}`, cookie } });
    await new Promise((resolve, reject) => {
      ok.on('open', resolve);
      ok.on('error', reject);
    });
    ok.close();
  });

  it('serves the web app publicly, with an SPA fallback, and keeps the API guarded', async () => {
    fs.mkdirSync(path.join(dir, 'web', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'web', 'index.html'), '<!doctype html><title>Herdr</title>');
    fs.writeFileSync(path.join(dir, 'web', 'assets', 'app-1.js'), `console.log(${JSON.stringify('x'.repeat(4000))})`);
    fs.mkdirSync(path.join(dir, 'herdr-app'), { recursive: true });
    const index = await fetch(`http://${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('<title>Herdr</title>');
    expect(await (await fetch(`http://${base}/some/deep/link`)).text()).toContain('<title>Herdr</title>');
    const js = await fetch(`http://${base}/assets/app-1.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('content-encoding')).toBe('gzip');
    expect((await js.text()).length).toBeGreaterThan(4000);
    expect((await fetch(`http://${base}/assets/gone.js`)).status).toBe(404);
    expect((await fetch(`http://${base}/../../etc/passwd`)).status).not.toBe(500);
    expect((await fetch(`http://${base}/api/session`)).status).toBe(401);
    expect((await fetch(`http://${base}/api/session`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await fetch(`http://${base}/api/nope`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it('sends the desktop space colors and follows changes to them', async () => {
    fs.mkdirSync(path.join(dir, 'herdr-app'), { recursive: true });
    const shared = path.join(dir, 'herdr-app', 'shared.json');
    fs.writeFileSync(shared, JSON.stringify({ 'space.colors': { spA: 'ansi3', spB: 'bogus;' } }));
    bridge.store.refresh();
    await new Promise((r) => setTimeout(r, 50));
    const c = new Client(wsUrl());
    await until(() => c.world);
    // Read at start: the file didn't exist then, so the colors arrive after the next look.
    await until(() => c.world?.spaces.spA?.color === 'ansi3', 5000);
    expect(c.world?.spaces.spB?.color).toBeNull();
    fs.writeFileSync(shared, JSON.stringify({ 'space.colors': { spA: '#123456' } }));
    await until(() => c.world?.spaces.spA?.color === '#123456', 5000);
    c.close();
  });

  it('never writes the layout doc or labels', async () => {
    const c = new Client(wsUrl());
    await until(() => c.world);
    core.status('t1', 'working');
    core.status('t1', 'done');
    await new Promise((r) => setTimeout(r, 200));
    const writes = core.calls.filter((x) =>
      ['doc.set', 'terminal.label', 'terminal.send', 'terminal.keys', 'terminal.attach'].includes(x.method),
    );
    expect(writes).toEqual([]);
    c.close();
  });
});
