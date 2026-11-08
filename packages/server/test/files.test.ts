// The file browser: path resolution, private folders, non-regular files, download headers, ranges, limits.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FS_PAGE, type FsFile, type FsListing } from '@herdr-mobile/protocol';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentDisposition, expandPath, FileBrowser, FsFailure, parseRange } from '../src/files/browse.js';
import { registerFileRoutes, WindowLimiter } from '../src/transport/files.js';
import { startBridge, type TestBridge, TOKEN } from './helpers/bridge.js';
import { rmDir, tmpDir } from './helpers/tmp.js';

let dir = '';
let home = '';
let cfg = '';
let browser: FileBrowser;

beforeEach(() => {
  dir = fs.realpathSync(tmpDir('fs'));
  home = path.join(dir, 'home');
  cfg = path.join(home, '.config', 'herdr-mobile');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'token'), 'secret-token');
  fs.writeFileSync(path.join(cfg, 'env'), 'HERDR_MOBILE_TOKEN=x');
  fs.mkdirSync(path.join(home, 'code', 'app'), { recursive: true });
  fs.writeFileSync(path.join(home, 'code', 'notes.txt'), 'hello notes');
  fs.writeFileSync(path.join(home, '.bashrc'), '# rc');
  fs.writeFileSync(path.join(home, 'a10.txt'), 'x');
  fs.writeFileSync(path.join(home, 'a9.txt'), 'x');
  fs.writeFileSync(path.join(home, 'Zeta.txt'), 'x');
  fs.mkdirSync(path.join(home, 'zdir'));
  browser = new FileBrowser({ home, privateDirs: [cfg], privateFiles: [path.join(dir, 'diag.jsonl')] });
});
afterEach(() => rmDir(dir));

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof FsFailure ? `${e.status} ${e.code}` : String(e);
  }
};

describe('expandPath', () => {
  it('~, ~/x, absolute, relative to home, quotes; refuses ~user, control characters, long paths', () => {
    expect(expandPath('', '/h')).toBe('/h');
    expect(expandPath('  ~  ', '/h')).toBe('/h');
    expect(expandPath('~/a/../b/', '/h')).toBe('/h/b');
    expect(expandPath('/etc/../usr', '/h')).toBe('/usr');
    expect(expandPath('code', '/h')).toBe('/h/code');
    expect(expandPath('"/tmp/a b"', '/h')).toBe('/tmp/a b');
    expect(expandPath("'~/x'", '/h')).toBe('/h/x');
    expect(() => expandPath('~root/x', '/h')).toThrow(/Only ~/);
    expect(() => expandPath('/a\nb', '/h')).toThrow(/control/);
    expect(() => expandPath(`/${'a'.repeat(5000)}`, '/h')).toThrow(/too long/);
  });
});

