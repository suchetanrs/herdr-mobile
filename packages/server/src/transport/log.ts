import type { AttentionAlert, PatchOp, StreamMessage } from '@herdr-mobile/protocol';

/**
 * The numbered stream of world patches and alerts. Keeps the last `capacity`
 * messages so a reconnecting client can catch up without a full snapshot.
 */
export class StreamLog {
  private seqNo = 0;
  private readonly entries: StreamMessage[] = [];
  constructor(private readonly capacity = 2000) {}

  get seq(): number {
    return this.seqNo;
  }

  patch(ops: PatchOp[]): StreamMessage {
    return this.push({ t: 'patch', seq: ++this.seqNo, ops });
  }

  alert(alert: AttentionAlert): StreamMessage {
    return this.push({ t: 'alert', seq: ++this.seqNo, alert });
  }

  /** Messages after `seq`, or null when they're no longer all here (the client needs a snapshot). */
  since(seq: number): StreamMessage[] | null {
    if (seq > this.seqNo || seq < 0) return null;
    if (seq === this.seqNo) return [];
    const first = this.entries[0];
    if (!first || first.seq > seq + 1) return null;
    return this.entries.slice(seq + 1 - first.seq);
  }

  private push(m: StreamMessage): StreamMessage {
    this.entries.push(m);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return m;
  }
}
