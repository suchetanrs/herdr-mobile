import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Backoff } from '../src/core/backoff.js';
import { CoreClient, type CoreNotification } from '../src/core/client.js';
import { PolicyError } from '../src/core/policy.js';
import { CoreUnavailableError, RpcError } from '../src/core/types.js';
import { FakeCore } from './helpers/fakeCore.js';
import { agent } from './helpers/fixtures.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';

let dir: string;
let core: FakeCore;
let client: CoreClient;

beforeEach(async () => {
  dir = tmpDir('client');
  core = new FakeCore(path.join(dir, 'core.sock'));
  core.terminals.set('t1', agent('t1', 'working', 1, 1));
  await core.listen();
  client = new CoreClient({ socketPath: core.socketPath, backoff: new Backoff(10, 50) });
});

afterEach(async () => {
  client.stop();
  await core.close();
  rmDir(dir);
});

const ready = () => new Promise<void>((resolve) => client.once('ready', () => resolve()));

describe('CoreClient', () => {
  it('says framed hello and correlates concurrent replies out of order', async () => {
    const r = ready();
    client.start();
    await r;
    expect(core.calls[0]).toEqual({ method: 'hello', params: { generation: 1, framed: true } });
    expect(client.hello?.version).toBe('0.1.18');
    core.delays['server.status'] = 50;
    const slow = client.call<{ echo: unknown }>('server.status', { n: 1 });
    const fast = client.call<{ value: unknown }>('doc.get', { name: 'nothing' });
    const order: string[] = [];
    await Promise.all([slow.then(() => order.push('slow')), fast.then(() => order.push('fast'))]);
    expect(order).toEqual(['fast', 'slow']);
    expect((await slow).echo).toEqual({ n: 1 });
    await expect(client.call('terminal.get', { terminal: 'nope' })).rejects.toBeInstanceOf(RpcError);
    await expect(client.call('terminal.get', { terminal: 'nope' })).rejects.toMatchObject({ kind: 'not_found' });
    // Methods the bridge doesn't use never reach the core (policy allowlist).
    await expect(client.call('nope.method')).rejects.toBeInstanceOf(PolicyError);
  });

  it('refuses forbidden writes without sending them', async () => {
    const r = ready();
    client.start();
    await r;
    await expect(client.call('doc.set', { name: 'herdr-app', value: {}, version: 1 })).rejects.toBeInstanceOf(PolicyError);
    expect(core.calls.some((c) => c.method === 'doc.set')).toBe(false);
  });

  it('subscribes and streams events split across frames', async () => {
    const r = ready();
    client.start();
    await r;
    const got: CoreNotification[] = [];
    const snap = await client.subscribe((n) => got.push(n));
    expect(snap.terminals.map((t) => t.address)).toEqual(['t1']);
    core.status('t1', 'done');
    core.heartbeat();
    await until(() => got.length === 2);
    expect(got[0]).toMatchObject({ method: 'event', params: { type: 'status', terminal: 't1' } });
    expect(got[1]?.method).toBe('heartbeat');
  });

  it('rejects pending calls on disconnect and reconnects after a core restart', async () => {
    let readies = 0;
    let downs = 0;
    client.on('ready', () => readies++);
    client.on('down', () => downs++);
    client.start();
    await until(() => readies === 1);
    core.delays['server.status'] = 500;
    const pending = client.call('server.status');
    await core.restart();
    await expect(pending).rejects.toBeInstanceOf(CoreUnavailableError);
    await until(() => readies === 2, 3000);
    expect(downs).toBeGreaterThanOrEqual(1);
    await expect(client.call('doc.get', { name: 'x' })).resolves.toMatchObject({ version: 0 });
  });

  it('keeps retrying while the core is down', async () => {
    await core.close();
    let failures = 0;
    client.on('failed', () => failures++);
    client.start();
    await until(() => failures >= 3, 3000);
    expect(client.connected).toBe(false);
    await expect(client.call('doc.get', {})).rejects.toBeInstanceOf(CoreUnavailableError);
    const r = ready();
    await core.listen();
    await r;
    expect(client.connected).toBe(true);
  });
});