describe('FileBrowser', () => {
  it('lists folders first, then files by name (numeric), hidden only when asked, in pages', async () => {
    const l = (await browser.lookup('~')) as FsListing;
    expect(l.kind).toBe('dir');
    expect(l.path).toBe(home);
    expect(l.parent).toBe(dir);
    expect(l.home).toBe(home);
    expect(l.entries.map((e) => e.name)).toEqual(['code', 'zdir', 'a9.txt', 'a10.txt', 'Zeta.txt']);
    expect(l.hidden).toBe(2); // .bashrc, .config
    const a9 = l.entries.find((e) => e.name === 'a9.txt');
    expect(a9).toMatchObject({ kind: 'file', size: 1, link: false });
    expect(typeof a9?.mtime).toBe('number');
    const withHidden = (await browser.lookup('~', { hidden: true })) as FsListing;
    expect(withHidden.entries.map((e) => e.name)).toContain('.bashrc');
    expect(withHidden.entries.map((e) => e.name)).toContain('.config');
    expect(withHidden.hidden).toBe(0);
    const big = path.join(home, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i < FS_PAGE + 20; i++) fs.writeFileSync(path.join(big, `f${i}`), '');
    const p1 = (await browser.lookup('~/big')) as FsListing;
    expect(p1.entries.length).toBe(FS_PAGE);
    expect(p1.total).toBe(FS_PAGE + 20);
    const p2 = (await browser.lookup('~/big', { offset: FS_PAGE })) as FsListing;
    expect(p2.entries.length).toBe(20);
    expect(p2.offset).toBe(FS_PAGE);
    expect(p2.entries[19]?.name).toBe(`f${FS_PAGE + 19}`);
    expect(((await browser.lookup('/')) as FsListing).parent).toBeNull();
  });

  it('describes a typed file (so the page can download it)', async () => {
    const f = (await browser.lookup('~/code/notes.txt')) as FsFile;
    expect(f).toMatchObject({ kind: 'file', path: path.join(home, 'code/notes.txt'), name: 'notes.txt', size: 11, downloadable: true });
    const dev = (await browser.lookup('/dev/null')) as FsFile;
    expect(dev).toMatchObject({ kind: 'file', downloadable: false });
  });

  it('resolves .. and symlinks; missing paths 404', async () => {
    fs.symlinkSync(path.join(home, 'code'), path.join(home, 'link-code'));
    expect(((await browser.lookup('~/link-code')) as FsListing).path).toBe(path.join(home, 'code'));
    expect(((await browser.lookup('~/code/app/../..')) as FsListing).path).toBe(home);
    expect(await code(browser.lookup('~/nope'))).toBe('404 not-found');
    expect(await code(browser.lookup('~/code/notes.txt/x'))).toBe('404 not-found');
    const l = (await browser.lookup('~')) as FsListing;
    expect(l.entries.find((e) => e.name === 'link-code')).toMatchObject({ kind: 'dir', link: true });
    fs.symlinkSync(path.join(home, 'gone'), path.join(home, 'broken'));
    const l2 = (await browser.lookup('~')) as FsListing;
    expect(l2.entries.find((e) => e.name === 'broken')).toMatchObject({ kind: 'other', link: true });
  });

  it('never lists or opens the private folder, by any path, symlink or hard link', async () => {
    for (const p of ['~/.config/herdr-mobile', '~/.config/herdr-mobile/token', '~/.config/x/../herdr-mobile/env', cfg, `${cfg}/`]) {
      expect(await code(browser.lookup(p)), p).toBe('403 private');
      expect(await code(browser.open(p)), p).toBe('403 private');
    }
    fs.symlinkSync(cfg, path.join(home, 'sneaky'));
    fs.symlinkSync(path.join(cfg, 'token'), path.join(home, 'tok'));
    expect(await code(browser.lookup('~/sneaky'))).toBe('403 private');
    expect(await code(browser.open('~/sneaky/token'))).toBe('403 private');
    expect(await code(browser.open('~/tok'))).toBe('403 private');
    fs.linkSync(path.join(cfg, 'token'), path.join(home, 'hard'));
    expect(await code(browser.open('~/hard'))).toBe('403 private');
    // Not shown in its parent folder either (nor links to it).
    const conf = (await browser.lookup('~/.config', { hidden: true })) as FsListing;
    expect(conf.entries.map((e) => e.name)).not.toContain('herdr-mobile');
    const h = (await browser.lookup('~', { hidden: true })) as FsListing;
    expect(h.entries.map((e) => e.name)).not.toContain('sneaky');
    expect(h.entries.map((e) => e.name)).not.toContain('tok');
    // The diagnostics file and its rollover.
    fs.writeFileSync(path.join(dir, 'diag.jsonl'), '{}');
    fs.writeFileSync(path.join(dir, 'diag.jsonl.1'), '{}');
    expect(await code(browser.open(path.join(dir, 'diag.jsonl')))).toBe('403 private');
    expect(await code(browser.open(path.join(dir, 'diag.jsonl.1')))).toBe('403 private');
  });

  it('opens regular files only: no folders, devices, sockets, pipes, /proc or /sys', async () => {
    const ok = await browser.open('~/code/notes.txt');
    expect(ok.name).toBe('notes.txt');
    expect(ok.stat.size).toBe(11);
    await ok.handle.close();
    expect(await code(browser.open('~/code'))).toBe('400 not-regular');
    expect(await code(browser.open('/dev/null'))).toBe('400 not-regular');
    expect(await code(browser.open('/proc/self/environ'))).toBe('400 not-regular');
    expect(await code(browser.open('/proc/self/status'))).toBe('400 not-regular');
    expect(await code(browser.open('/sys/kernel/hostname'))).not.toBe('ok');
    const fifo = path.join(home, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await code(browser.open(fifo))).toBe('400 not-regular');
    const sockPath = path.join(dir, 's.sock');
    const srv = net.createServer().listen(sockPath);
    await new Promise((r) => srv.once('listening', r));
    try {
      expect(await code(browser.open(sockPath))).toBe('400 not-regular');
    } finally {
      srv.close();
    }
    // /proc is listed (read only), never sent.
    expect(((await browser.lookup('/proc/self')) as FsListing).kind).toBe('dir');
  });

  it('unreadable folders and files: 403 denied', async () => {
    if (process.getuid?.() === 0) return;
    const locked = path.join(home, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(home, 'locked.txt'), 'x');
    fs.chmodSync(locked, 0o000);
    fs.chmodSync(path.join(home, 'locked.txt'), 0o000);
    try {
      expect(await code(browser.lookup('~/locked'))).toBe('403 denied');
      expect(await code(browser.open('~/locked.txt'))).toBe('403 denied');
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

describe('headers', () => {
  it('Content-Disposition: ASCII fallback + RFC 5987 UTF-8 name', () => {
    expect(contentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDisposition('résumé "v2".txt')).toBe(
      `attachment; filename="r_sum_ _v2_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.txt`,
    );
    expect(contentDisposition("a'b(c)*.txt")).toBe(`attachment; filename="a'b(c)*.txt"; filename*=UTF-8''a%27b%28c%29%2A.txt`);
    expect(contentDisposition('日本.txt')).toContain(`filename*=UTF-8''%E6%97%A5%E6%9C%AC.txt`);
  });

  it('Range: one range, suffix, open end; several ranges = whole; past the end = 416', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });

  it('WindowLimiter: max per window per key', () => {
    let now = 0;
    const l = new WindowLimiter(2, 1000, () => now);
    expect(l.allow('a')).toBe(true);
    expect(l.allow('a')).toBe(true);
    expect(l.allow('a')).toBe(false);
    expect(l.allow('b')).toBe(true);
    now = 1001;
    expect(l.allow('a')).toBe(true);
  });
});

/** A raw GET (Node's fetch would rewrite Sec-Fetch-* and Host). */
function get(base: string, p: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const [host, port] = base.split(':');
    const r = http.request({ host, port: Number(port), path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

const q = (p: string) => encodeURIComponent(p);

describe('routes (bridge)', () => {
  let tb: TestBridge | null = null;
  let log = '';
  afterEach(async () => {
    await tb?.stop();
    tb = null;
  });
  const start = async () => {
    const stream = new PassThrough();
    log = '';
    stream.on('data', (c: Buffer) => {
      log += c.toString();
    });
    tb = await startBridge({ home, configDir: cfg, logLevel: 'info', logStream: stream, diagFile: path.join(dir, 'diag.jsonl') });
    return tb;
  };

  it('401 without a session (also a stale cookie), 403 cross-site; works with a session', async () => {
    const { base, cookie } = await start();
    for (const p of [`/api/fs/list?path=${q('~')}`, `/api/fs/download?path=${q('~/code/notes.txt')}`]) {
      expect((await get(base, p)).status, p).toBe(401);
      expect((await get(base, p, { cookie: 'hm_session=nope' })).status, p).toBe(401);
      expect((await get(base, p, { cookie, 'sec-fetch-site': 'cross-site' })).status, p).toBe(403);
      expect((await get(base, p, { cookie, origin: 'http://evil.example' })).status, p).toBe(403);
      expect((await get(base, p, { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' })).status, p).toBe(200);
    }
    // Local tools with the token as a bearer (loopback), like the rest of the API.
    expect((await get(base, `/api/fs/list?path=${q('~')}`, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('list: JSON listing / file facts / errors; the private folder refused even with a session', async () => {
    const { base, cookie } = await start();
    const l = await get(base, `/api/fs/list?path=${q('~')}`, { cookie });
    expect(l.status).toBe(200);
    expect(l.headers['cache-control']).toBe('no-store');
    expect((JSON.parse(l.body.toString()) as FsListing).entries.map((e) => e.name)).toContain('code');
    const f = JSON.parse((await get(base, `/api/fs/list?path=${q('~/code/notes.txt')}`, { cookie })).body.toString()) as FsFile;
    expect(f.kind).toBe('file');
    const nf = await get(base, `/api/fs/list?path=${q('~/nope')}`, { cookie });
    expect(nf.status).toBe(404);
    expect(JSON.parse(nf.body.toString())).toEqual({ error: 'No such file or folder', code: 'not-found' });
    for (const p of [cfg, '~/.config/herdr-mobile', `${cfg}/token`]) {
      expect((await get(base, `/api/fs/list?path=${q(p)}`, { cookie })).status, p).toBe(403);
      const d = await get(base, `/api/fs/download?path=${q(p)}`, { cookie });
      expect(d.status, p).toBe(403);
      expect(d.body.toString()).not.toContain('secret-token');
    }
    expect((await get(base, `/api/fs/list?path=${q('~root')}`, { cookie })).status).toBe(400);
    expect((await get(base, `/api/fs/list?path=${q(`/${'a'.repeat(5000)}`)}`, { cookie })).status).toBe(400);
  });

  it('download: attachment, octet-stream, nosniff, length, bytes; ranges; non-regular refused; logged by path', async () => {
    const { base, cookie } = await start();
    const name = 'résumé v2.bin';
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    fs.writeFileSync(path.join(home, 'code', name), bytes);
    const p = `/api/fs/download?path=${q(`~/code/${name}`)}`;
    const r = await get(base, p, { cookie });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="r_sum_ v2.bin"; filename*=UTF-8''r%C3%A9sum%C3%A9%20v2.bin`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-length']).toBe('256');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toBeDefined();
    expect(r.body.equals(bytes)).toBe(true);
    const part = await get(base, p, { cookie, range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/256');
    expect(part.headers['content-length']).toBe('10');
    expect(part.body.equals(bytes.subarray(10, 20))).toBe(true);
    const stale = await get(base, p, { cookie, range: 'bytes=10-19', 'if-range': 'Mon, 01 Jan 2001 00:00:00 GMT' });
    expect(stale.status).toBe(200);
    expect(stale.body.length).toBe(256);
    const bad = await get(base, p, { cookie, range: 'bytes=999-' });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */256');
    const head = await get(base, p, { cookie }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('256');
    expect(head.body.length).toBe(0);
    fs.writeFileSync(path.join(home, 'empty.txt'), '');
    const empty = await get(base, `/api/fs/download?path=${q('~/empty.txt')}`, { cookie });
    expect(empty.status).toBe(200);
    expect(empty.headers['content-length']).toBe('0');
    for (const x of ['~/code', '/dev/null', '/proc/self/environ']) {
      expect((await get(base, `/api/fs/download?path=${q(x)}`, { cookie })).status, x).toBe(400);
    }
    expect((await get(base, '/api/fs/download', { cookie })).status).toBe(400);
    expect(log).toContain('"msg":"file download"');
    expect(log).toContain(path.join(home, 'code', name));
    expect(log).not.toContain('hello notes');
    expect(log).not.toContain('secret-token');
  });
});

describe('route limits', () => {
  it('listings and downloads per device, and downloads running at once', async () => {
    const app = Fastify();
    registerFileRoutes(app, {
      browser,
      limits: { listsPerMinute: 3, downloadsPer10Min: 50, concurrentPerDevice: 1, concurrentTotal: 2 },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const base = `127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
      for (let i = 0; i < 3; i++) expect((await get(base, '/api/fs/list?path=~')).status).toBe(200);
      const over = await get(base, '/api/fs/list?path=~');
      expect(over.status).toBe(429);
      expect(over.headers['retry-after']).toBe('60');
      // A slow download (the client doesn't read) holds the one slot; a second is refused until it ends.
      fs.writeFileSync(path.join(home, 'big.bin'), Buffer.alloc(32 * 1024 * 1024));
      const [host, port] = base.split(':');
      const slow = http.get({ host, port: Number(port), path: `/api/fs/download?path=${q('~/big.bin')}` });
      const res = await new Promise<http.IncomingMessage>((r) => slow.once('response', r));
      expect(res.statusCode).toBe(200);
      res.pause();
      expect((await get(base, `/api/fs/download?path=${q('~/code/notes.txt')}`)).status).toBe(429);
      slow.destroy();
      let after = 0;
      for (let i = 0; i < 50 && after !== 200; i++) {
        await new Promise((r) => setTimeout(r, 20));
        after = (await get(base, `/api/fs/download?path=${q('~/code/notes.txt')}`)).status;
      }
      expect(after).toBe(200);
    } finally {
      await app.close();
    }
  });
});
