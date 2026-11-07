import type http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { type Logger, silentLogger } from '../log.js';

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** What kind of address a listener is on: decides who may connect and how assets are cached. */
export type ListenKind = 'loopback' | 'tailscale' | 'lan';

/** Tailscale's CGNAT range 100.64.0.0/10. */
export function isTailscaleV4(a: string): boolean {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return false;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x === 100 && y >= 64 && y <= 127;
}

export function isLoopback(a: string | undefined): boolean {
  if (!a) return false;
  return a === '::1' || /^(?:::ffff:)?127\./.test(a);
}

/** Interfaces that aren't a physical/Wi-Fi network: containers and VM bridges (only `all` includes them). */
const VIRTUAL = /^(docker|br-|veth|virbr|vnet|lxc|lxd|cni|flannel|podman|tailscale|tun|wg)/;

export interface BindAddress {
  address: string;
  kind: ListenKind;
}

/**
 * HERDR_MOBILE_BIND entries -> addresses. `loopback` = 127.0.0.1; `tailscale` = this machine's tailnet IPv4
 * (the `tailscale0` interface, else any 100.64.0.0/10 address); `lan` = the IPv4 addresses of physical
 * interfaces (Wi-Fi/Ethernet, no docker/VM bridges); `all` = every IPv4 address; anything else is taken as an
 * address. `missing`: names that resolve to nothing right now (Tailscale down).
 */
export function resolveBind(
  spec: readonly string[],
  ifaces: Interfaces = os.networkInterfaces(),
): { addresses: BindAddress[]; missing: string[] } {
  const addresses: BindAddress[] = [];
  const missing: string[] = [];
  const add = (address: string, kind: ListenKind) => {
    if (!addresses.some((a) => a.address === address)) addresses.push({ address, kind });
  };
  const v4 = (list: Interfaces[string]) => (list ?? []).filter((i) => i.family === 'IPv4').map((i) => i.address);
  for (const raw of spec) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    if (s === 'loopback' || s === 'localhost') add('127.0.0.1', 'loopback');
    else if (s === 'tailscale') {
      const found = v4(ifaces.tailscale0).concat(...Object.values(ifaces).map((l) => v4(l).filter(isTailscaleV4)));
      if (found[0]) add(found[0], 'tailscale');
      else missing.push('tailscale');
    } else if (s === 'lan' || s === 'all') {
      for (const [name, list] of Object.entries(ifaces)) {
        if (s === 'lan' && VIRTUAL.test(name)) continue;
        for (const a of v4(list)) {
          if (isLoopback(a)) continue;
          add(a, isTailscaleV4(a) ? 'tailscale' : 'lan');
        }
      }
    } else if (net.isIP(s)) add(s, isLoopback(s) ? 'loopback' : isTailscaleV4(s) ? 'tailscale' : 'lan');
    else throw new Error(`HERDR_MOBILE_BIND: "${raw}" is not loopback, tailscale, lan, all or an IP address`);
  }
  return { addresses, missing };
}

/** IPv4 CIDR / address list (HERDR_MOBILE_ALLOW_PEERS). */
export function peerMatcher(list: readonly string[]): ((ip: string) => boolean) | null {
  if (list.length === 0) return null;
  const block = new net.BlockList();
  for (const raw of list) {
    const [addr, bits] = raw.split('/');
    if (!addr || net.isIPv4(addr) === false) throw new Error(`HERDR_MOBILE_ALLOW_PEERS: "${raw}" is not an IPv4 address or CIDR`);
    if (bits === undefined) block.addAddress(addr, 'ipv4');
    else block.addSubnet(addr, Number(bits), 'ipv4');
  }
  return (ip: string) => {
    const v4 = ip.replace(/^::ffff:/, '');
    return net.isIPv4(v4) && block.check(v4, 'ipv4');
  };
}

const NETWORK = Symbol('herdr-mobile.network');
const KIND = Symbol('herdr-mobile.kind');
type Tagged = net.Socket & { [NETWORK]?: true; [KIND]?: ListenKind };

/** True for a connection that came in on a non-loopback listener (it gets the per-peer limits). */
export function isNetworkSocket(sock: net.Socket | undefined | null): boolean {
  return Boolean(sock && (sock as Tagged)[NETWORK]);
}

/** Which listener a connection came in on (loopback for the main server). */
export function socketKind(sock: net.Socket | undefined | null): ListenKind {
  return (sock && (sock as Tagged)[KIND]) || 'loopback';
}

export interface GateOptions {
  /** Open connections across all network listeners. */
  maxTotal?: number;
  /** Open connections per peer address. */
  maxPerPeer?: number;
  /** Only these peers may connect at all (HERDR_MOBILE_ALLOW_PEERS); null: anyone. */
  allowPeer?: ((ip: string) => boolean) | null;
  logger?: Logger;
}

/**
 * Admission for connections on network listeners, before any HTTP parsing: a total cap, a per-peer cap,
 * the optional peer allowlist, and on the Tailscale address only tailnet peers (100.64.0.0/10) or this
 * machine itself (a packet from the Wi-Fi addressed to the Tailscale IP is not a tailnet peer).
 */
export class ConnectionGate {
  private readonly perPeer = new Map<string, number>();
  private total = 0;
  private readonly maxTotal: number;
  private readonly maxPerPeer: number;
  private readonly log: Logger;
  private readonly warned = new Map<string, number>();

