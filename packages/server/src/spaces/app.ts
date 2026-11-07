import net from 'node:net';
import path from 'node:path';
import { checkAppRequest } from '../core/policy.js';

/**
 * The Herdr window's control socket (`$HERDR_APP_HOME/herdr-app.sock`, control.rs: one JSON line
 * each way), the channel `herdr-app status` / `herdr-app do` use. Only what policy.ts
 * `checkAppRequest` allows: is the window open, and naming a space or tab the bridge made.
 */
export class HerdrApp {
  readonly socketPath: string;

  constructor(
    herdrAppDir: string,
    private readonly timeoutMs = 3000,
  ) {
    this.socketPath = path.join(herdrAppDir, 'herdr-app.sock');
  }

  /** The window answers (it adopts new spaces; without it nothing would show them). */
  async isOpen(): Promise<boolean> {
    try {
      const r = await this.request({ status: true });
      return r !== null && typeof r === 'object' && !('error' in r);
    } catch {
      return false;
    }
  }

  async renameSpace(id: string, name: string): Promise<void> {
    const r = (await this.request({ do: 'space.rename', args: { id, name } })) as { error?: unknown } | null;
    if (r && typeof r === 'object' && r.error) throw new Error(String(r.error));
  }

  async renameTab(id: string, name: string): Promise<void> {
    const r = (await this.request({ do: 'tab.rename', args: { id, name } })) as { error?: unknown } | null;
    if (r && typeof r === 'object' && r.error) throw new Error(String(r.error));
  }

  private request(msg: Record<string, unknown>): Promise<unknown> {
    checkAppRequest(msg);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let buf = '';
      const done = (err: Error | null, value?: unknown) => {
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(() => done(new Error('Herdr did not answer')), this.timeoutMs);
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(`${JSON.stringify(msg)}\n`));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl === -1) {
          if (buf.length > 1 << 20) done(new Error('Herdr answered too much'));
          return;
        }
        try {
          done(null, JSON.parse(buf.slice(0, nl)));
        } catch {
          done(new Error('Herdr answered something else'));
        }
      });
      sock.on('error', (e) => done(e));
      sock.on('end', () => done(new Error('Herdr hung up')));
    });
  }
}
