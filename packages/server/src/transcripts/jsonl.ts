import type { FileHandle } from 'node:fs/promises';

/** One complete line of a JSONL file and where it starts. */
export interface Line {
  offset: number;
  text: string;
}

const NL = 0x0a;
const CHUNK = 256 * 1024;

/**
 * Visits the complete lines that end at or before `end`, newest first, reading
 * the file backward in chunks, until `visit` returns false or the file's start.
 * `end` must be at a line boundary (just after a newline, or 0).
 */
export async function readBackward(fh: FileHandle, end: number, visit: (line: Line) => boolean, chunk = CHUNK): Promise<void> {
  let pos = end;
  // Bytes after the first newline of the chunk read last time: the start of a line we haven't seen the beginning of.
  let carry: Buffer = Buffer.alloc(0);
  while (pos > 0) {
    const size = Math.min(chunk, pos);
    const start = pos - size;
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    while (got < size) {
      const { bytesRead } = await fh.read(buf, got, size - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const data = carry.length ? Buffer.concat([buf.subarray(0, got), carry]) : buf.subarray(0, got);
    // Line ends inside `data`, newest first.
    let lineEnd = data.length;
    if (data[lineEnd - 1] === NL) lineEnd--;
    for (let i = lineEnd - 1; i >= 0; i--) {
      if (data[i] !== NL) continue;
      const text = data.toString('utf8', i + 1, lineEnd);
      if (text.trim() && !visit({ offset: start + i + 1, text })) return;
      lineEnd = i;
    }
    carry = Buffer.from(data.subarray(0, lineEnd));
    pos = start;
  }
  if (carry.length) {
    const text = carry.toString('utf8');
    if (text.trim()) visit({ offset: 0, text });
  }
}

/**
 * The complete lines between `from` and `to` (a trailing line without its
 * newline is left for next time) and the offset just after the last one.
 */
export async function readForward(
  fh: FileHandle,
  from: number,
  to: number,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ lines: Line[]; next: number }> {
  const size = Math.min(to - from, maxBytes);
  if (size <= 0) return { lines: [], next: from };
  const buf = Buffer.allocUnsafe(size);
  let got = 0;
  while (got < size) {
    const { bytesRead } = await fh.read(buf, got, size - got, from + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < got; i++) {
    if (buf[i] !== NL) continue;
    const text = buf.toString('utf8', start, i);
    if (text.trim()) lines.push({ offset: from + start, text });
    start = i + 1;
  }
  // One line bigger than maxBytes: skip it rather than stall.
  if (start === 0 && got === maxBytes) return { lines, next: from + got };
  return { lines, next: from + start };
}

export function parseLine(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
