import { applyPatch, type ServerMessage, type World } from '@herdr-mobile/protocol';
import WebSocket from 'ws';

let defaultCookie = '';
/** The session cookie new Clients send unless given one (tests sign in once per bridge). */
export function useCookie(cookie: string): void {
  defaultCookie = cookie;
}

/** A WS client that keeps its own copy of the world from snapshot + patches. */
export class Client {
  readonly msgs: ServerMessage[] = [];
  world: World | null = null;
  seq = 0;
  serverId = '';
  ws: WebSocket;
  constructor(url: string, hello: Record<string, unknown> | null = { t: 'hello', v: 1 }, cookie: string = defaultCookie) {
    this.ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    this.ws.on('open', () => hello && this.ws.send(JSON.stringify(hello)));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.msgs.push(m);
      if (m.t === 'welcome') this.serverId = m.serverId;
      if (m.t === 'snapshot') {
        this.world = m.world;
        this.seq = m.seq;
      }
      if (m.t === 'patch' && this.world) {
        applyPatch(this.world, m.ops);
        this.seq = m.seq;
      }
      if (m.t === 'alert') this.seq = m.seq;
    });
  }
  of<T extends ServerMessage['t']>(t: T) {
    return this.msgs.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
  close() {
    this.ws.close();
  }
}
