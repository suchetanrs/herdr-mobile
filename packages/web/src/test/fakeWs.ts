/** A WebSocket stand-in the tests drive by hand. */
export class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  static last(): FakeWs {
    const ws = FakeWs.all.at(-1);
    if (!ws) throw new Error('no socket');
    return ws;
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: unknown) {
    this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  }
  receiveBinary(stream: number, bytes: string) {
    const body = new TextEncoder().encode(bytes);
    const buf = new Uint8Array(4 + body.length);
    new DataView(buf.buffer).setUint32(0, stream, true);
    buf.set(body, 4);
    this.onmessage?.({ data: buf.buffer });
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
  }
}
