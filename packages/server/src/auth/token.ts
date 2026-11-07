import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_FILE = 'token';
/** The per-device session (auth/sessions.ts). The token itself is never a cookie. */
export const SESSION_COOKIE = 'hm_session';
/** The pre-1.3 cookie that held the token itself: never read, cleared when seen. */
export const LEGACY_COOKIE = 'hm_token';
export const QUERY_PARAM = 'token';

/** Reads the bridge's token from `dir/token`, creating a new 256-bit one (0600, dir 0700) on first run. */
export function loadOrCreateToken(dir: string): string {
  const file = path.join(dir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return token;
}

/** Constant-time comparison (hashing first makes lengths equal). */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The session id a request carries in its cookie, if any. */
export function sessionCookie(headers: Record<string, string | string[] | undefined>): string | null {
  return parseCookies(first(headers.cookie))[SESSION_COOKIE] ?? null;
}

/** `Authorization: Bearer <x>` -> x. */
export function bearer(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = first(headers.authorization);
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

/**
 * The session cookie: HttpOnly (page scripts never see it), SameSite=Strict (the app shell is public and
 * everything signed-in goes over same-origin fetch/WebSocket, so a cross-site navigation never needs it),
 * `Secure` only when the page came over HTTPS (on plain HTTP a Secure cookie is never sent back).
 * 400 days is the longest browsers keep a cookie; the bridge expires idle sessions itself.
 */
export function sessionSetCookie(secret: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${secure ? '; Secure' : ''}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** True when the URL has a `?token=` (old sign-in links: never accepted, only taken out of the address). */
export function hasQueryToken(url: string | undefined): boolean {
  if (!url) return false;
  const q = url.indexOf('?');
  if (q < 0) return false;
  return new URLSearchParams(url.slice(q + 1)).has(QUERY_PARAM);
}

/** The same URL without `?token=` (logs, and the redirect that takes an old link's token out of the address). */
export function stripToken(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  params.delete(QUERY_PARAM);
  const rest = params.toString();
  return rest ? `${url.slice(0, q)}?${rest}` : url.slice(0, q);
}

/**
 * The bridge's token, re-read from its file whenever the file changes (scripts/rotate-token.sh replaces it,
 * and the old token stops working at once). A fixed token (HERDR_MOBILE_TOKEN, tests) never changes.
 */
export class TokenSource {
  private value: string | null;
  private stamp = '';
  private readonly file: string | null;

  constructor(dir: string, fixed: string | null = null) {
    if (fixed) {
      this.value = fixed;
      this.file = null;
      return;
    }
    this.value = loadOrCreateToken(dir);
    this.file = path.join(dir, TOKEN_FILE);
    this.stamp = this.stat() ?? '';
  }

  /** The current token; null when its file is gone or unreadable (then nothing signs in). */
  current(): string | null {
    if (!this.file) return this.value;
    const st = this.stat();
    if (st === null) return null;
    if (st !== this.stamp) {
      try {
        const v = fs.readFileSync(this.file, 'utf8').trim();
        this.value = v.length >= 32 ? v : null;
        this.stamp = st;
      } catch {
        return null;
      }
    }
    return this.value;
  }

  matches(candidate: string | null | undefined): boolean {
    const t = this.current();
    return Boolean(t && candidate && candidate.length <= 512 && tokensEqual(candidate, t));
  }

  private stat(): string | null {
    if (!this.file) return null;
    try {
      const s = fs.statSync(this.file);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }
}
