import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type Bridge, createBridge } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { FakeCore } from './fakeCore.js';
import { layoutDoc, standardTerminals } from './fixtures.js';
import { rmDir, tmpDir, until } from './tmp.js';
import { useCookie } from './wsClient.js';

export const TOKEN = 'test-token-0123456789-abcdefghijklmnop';

/** Signs in with the token (POST /api/session) and returns the `Cookie` header value of the new session. */
export async function signIn(base: string, token = TOKEN, headers: Record<string, string> = {}): Promise<string> {
  const r = await fetch(`http://${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token }),
  });
  if (r.status !== 201) throw new Error(`sign-in failed: ${r.status}`);
  const set = r.headers.getSetCookie().find((c) => c.startsWith('hm_session='));
  if (!set) throw new Error('no session cookie');
  return set.split(';')[0] as string;
}

export interface TestBridge {
  dir: string;
  core: FakeCore;
  bridge: Bridge;
  /** host:port */
  base: string;
  /** A signed-in session's Cookie header (one per bridge). */
  cookie: string;
  wsUrl(q?: string): string;
  /** WebSocket options carrying the session cookie. */
  ws: { headers: { cookie: string } };
  stop(): Promise<void>;
}

/** A bridge on a random loopback port in front of a fresh fake core with the standard fixtures. */
export async function startBridge(over: Partial<Config> = {}, setup?: (core: FakeCore) => void): Promise<TestBridge> {
  const dir = tmpDir('bridge');
  const core = new FakeCore(path.join(dir, 'core.sock'));
  for (const t of standardTerminals()) core.terminals.set(t.address, t);
  core.docs.set('herdr-app', { value: layoutDoc(), version: 7 });
  setup?.(core);
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
    ...over,
  };
  const bridge = createBridge(config);
  await bridge.start();
  const port = (bridge.http.server.address() as AddressInfo).port;
  const base = `127.0.0.1:${port}`;
  await until(() => bridge.store.world.spaceOrder.length === 2 && bridge.store.world.core.connected);
  const cookie = await signIn(base, config.token ?? fs.readFileSync(path.join(config.configDir, 'token'), 'utf8').trim());
  useCookie(cookie);
  return {
    dir,
    core,
    bridge,
    base,
    cookie,
    ws: { headers: { cookie } },
    wsUrl: (q = '') => `ws://${base}/ws${q}`,
    async stop() {
      await bridge.stop();
      await core.close();
      rmDir(dir);
    },
  };
}
