import net from 'node:net';

type Headers = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Host names the bridge answers to: exactly the addresses it listens on (kept current as Tailscale comes and
 * goes), plus `localhost`/`127.0.0.1`/`[::1]` on the loopback listener, plus any names listed in
 * HERDR_MOBILE_ALLOWED_HOSTS. No wildcard suffixes. Anything else is a page that pointed its own domain at
 * this address (DNS rebinding) and is refused. The port must be the bridge's when one is given.
 */
export class HostCheck {
  private bound = new Set<string>(['127.0.0.1']);
  private readonly extra: Set<string>;
  private port = 0;

  constructor(extra: readonly string[] = []) {
    this.extra = new Set(extra.map((x) => x.toLowerCase()));
  }

  /** The listening addresses and port (called again whenever they change). */
  setBound(addresses: readonly string[], port: number): void {
    this.bound = new Set(addresses.map((a) => a.toLowerCase()));
    this.port = port;
  }

  /** `local`: the connection came in on the loopback listener (localhost names only count there). */
  allows(hostHeader: string | undefined, local = true): boolean {
    if (!hostHeader) return true; // HTTP/1.0 without Host: not a browser
    const parsed = hostOnly(hostHeader.toLowerCase());
    if (!parsed) return false;
    const { host, port } = parsed;
    // Names listed in HERDR_MOBILE_ALLOWED_HOSTS come through a local proxy (`tailscale serve`: port 443).
    if (this.extra.has(host)) return true;
    if (port !== null && this.port !== 0 && port !== this.port) return false;
    if (port === null && this.port !== 0 && this.port !== 80) return false;
    if (LOCAL_NAMES.has(host)) return local;
    return net.isIP(host) !== 0 && this.bound.has(host);
  }
}

/** `name:port`, `[v6]:port`, `v4` -> host and port; null when malformed. */
function hostOnly(h: string): { host: string; port: number | null } | null {
  let host: string;
  let rest: string;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end <= 0) return null;
    host = h.slice(1, end);
    rest = h.slice(end + 1);
  } else {
    const colon = h.lastIndexOf(':');
    host = colon >= 0 ? h.slice(0, colon) : h;
    rest = colon >= 0 ? h.slice(colon) : '';
  }
  if (!host) return null;
  if (rest === '') return { host, port: null };
  if (!/^:\d{1,5}$/.test(rest)) return null;
  return { host, port: Number(rest.slice(1)) };
}

/**
 * True when a browser says this request comes from another site's page: an `<img>`, `fetch`, form, frame or
 * a navigation started by another site. API calls only ever come from the app's own pages (same-origin) or
 * from tools (no Fetch Metadata at all), so anything else is refused before it can use a session or count as
 * a failed sign-in. Uses Fetch Metadata (`Sec-Fetch-Site`, all current browsers) and `Origin`.
 */
export function foreignRequest(headers: Headers): boolean {
  const site = first(headers['sec-fetch-site']);
  const origin = first(headers.origin);
  if (origin !== undefined) {
    if (origin === 'null') return true;
    try {
      if (new URL(origin).host !== (first(headers.host) ?? '').toLowerCase()) return true;
    } catch {
      return true;
    }
  }
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}
