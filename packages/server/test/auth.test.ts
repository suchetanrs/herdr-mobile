import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clientAddress } from '../src/app.js';
import { AuthLimiter } from '../src/auth/limiter.js';
import {
  bearer,
  hasQueryToken,
  loadOrCreateToken,
  parseCookies,
  sessionCookie,
  sessionSetCookie,
  stripToken,
  TokenSource,
  tokensEqual,
} from '../src/auth/token.js';
import { loadConfig } from '../src/config.js';
import { sameOrigin } from '../src/transport/ws.js';
import { rmDir, tmpDir } from './helpers/tmp.js';

const dir = tmpDir('auth');
afterAll(() => rmDir(dir));

describe('token', () => {
  it('creates a long random token once, private, and reuses it', () => {
    const cfg = path.join(dir, 'herdr-mobile');
    const a = loadOrCreateToken(cfg);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.statSync(path.join(cfg, 'token')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o700);
    expect(loadOrCreateToken(cfg)).toBe(a);
  });

  it('compares in constant time and exactly', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
  });

  it('reads the session cookie and a bearer header; the token source follows its file', () => {
    expect(sessionCookie({ cookie: 'a=1; hm_session=abc' })).toBe('abc');
    expect(sessionCookie({ cookie: 'hm_token=abc' })).toBeNull();
    expect(bearer({ authorization: 'Bearer xyz' })).toBe('xyz');
    expect(bearer({ authorization: 'Basic xyz' })).toBeNull();
    const cfg = path.join(dir, 'src');
    const src = new TokenSource(cfg);
    const t = src.current() as string;
    expect(src.matches(t)).toBe(true);
    expect(src.matches(`${t}x`)).toBe(false);
    fs.rmSync(path.join(cfg, 'token'));
    expect(src.matches(t)).toBe(false);
    expect(new TokenSource(cfg, 'f'.repeat(40)).matches('f'.repeat(40))).toBe(true);
  });

  it('parses and strips', () => {
    expect(parseCookies('a=1; b=%20x')).toEqual({ a: '1', b: ' x' });
    expect(hasQueryToken('/ws?token=abc&x=1')).toBe(true);
    expect(hasQueryToken('/ws?x=1')).toBe(false);
    expect(stripToken('/a?token=abc&x=1')).toBe('/a?x=1');
    expect(stripToken('/a?token=abc')).toBe('/a');
  });
});

describe('auth hardening', () => {
  it('blocks an address after too many failures, for a while, and forgets on success', () => {
    let now = 0;
    const lim = new AuthLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000, now: () => now });
    expect(lim.fail('a')).toBe(false);
    expect(lim.fail('a')).toBe(false);
    expect(lim.blockedFor('a')).toBe(0);
    expect(lim.fail('a')).toBe(true);
    expect(lim.blockedFor('a')).toBe(5000);
    expect(lim.blockedFor('b')).toBe(0);
    now = 5001;
    expect(lim.blockedFor('a')).toBe(0);
    // Old failures fall out of the window.
    lim.fail('c');
    lim.fail('c');
    now += 2000;
    expect(lim.fail('c')).toBe(false);
    lim.succeed('c');
    lim.fail('c');
    expect(lim.fail('c')).toBe(false);
  });

  it('keeps a bounded number of addresses', () => {
    const lim = new AuthLimiter({ maxFailures: 2, maxTracked: 2 });
    lim.fail('a');
    lim.fail('b');
    lim.fail('c');
    expect(lim.fail('a')).toBe(false); // 'a' was dropped, so this is its first failure again
  });

  it('session cookie is HttpOnly + SameSite=Strict, Secure only over HTTPS', () => {
    expect(sessionSetCookie('abc', false)).toMatch(/^hm_session=abc; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(sessionSetCookie('abc', true)).toMatch(/; Secure$/);
  });

  it('WebSocket origin must match the host', () => {
    expect(sameOrigin({ headers: { host: '100.1.2.3:8787' } })).toBe(true);
    expect(sameOrigin({ headers: { host: '100.1.2.3:8787', origin: 'http://100.1.2.3:8787' } })).toBe(true);
    expect(sameOrigin({ headers: { host: 'Box.ts.net', origin: 'https://box.ts.net' } })).toBe(true);
    expect(sameOrigin({ headers: { host: '100.1.2.3:8787', origin: 'http://evil.example' } })).toBe(false);
    expect(sameOrigin({ headers: { host: '100.1.2.3:8787', origin: 'null' } })).toBe(false);
  });

  it('client address honours X-Forwarded-For only from a trusted loopback proxy', () => {
    expect(clientAddress('100.9.9.9', '1.2.3.4', true)).toBe('100.9.9.9');
    expect(clientAddress('127.0.0.1', '100.5.5.5, 127.0.0.1', true)).toBe('100.5.5.5');
    expect(clientAddress('127.0.0.1', '100.5.5.5', false)).toBe('127.0.0.1');
  });
});

describe('config', () => {
  it('defaults and env overrides', () => {
    const c = loadConfig({ HOME: '/home/me', XDG_RUNTIME_DIR: '/run/user/7' });
    expect(c).toMatchObject({
      host: '127.0.0.1',
      bind: ['loopback', 'tailscale'],
      port: 8787,
      socketPath: '/run/user/7/herdr-core/default.sock',
      configDir: '/home/me/.config/herdr-mobile',
    });
    const d = loadConfig({
      HOME: '/h',
      HERDR_MOBILE_PORT: '9000',
      HERDR_MOBILE_HOST: '127.0.0.1',
      HC_SOCKET: '/s.sock',
      HERDR_MOBILE_DONE_GRACE_MS: '0',
    });
    expect(d).toMatchObject({ port: 9000, host: '127.0.0.1', socketPath: '/s.sock', doneGraceMs: 0 });
    // A pre-1.3 HERDR_MOBILE_HOST=0.0.0.0 no longer opens the LAN: ignored (and warned about at start).
    expect(loadConfig({ HOME: '/h', HERDR_MOBILE_HOST: '0.0.0.0' })).toMatchObject({ host: '127.0.0.1', legacyHost: '0.0.0.0' });
    expect(() => loadConfig({ HERDR_MOBILE_PORT: 'x' })).toThrow();
  });
});
