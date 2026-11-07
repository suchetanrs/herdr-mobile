import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backoff } from '../src/core/backoff.js';
import { CoreClient } from '../src/core/client.js';
import { encodeFrame, FrameDecoder, FrameKind } from '../src/core/frames.js';
import { WorldStore } from '../src/world/store.js';
import { FakeCore } from './helpers/fakeCore.js';
import { layoutDoc, standardTerminals } from './helpers/fixtures.js';
import { rmDir, sleep, tmpDir, until } from './helpers/tmp.js';

let dir: string;
let core: FakeCore;
let client: CoreClient;

beforeEach(async () => {
  dir = tmpDir('resil');
  core = new FakeCore(path.join(dir, 'core.sock'));
  for (const t of standardTerminals()) core.terminals.set(t.address, t);
  core.docs.set('herdr-app', { value: layoutDoc(), version: 7 });
  await core.listen();
});

afterEach(async () => {
  client?.stop();
  await core.close();
  rmDir(dir);
});

const ready = (c: CoreClient) => new Promise<void>((resolve) => c.once('ready', () => resolve()));

describe('closed channels do not leak (REVIEW P1-3)', () => {
  it('drops late frames and the CLOSE echo of channels it closed', async () => {
    client = new CoreClient({ socketPath: core.socketPath, backoff: new Backoff(10, 50) });
    const r = ready(client);
    client.start();
    await r;
    for (let i = 0; i < 50; i++) {
      const { channel } = await client.call<{ channel: number }>('terminal.attach', { terminal: 't1', cols: 173, rows: 41, resumed: true });
      client.openChannel(channel, { onFrame: () => {}, onDrop: () => {} });
      client.closeChannel(channel);
      // Output already in flight when the CLOSE goes out.
      core.output('t1', 'late bytes\r\n');
    }
    await sleep(100);
    expect(client.bufferedFrames).toBe(0);
  });
});

describe('the bridge never sits on a stale world (REVIEW P1-5)', () => {
  it('reconnects when events.subscribe fails', async () => {
    client = new CoreClient({ socketPath: core.socketPath, backoff: new Backoff(10, 50) });
    const store = new WorldStore({ client, home: '/home/me', machinePollMs: 0 });
    core.failNext['events.subscribe'] = 1;
    store.start();
    await until(() => store.world.spaceOrder.length === 2, 3000);
    expect(core.calls.filter((c) => c.method === 'events.subscribe').length).toBe(2);
    store.stop();
  });

  it('gives up on a core that never answers hello, and retries', async () => {
    core.silentHello = true;
    client = new CoreClient({ socketPath: core.socketPath, backoff: new Backoff(10, 50), helloTimeoutMs: 100 });
    client.start();
    await until(() => core.calls.filter((c) => c.method === 'hello').length >= 2, 2000);
    core.silentHello = false;
    await until(() => client.connected, 2000);
  });

  it('subscribes again when the core closes the event channel', async () => {
    client = new CoreClient({ socketPath: core.socketPath, backoff: new Backoff(10, 50) });
    const store = new WorldStore({ client, home: '/home/me', machinePollMs: 0 });
    store.start();
    await until(() => store.world.spaceOrder.length === 2, 3000);
    core.closeEvents();
    await until(() => core.subscribers === 1, 2000);
    core.status('t4', 'blocked');
    await until(() => store.world.terminals.t4?.status === 'blocked', 2000);
    store.stop();
  });

  it('says `down` once per lost connection, not on every failed retry (REVIEW P3-13)', async () => {
    await core.close();
    client = new CoreClient({ socketPath: core.socketPath, backoff: new Backoff(10, 20) });
    let downs = 0;
    let failures = 0;
    client.on('down', () => downs++);
    client.on('failed', () => failures++);
    client.start();
    await until(() => failures >= 3, 3000);
    expect(downs).toBe(0);
  });
});

describe('FrameDecoder (REVIEW P3-13)', () => {
  it('assembles a big frame from small chunks without re-copying it per chunk', () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 7);
    const wire = encodeFrame(9, FrameKind.DATA, payload);
    const d = new FrameDecoder();
    const concat = vi.spyOn(Buffer, 'concat');
    let frames: ReturnType<FrameDecoder['push']> = [];
    for (let off = 0; off < wire.length; off += 4096) frames = frames.concat(d.push(wire.subarray(off, off + 4096)));
    const calls = concat.mock.calls.length;
    concat.mockRestore();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.equals(payload)).toBe(true);
    expect(calls).toBeLessThan(10);
  });
});