  constructor(private readonly opts: GateOptions = {}) {
    this.maxTotal = opts.maxTotal ?? 512;
    this.maxPerPeer = opts.maxPerPeer ?? 32;
    this.log = opts.logger ?? silentLogger;
  }

  get open(): number {
    return this.total;
  }

  admit(sock: net.Socket, kind: ListenKind): boolean {
    const peer = sock.remoteAddress ?? '';
    let why: string | null = null;
    if (kind === 'tailscale' && !isTailscaleV4(peer) && !isLoopback(peer)) why = 'not a tailnet peer';
    else if (this.opts.allowPeer && !isLoopback(peer) && !this.opts.allowPeer(peer)) why = 'not in HERDR_MOBILE_ALLOW_PEERS';
    else if (this.total >= this.maxTotal) why = 'too many connections';
    else if ((this.perPeer.get(peer) ?? 0) >= this.maxPerPeer) why = 'too many connections from this address';
    if (why) {
      this.note(peer, why);
      sock.destroy();
      return false;
    }
    this.total++;
    this.perPeer.set(peer, (this.perPeer.get(peer) ?? 0) + 1);
    (sock as Tagged)[NETWORK] = true;
    (sock as Tagged)[KIND] = kind;
    sock.once('close', () => {
      this.total--;
      const n = (this.perPeer.get(peer) ?? 1) - 1;
      if (n <= 0) this.perPeer.delete(peer);
      else this.perPeer.set(peer, n);
    });
    return true;
  }

  /** One warning per peer and reason per 10 minutes (a flood must not flood the journal). */
  private note(peer: string, why: string): void {
    const key = `${peer} ${why}`;
    const at = Date.now();
    if ((this.warned.get(key) ?? 0) > at) return;
    if (this.warned.size > 1000) this.warned.clear();
    this.warned.set(key, at + 10 * 60_000);
    this.log.warn({ ip: peer, why }, 'connection refused');
  }
}

export interface NetworkListenersOptions {
  /** The HTTP server every accepted connection is handed to (HTTP and WebSocket upgrades alike). */
  target: http.Server;
  gate: ConnectionGate;
  logger?: Logger;
  /** How often interfaces are checked for a Tailscale address appearing, changing or going away. */
  pollMs?: number;
  ifaces?: () => Interfaces;
}

/**
 * The bridge's non-loopback listeners (the loopback one is the HTTP server's own). Each is a plain TCP server
 * that hands admitted connections to the HTTP server. Interfaces are re-checked every `pollMs`: an address that
 * appears is bound, one that goes away (Tailscale down, a new tailnet IP) is closed. `onChange` reports the
 * bound set (the Host allowlist follows it).
 */
export class NetworkListeners {
  private readonly servers = new Map<string, net.Server>();
  private spec: readonly string[] = [];
  private skip = '';
  private port = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private readonly ifaces: () => Interfaces;
  private busy: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(addresses: string[]) => void>();
  private lastMissing = '';

  constructor(private readonly opts: NetworkListenersOptions) {
    this.log = opts.logger ?? silentLogger;
    this.ifaces = opts.ifaces ?? (() => os.networkInterfaces());
  }

  /** Addresses listened on now, the loopback one included. */
  get addresses(): string[] {
    return [this.skip, ...this.servers.keys()].filter(Boolean);
  }

  onChange(l: (addresses: string[]) => void): void {
    this.listeners.add(l);
  }

  /** Listens on `port` at every address of `spec` except `skip` (where the HTTP server itself listens), and keeps it so. */
  async start(spec: readonly string[], skip: string, port: number): Promise<void> {
    this.spec = spec;
    this.skip = skip;
    this.port = port;
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.opts.pollMs ?? 5000);
    this.timer.unref();
  }

  /** Brings the listeners in line with the interfaces now (also run by the poll). */
  reconcile(): Promise<void> {
    this.busy = this.busy.then(() => this.apply()).catch(() => {});
    return this.busy;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy;
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }

  private async apply(): Promise<void> {
    const { addresses, missing } = resolveBind(this.spec, this.ifaces());
    const missingNow = missing.join(',');
    if (missingNow !== this.lastMissing) {
      if (missing.length) this.log.warn({ missing }, 'bind address not available; listening on the rest (re-checked every few seconds)');
      this.lastMissing = missingNow;
    }
    const wanted = addresses.filter((a) => a.address !== this.skip);
    let changed = false;
    for (const [address, server] of this.servers) {
      if (wanted.some((w) => w.address === address)) continue;
      this.servers.delete(address);
      server.close();
      this.log.info({ address }, 'stopped listening (address gone)');
      changed = true;
    }
    for (const w of wanted) {
      if (this.servers.has(w.address)) continue;
      if (await this.listen(w)) changed = true;
    }
    if (changed) for (const l of this.listeners) l(this.addresses);
  }

  private async listen({ address, kind }: BindAddress): Promise<boolean> {
    const server = net.createServer({ pauseOnConnect: false }, (sock) => {
      if (this.opts.gate.admit(sock, kind)) this.opts.target.emit('connection', sock);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: address, port: this.port }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err) => this.log.warn({ address, err: err.message }, 'listener error'));
      this.servers.set(address, server);
      if (kind === 'lan')
        this.log.warn(
          { address, port: this.port },
          'listening on a LAN address: plain HTTP, the sign-in token and everything typed cross this network in cleartext',
        );
      else this.log.info({ address, port: this.port }, 'also listening');
      return true;
    } catch (err) {
      this.log.warn({ address, err: (err as Error).message }, 'could not listen on bind address (retrying)');
      return false;
    }
  }
}
