import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConversationServerMessage } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeFormat } from '../src/transcripts/claude.js';
import { ConversationHub } from '../src/transcripts/hub.js';
import type { Located } from '../src/transcripts/locate.js';
import { sessionFacts, TranscriptTail } from '../src/transcripts/tail.js';
import { ConversationSession } from '../src/transport/conversation.js';
import { rmDir, sleep, tmpDir, until } from './helpers/tmp.js';
import { entry, jsonl } from './helpers/transcript.js';

let dir: string;
beforeEach(() => {
  dir = tmpDir('convfix');
});
afterEach(() => rmDir(dir));

describe('conversation streams (REVIEW P3-1, P3-2, P3-9)', () => {
  it('concurrent opens cannot get past the 8-stream cap', async () => {
    const hub = {
      open: async () => {
        await sleep(20);
        return {
          handle: { source: { format: 'claude', session: 's', path: '/x.jsonl' }, more: async () => ({}), close() {} },
          page: { items: [], before: null, results: [], meta: {} },
        };
      },
    } as unknown as ConversationHub;
    const sent: ConversationServerMessage[] = [];
    const s = new ConversationSession({ hub }, (m) => sent.push(m));
    for (let i = 1; i <= 12; i++) s.onMessage({ t: 'conv.open', req: i, terminalId: 't1' });
    await until(() => sent.length === 12);
    expect(sent.filter((m) => m.t === 'conv.opened')).toHaveLength(8);
    expect(sent.filter((m) => m.t === 'conv.error' && m.code === 'too_many')).toHaveLength(4);
  });

  it("a terminal that goes away while its conversation opens doesn't get conv.opened", async () => {
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, jsonl(entry.prompt('hello')));
    let where: Located | 'gone' = { format: claudeFormat, source: { format: 'claude', session: 'a', path: file } };
    const hub = new ConversationHub({ locate: () => where, pollMs: 50, graceMs: 50 });
    const sub = { onBatch() {}, onReset() {}, onClosed() {} };
    const opening = hub.open('t1', sub, 4);
    where = 'gone';
    hub.refresh();
    await expect(opening).rejects.toMatchObject({ code: 'not_found' });
    expect(hub.openCount).toBe(0);
    hub.stop();
  });

  it('the session-facts scan of a big transcript reads only what is new on the next start', async () => {
    const file = path.join(dir, 'big.jsonl');
    const lines = Array.from({ length: 4000 }, (_, i) => jsonl(entry.text(`reply ${i} ${'x'.repeat(400)}`))).join('');
    fs.writeFileSync(file, jsonl({ type: 'custom-title', customTitle: 'My session' }) + lines);
    const size = fs.statSync(file).size;
    const fh = await fsp.open(file, 'r');
    let read = 0;
    const counting = {
      read: (buf: Buffer, off: number, len: number, pos: number) => {
        const p = fh.read(buf, off, len, pos);
        return p.then((r) => {
          read += r.bytesRead;
          return r;
        });
      },
    } as unknown as typeof fh;
    try {
      const key = `${file}\0${fs.statSync(file).ino}`;
      const first = await sessionFacts(counting, claudeFormat, size, key);
      expect(read).toBeGreaterThan(size * 0.9);
      read = 0;
      const again = await sessionFacts(counting, claudeFormat, size, key);
      expect(read).toBeLessThan(300 * 1024);
      expect(again).toEqual(first);
    } finally {
      await fh.close();
    }
  });

  it('never follows a symlink planted where a not-yet-existing transcript will be', async () => {
    const secret = path.join(dir, 'secret.jsonl');
    fs.writeFileSync(secret, jsonl(entry.prompt('SECRET CONTENT')));
    const planted = path.join(dir, 'later.jsonl');
    fs.symlinkSync(secret, planted);
    const tail = new TranscriptTail(planted, claudeFormat, { pollMs: 50 });
    const items: unknown[] = [];
    const listener = { onBatch: (b: { items: unknown[] }) => items.push(...b.items), onReplaced() {} };
    await tail.start();
    const page = await tail.join(listener as never, { turns: 4, maxBytes: 1e6, maxItems: 100 });
    expect(JSON.stringify(page.items)).not.toContain('SECRET');
    tail.stop();
  });
});
