/**
 * herdr-core framed mode (schema/README.md "Framed mode"):
 * every frame is `[channel u32 LE][kind u8][len u32 LE][payload]`.
 */
export const FrameKind = {
  DATA: 0,
  CREDIT: 1,
  CLOSE: 2,
  RESIZE: 3,
  FOCUS: 4,
  FACTS: 5,
  AUTOMATIC_INPUT: 6,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export const HEADER_LEN = 9;
export const MAX_PAYLOAD = 16 * 1024 * 1024;

export interface Frame {
  channel: number;
  kind: number;
  payload: Buffer;
}

export function encodeFrame(channel: number, kind: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(HEADER_LEN);
  header.writeUInt32LE(channel, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32LE(body.length, 5);
  return Buffer.concat([header, body]);
}

export function creditPayload(bytes: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(bytes >>> 0, 0);
  return b;
}

/** Accumulates socket chunks and yields whole frames. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  /** Chunks of a frame still incomplete, joined once it's whole (not once per chunk). */
  private parts: Buffer[] = [];
  private partsLen = 0;
  /** Bytes `buf` + `parts` must reach before a frame can complete (0: unknown, try now). */
  private need = 0;

  push(chunk: Buffer): Frame[] {
    if (this.need > 0) {
      this.parts.push(chunk);
      this.partsLen += chunk.length;
      if (this.buf.length + this.partsLen < this.need) return [];
      this.buf = Buffer.concat([this.buf, ...this.parts]);
      this.parts = [];
      this.partsLen = 0;
    } else this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.need = 0;
    const out: Frame[] = [];
    let off = 0;
    while (this.buf.length - off >= HEADER_LEN) {
      const len = this.buf.readUInt32LE(off + 5);
      if (len > MAX_PAYLOAD) throw new Error(`frame payload too large: ${len}`);
      if (this.buf.length - off < HEADER_LEN + len) {
        this.need = HEADER_LEN + len;
        break;
      }
      out.push({
        channel: this.buf.readUInt32LE(off),
        kind: this.buf.readUInt8(off + 4),
        // Copy: the payload must outlive this buffer.
        payload: Buffer.from(this.buf.subarray(off + HEADER_LEN, off + HEADER_LEN + len)),
      });
      off += HEADER_LEN + len;
    }
    this.buf = off === this.buf.length ? Buffer.alloc(0) : this.buf.subarray(off);
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.partsLen = 0;
    this.need = 0;
  }
}

/** Splits a byte stream into newline-terminated UTF-8 lines (the event channel). */
export class LineSplitter {
  private rest = '';
  private decoder = new TextDecoder('utf-8');

  push(chunk: Buffer): string[] {
    const text = this.rest + this.decoder.decode(chunk, { stream: true });
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    return lines.filter((l) => l.trim() !== '');
  }
}
