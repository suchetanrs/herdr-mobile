import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ConversationServerMessage, ServerMessage } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type Bridge, createBridge } from '../src/app.js';
import type { Config } from '../src/config.js';
import { signIn } from './helpers/bridge.js';
import { FakeCore } from './helpers/fakeCore.js';
import { layoutDoc, standardTerminals } from './helpers/fixtures.js';
import { rmDir, tmpDir, until } from './helpers/tmp.js';
import { entry, jsonl } from './helpers/transcript.js';

const TOKEN = 'test-token-0123456789-abcdefghijklmnop';
let dir: string;
let projects: string;
let core: FakeCore;
let bridge: Bridge;
let base: string;
let cookie = '';

const label = (file: string, session = 's1') => JSON.stringify({ agent: 'claude', session, transcript: file });

class Client {
  readonly msgs: ServerMessage[] = [];
  ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url, { headers: { cookie } });
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', v: 1 })));
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString()) as ServerMessage));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  conv<T extends ConversationServerMessage['t']>(t: T) {
    return this.msgs.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

beforeEach(async () => {
  dir = tmpDir('conv');
  const home = path.join(dir, 'home');
  projects = path.join(home, '.claude', 'projects', '-p');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(
    path.join(projects, 's1.jsonl'),
    jsonl(entry.title('demo'), entry.prompt('first'), entry.text('one'), entry.prompt('second'), entry.text('two')),
  );
  core = new FakeCore(path.join(dir, 'core.sock'));
  for (const t of standardTerminals()) {
    if (t.labels?.['agent-resume']) t.labels['agent-resume'] = label(path.join(projects, `${t.address}.jsonl`));
    core.terminals.set(t.address, t);
  }
  const t1 = core.terminals.get('t1');
  if (t1?.labels) t1.labels['agent-resume'] = label(path.join(projects, 's1.jsonl'));
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
    home,
    includeUnplaced: false,
    seenSync: false,
    streamGraceMs: 200,
    machinePollMs: 50,
    webDir: path.join(dir, 'web'),
    herdrAppDir: path.join(dir, 'herdr-app'),
    transcriptPollMs: 100,
  };
  bridge = createBridge(config);
  await bridge.start();
  base = `127.0.0.1:${(bridge.http.server.address() as AddressInfo).port}`;
  await until(() => bridge.store.world.core.connected && bridge.store.world.terminals.t1);
  cookie = await signIn(base);
});

afterEach(async () => {
  await bridge.stop();
  await core.close();
  rmDir(dir);
});

describe('conversation streams over the WebSocket', () => {
  it('lists servable transcripts in the world, opens a page, streams appends, follows a new session', async () => {
    expect(bridge.store.world.terminals.t1?.transcript).toBe(path.join(projects, 's1.jsonl'));
    // t3 is a shell: no transcript. t2's label points at a file that isn't written yet: still listed (new session).
    expect(bridge.store.world.terminals.t3?.transcript).toBeNull();

    const c = new Client(`ws://${base}/ws`);
    await until(() => c.msgs.some((m) => m.t === 'snapshot'));
    c.send({ t: 'conv.open', req: 1, terminalId: 't1', turns: 1 });
    const opened = await until(() => c.conv('conv.opened')[0]);
    expect(opened).toMatchObject({ req: 1, terminalId: 't1', v: 1, source: { format: 'claude', session: 's1' }, meta: { title: 'demo' } });
    expect(opened.items.map((i) => (i as { text: string }).text)).toEqual(['second', 'two']);
    expect(opened.before).toBeGreaterThan(0);

    c.send({ t: 'conv.more', req: 2, stream: opened.stream, before: opened.before });
    const older = await until(() => c.conv('conv.page')[0]);
    expect(older.items.map((i) => (i as { text: string }).text)).toEqual(['first', 'one']);
    expect(older.before).toBeNull();

    const t0 = Date.now();
    fs.appendFileSync(path.join(projects, 's1.jsonl'), jsonl(entry.tool('b1', 'Bash', { command: 'ls' })));
    const live = await until(() => c.conv('conv.items')[0], 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(live.items).toMatchObject([{ kind: 'tool', id: 'b1', name: 'Bash' }]);
    fs.appendFileSync(path.join(projects, 's1.jsonl'), jsonl(entry.result('b1', 'a b', { stdout: 'a b', stderr: '' })));
    const res = await until(() => c.conv('conv.items')[1], 1000);
    expect(res.results).toEqual([{ id: 'b1', result: { isError: false, text: 'a b' } }]);

    // /clear: the agent-resume label moves to the new session's file.
    fs.writeFileSync(path.join(projects, 's2.jsonl'), jsonl(entry.prompt('new session')));
    core.labels('t1', { 'agent-resume': label(path.join(projects, 's2.jsonl'), 's2') });
    const reset = await until(() => c.conv('conv.reset')[0], 1500);
    expect(reset).toMatchObject({ reason: 'session', source: { session: 's2' }, items: [{ text: 'new session' }] });
    c.ws.close();
  });

  it('refuses what it cannot serve', async () => {
    const c = new Client(`ws://${base}/ws`);
    await until(() => c.msgs.some((m) => m.t === 'snapshot'));
    c.send({ t: 'conv.open', req: 1, terminalId: 't3' });
    c.send({ t: 'conv.open', req: 2, terminalId: 'nope' });
    c.send({ t: 'conv.more', req: 3, stream: 99, before: 10 });
    await until(() => c.conv('conv.error').length === 3);
    expect(c.conv('conv.error').map((e) => [e.req, e.code])).toEqual(
      expect.arrayContaining([
        [1, 'no_transcript'],
        [2, 'not_found'],
        [3, 'not_found'],
      ]),
    );
    c.ws.close();
  });

  it('stops following when the client goes', async () => {
    const c = new Client(`ws://${base}/ws`);
    await until(() => c.msgs.some((m) => m.t === 'snapshot'));
    c.send({ t: 'conv.open', req: 1, terminalId: 't1' });
    await until(() => c.conv('conv.opened')[0]);
    expect(bridge.conversations.openCount).toBe(1);
    c.ws.close();
    await until(() => bridge.conversations.openCount === 0);
  });
});
