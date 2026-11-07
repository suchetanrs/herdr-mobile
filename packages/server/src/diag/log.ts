import fs from 'node:fs';
import path from 'node:path';

/** Largest diagnostics report a device may send (bytes of JSON). */
export const DIAG_BODY_LIMIT = 48 * 1024;
/** The file is moved to `<file>.1` (replacing the older one) once it passes this size. */
export const DIAG_FILE_MAX = 2 * 1024 * 1024;
/** Reports per device per minute, and per hour. */
export const DIAG_PER_MINUTE = 6;
export const DIAG_PER_HOUR = 60;

const MAX_DEPTH = 5;
const MAX_ITEMS = 400;
const MAX_KEYS = 60;
const MAX_STRING = 300;
/** Keys never written, whatever the page sent: they could only hold secrets or what was typed/shown. */
const SECRET_KEY = /token|cookie|secret|passw|auth|session|value|content|typed|html|text$/i;
/** A long run of token-ish characters (a session secret, a token, a long id): redacted. */
const TOKENISH = /[A-Za-z0-9_\-+/=]{32,}/g;

/**
 * A device's report, made safe to keep: plain JSON only, bounded depth/size, secret-looking keys dropped and
 * token-like strings redacted. The page's recorder (web lib/diag.ts) already leaves those out; this is the
 * bridge's own guarantee.
 */
export function sanitize(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return redact(v);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(v)) return v.slice(-MAX_ITEMS).map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) break;
      if (k.length > 40 || SECRET_KEY.test(k)) continue;
      out[k] = sanitize(x, depth + 1);
    }
    return out;
  }
  return null;
}

export function redact(s: string): string {
  const cut = s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  return cut.replace(TOKENISH, '[redacted]');
}

/** Per-device sliding windows: at most DIAG_PER_MINUTE a minute and DIAG_PER_HOUR an hour. */
export class DiagLimiter {
  private readonly seen = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  allow(device: string): boolean {
    const t = this.now();
    const list = (this.seen.get(device) ?? []).filter((x) => t - x < 3_600_000);
    const lastMinute = list.filter((x) => t - x < 60_000).length;
    if (lastMinute >= DIAG_PER_MINUTE || list.length >= DIAG_PER_HOUR) {
      this.seen.set(device, list);
      return false;
    }
    list.push(t);
    this.seen.set(device, list);
    if (this.seen.size > 200) {
      for (const [k, v] of this.seen) if (t - (v[v.length - 1] ?? 0) >= 3_600_000) this.seen.delete(k);
    }
    return true;
  }
}

/**
 * Appends one JSON line per report to the diagnostics file (0600, its folder 0700). Past DIAG_FILE_MAX the
 * file becomes `<file>.1`, so the two never hold more than ~2x that.
 */
export class DiagLog {
  constructor(
    readonly file: string,
    private readonly maxBytes = DIAG_FILE_MAX,
  ) {}

  append(entry: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(entry)}\n`;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {}
    if (size > 0 && size + line.length > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
    const fd = fs.openSync(this.file, 'a', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  }
}
