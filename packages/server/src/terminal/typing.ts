import type { CoreClient } from '../core/client.js';
import { creditPayload, FrameKind } from '../core/frames.js';
import { type Logger, silentLogger } from '../log.js';

export interface Grid {
  cols: number;
  rows: number;
}

export interface TypingChannelOptions {
  client: CoreClient;
  terminalId: string;
  /** The terminal's grid right now, as the core has it (terminal.get). */
  currentSize: () => Promise<Grid>;
  /** Close the attach after this long without input. */
  idleMs: number;
  logger?: Logger;
}

/**
 * The bridge's typing viewer for one terminal. herdr-core lets the most
 * recently active typing viewer set a terminal's size (viewers.rs `apply_size`;
 * typing, resizing or focusing makes a viewer active), so the bridge must never
 * become that viewer. It attaches `resumed` (attaching alone doesn't make it
 * active) at the terminal's current grid, lazily on the first input, closes
 * after `idleMs`, and is dropped when the grid changes. Input goes out as
 * AUTOMATIC_INPUT when the core supports it (viewers.rs `viewer_input`: it
 * reaches the program but never touches the viewer, so no size change is
 * possible, even if the desktop resized a moment ago and the bridge hasn't
 * heard yet). On a core without it, the size is checked with the core right
 * before each write and the attach is redone on a mismatch.
 */
export class TypingChannel {
  private readonly log: Logger;
  private channel: number | null = null;
  private opening: Promise<number> | null = null;
  private size: Grid | null = null;
  /** The core takes AUTOMATIC_INPUT on this attach. */
  private automatic = false;
  /** The grid changed while attaching: that attach must not type. */
  private stale = false;
  private idle: NodeJS.Timeout | null = null;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  /** Attaches made (tests, logs). */
  attaches = 0;

  constructor(private readonly opts: TypingChannelOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  get isOpen(): boolean {
    return this.channel !== null;
  }

  get grid(): Grid | null {
    return this.channel !== null ? this.size : null;
  }

  /** Types `bytes` as a person would, in call order. */
  write(bytes: Uint8Array): Promise<void> {
    const next = this.chain.then(() => this.writeNow(bytes));
    this.chain = next.catch(() => {});
    return next;
  }

  private async writeNow(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('typing channel closed');
    if (bytes.length === 0) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const channel = await this.ensure();
      if (!this.automatic) {
        // DATA makes this attach the size leader: only send it at the size the core has right now.
        const now = await this.opts.currentSize();
        if (this.channel !== channel) continue;
        if (!this.size || now.cols !== this.size.cols || now.rows !== this.size.rows) {
          this.log.debug({ terminal: this.opts.terminalId, now }, 'terminal resized; re-attaching before typing');
          this.detach();
          continue;
        }
      }
      const kind = this.automatic ? FrameKind.AUTOMATIC_INPUT : FrameKind.DATA;
      if (!this.opts.client.sendFrame(channel, kind, Buffer.from(bytes))) throw new Error('herdr-core is not connected');
      this.touch();
      return;
    }
    throw new Error('the terminal kept resizing; input not sent');
  }

  /** The terminal's grid is now `grid`: never type through an attach of another size. */
  onGrid(grid: Grid): void {
    if (this.opening) this.stale = true;
    if (this.channel !== null && this.size && (this.size.cols !== grid.cols || this.size.rows !== grid.rows)) this.detach();
  }

  /** The core connection went away; channels are gone with it. */
  onDrop(): void {
    this.channel = null;
    this.opening = null;
    this.clearIdle();
  }

  close(): void {
    this.closed = true;
    this.detach();
  }

  private async ensure(): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.channel !== null) return this.channel;
      if (!this.opening) this.opening = this.open();
      try {
        const ch = await this.opening;
        if (this.channel === ch) return ch;
      } finally {
        this.opening = null;
      }
    }
    throw new Error('the terminal kept resizing; input not sent');
  }

  private async open(): Promise<number> {
    this.stale = false;
    const size = await this.opts.currentSize();
    if (size.cols < 1 || size.rows < 1) throw new Error('terminal size unknown');
    const r = await this.opts.client.call<{ channel: number; automatic_input?: boolean }>('terminal.attach', {
      terminal: this.opts.terminalId,
      cols: size.cols,
      rows: size.rows,
      resumed: true,
      history: 0,
    });
    this.attaches++;
    const ch = r.channel;
    this.opts.client.openChannel(ch, {
      onFrame: (kind, payload) => {
        // Its own paint and output: unused (the shared observer streams them), but credited so it never stalls.
        if (kind === FrameKind.DATA) this.opts.client.sendFrame(ch, FrameKind.CREDIT, creditPayload(payload.length));
        else if (kind === FrameKind.CLOSE && this.channel === ch) {
          this.opts.client.closeChannel(ch, false);
          this.channel = null;
          this.clearIdle();
        }
      },
      onDrop: () => {
        if (this.channel === ch) this.channel = null;
      },
    });
    if (this.stale || this.closed) {
      this.opts.client.closeChannel(ch);
      this.log.debug({ terminal: this.opts.terminalId }, 'grid changed while attaching to type; re-attaching');
      return -1;
    }
    this.channel = ch;
    this.size = size;
    this.automatic = r.automatic_input === true;
    if (!this.automatic)
      this.log.warn({ terminal: this.opts.terminalId }, 'core lacks automatic input; checking the size before each write');
    this.touch();
    return ch;
  }

  private touch(): void {
    this.clearIdle();
    this.idle = setTimeout(() => this.detach(), this.opts.idleMs);
    this.idle.unref();
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private detach(): void {
    this.clearIdle();
    const ch = this.channel;
    this.channel = null;
    if (ch !== null) this.opts.client.closeChannel(ch);
  }
}
