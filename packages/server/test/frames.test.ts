import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/core/backoff.js';
import { creditPayload, encodeFrame, FrameDecoder, FrameKind, LineSplitter } from '../src/core/frames.js';
import { checkCall, PolicyError } from '../src/core/policy.js';

describe('frames', () => {
  it('round-trips frames split at any byte', () => {
    const bytes = Buffer.concat([
      encodeFrame(0, FrameKind.DATA, '{"id":1}'),
      encodeFrame(7, FrameKind.CREDIT, creditPayload(4096)),
      encodeFrame(3, FrameKind.CLOSE),
    ]);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const d = new FrameDecoder();
      const frames = [...d.push(bytes.subarray(0, cut)), ...d.push(bytes.subarray(cut))];
      expect(frames.map((f) => [f.channel, f.kind, f.payload.length])).toEqual([
        [0, 0, 8],
        [7, 1, 4],
        [3, 2, 0],
      ]);
      expect(frames[1]?.payload.readUInt32LE(0)).toBe(4096);
    }
  });

  it('rejects oversized frames', () => {
    const h = Buffer.alloc(9);
    h.writeUInt32LE(17 * 1024 * 1024, 5);
    expect(() => new FrameDecoder().push(h)).toThrow(/too large/);
  });

  it('splits lines across chunks, including inside a UTF-8 character', () => {
    const s = new LineSplitter();
    const text = Buffer.from('{"a":"é"}\n{"b":2}\n{"c"');
    expect([...s.push(text.subarray(0, 7)), ...s.push(text.subarray(7))]).toEqual(['{"a":"é"}', '{"b":2}']);
    expect(s.push(Buffer.from(':3}\n'))).toEqual(['{"c":3}']);
  });
});

describe('backoff', () => {
  it('grows and caps, and resets', () => {
    const b = new Backoff(100, 1000, () => 1);
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([100, 200, 400, 800, 1000]);
    b.reset();
    expect(b.next()).toBe(100);
  });
});

describe('policy', () => {
  it('refuses writes to the herdr-app doc and herdr.pinned', () => {
    expect(() => checkCall('doc.set', { name: 'herdr-app', value: {}, version: 1 })).toThrow(PolicyError);
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: { 'herdr.pinned': '1' } })).toThrow(PolicyError);
    expect(() => checkCall('server.stop', {})).toThrow(PolicyError);
    expect(() => checkCall('terminal.label', { terminal: 't1', labels: { 'herdr.seen': '3' } })).not.toThrow();
    expect(() => checkCall('doc.get', { name: 'herdr-app' })).not.toThrow();
  });
});
