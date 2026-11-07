import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { type Logger, silentLogger } from '../log.js';

export const SESSIONS_FILE = 'sessions.json';

/** One signed-in device. Only the hash of its secret is kept; `id` is a public handle (device list, revoke). */
export interface DeviceSession {
  id: string;
  hash: string;
  name: string;
  /** ms since epoch */
  created: number;
  lastSeen: number;
  /** The address it was last seen from. */
  ip: string;
}

export interface SessionStoreOptions {
  /** Folder of sessions.json (the bridge's config dir). */
  dir: string;
  /** A session unused this long is gone (default 90 days). */
  idleMs?: number;
  /** Most sessions kept (the least recently seen goes first). */
  max?: number;
  /** lastSeen is written at most this often (sign-ins and revokes are written at once). */
  flushMs?: number;
  now?: () => number;
  logger?: Logger;
}

const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex');
/** 256-bit base64url. */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Per-device sessions: the token is presented once (sign-in) and exchanged for a random session secret that
 * lives only in the device's HttpOnly cookie; the bridge keeps its SHA-256 in sessions.json (0600, written
 * atomically). Emits 'revoke' with the ids that stopped being valid (so open WebSockets can be closed).
 */
export class SessionStore extends EventEmitter<{ revoke: [ids: string[]] }> {
  private readonly file: string;
  private readonly byHash = new Map<string, DeviceSession>();
  private readonly idleMs: number;
  private readonly max: number;
  private readonly flushMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionStoreOptions) {
    super();
    this.file = path.join(opts.dir, SESSIONS_FILE);
    this.idleMs = opts.idleMs ?? 90 * 24 * 3600_000;
    this.max = opts.max ?? 100;
    this.flushMs = opts.flushMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.load();
  }

  get size(): number {
    return this.byHash.size;
  }

  /** A new session for a device that just presented the token. The secret goes in its cookie, nowhere else. */
  create(input: { name: string; ip: string }): { secret: string; session: DeviceSession } {
    const secret = randomBytes(32).toString('base64url');
    const at = this.now();
    const session: DeviceSession = {
      id: randomBytes(9).toString('base64url'),
      hash: hashOf(secret),
      name: input.name.slice(0, 80),
      created: at,
      lastSeen: at,
      ip: input.ip,
    };
    this.byHash.set(session.hash, session);
    while (this.byHash.size > this.max) {
      const oldest = [...this.byHash.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!oldest) break;
      this.byHash.delete(oldest.hash);
      this.emit('revoke', [oldest.id]);
    }
    this.save();
    return { secret, session };
  }

  /**
   * The session a cookie's secret belongs to (null: unknown, expired or malformed). Marks it seen from `ip`;
   * `moved` says the address differs from last time.
   */
  verify(secret: string | null | undefined, ip?: string): { session: DeviceSession; moved: boolean } | null {
    if (!secret || !SECRET_RE.test(secret)) return null;
    const s = this.byHash.get(hashOf(secret));
    if (!s) return null;
    const at = this.now();
    if (at - s.lastSeen > this.idleMs) {
      this.byHash.delete(s.hash);
      this.save();
      this.emit('revoke', [s.id]);
      return null;
    }
    const moved = ip !== undefined && ip !== s.ip;
    if (moved) s.ip = ip;
    if (moved || at - s.lastSeen > 1000) {
      s.lastSeen = at;
      this.later();
    }
    return { session: s, moved };
  }

  /** Every live session, most recently seen first. */
  list(): DeviceSession[] {
    return [...this.byHash.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  revoke(id: string): boolean {
    for (const s of this.byHash.values()) {
      if (s.id !== id) continue;
      this.byHash.delete(s.hash);
      this.save();
      this.emit('revoke', [id]);
      return true;
    }
    return false;
  }

  revokeAll(): number {
    const ids = [...this.byHash.values()].map((s) => s.id);
    this.byHash.clear();
    this.save();
    if (ids.length) this.emit('revoke', ids);
    return ids.length;
  }

  /** Writes pending lastSeen updates (on shutdown). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.dirty) this.save();
  }

  private later(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.save();
    }, this.flushMs);
    this.timer.unref();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log.warn({ err: (err as Error).message }, 'sessions file unreadable; starting with none');
      return;
    }
    try {
      const data = JSON.parse(raw) as { v?: number; sessions?: unknown[] };
      const at = this.now();
      for (const x of data.sessions ?? []) {
        const s = x as Partial<DeviceSession>;
        if (
          typeof s.id !== 'string' ||
          typeof s.hash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(s.hash) ||
          typeof s.created !== 'number' ||
          typeof s.lastSeen !== 'number'
        )
          continue;
        if (at - s.lastSeen > this.idleMs) continue;
        this.byHash.set(s.hash, {
          id: s.id,
          hash: s.hash,
          name: typeof s.name === 'string' ? s.name : 'Unknown device',
          created: s.created,
          lastSeen: s.lastSeen,
          ip: typeof s.ip === 'string' ? s.ip : '',
        });
      }
    } catch {
      this.log.warn({}, 'sessions file is not valid JSON; starting with none');
    }
  }

  /** Atomic: a 0600 temp file in the same folder, then rename. */
  private save(): void {
    this.dirty = false;
    const body = `${JSON.stringify({ v: 1, sessions: [...this.byHash.values()] }, null, 1)}\n`;
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'could not write the sessions file');
    }
  }
}

/** A short device name from its User-Agent: "iPhone · Safari", "Android · Chrome", "Linux · Firefox". */
export function deviceName(ua: string | undefined, standalone = false): string {
  const u = ua ?? '';
  const os = /iPhone/.test(u)
    ? 'iPhone'
    : /iPad/.test(u)
      ? 'iPad'
      : /Android/.test(u)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(u)
          ? 'Mac'
          : /Windows/.test(u)
            ? 'Windows'
            : /CrOS/.test(u)
              ? 'ChromeOS'
              : /Linux/.test(u)
                ? 'Linux'
                : '';
  const browser = /Edg\//.test(u)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(u)
      ? 'Firefox'
      : /CriOS|Chrome\//.test(u)
        ? 'Chrome'
        : /Safari\//.test(u) || /AppleWebKit/.test(u)
          ? 'Safari'
          : /^curl\//.test(u)
            ? 'curl'
            : /node|undici/i.test(u)
              ? 'script'
              : '';
  const name = [os, browser].filter(Boolean).join(' · ') || 'Unknown device';
  return standalone ? `${name} (home screen)` : name;
}
