import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FS_MARKDOWN_MAX, VIEWABLE, viewableOf } from '@herdr-mobile/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkViewable, viewCsp } from '../src/files/view.js';
import { startBridge, type TestBridge } from './helpers/bridge.js';
import { rmDir, tmpDir } from './helpers/tmp.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const box = (type: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`${type}isom`)]);
const riff = (form: string) => Buffer.from(`RIFF\x24\x00\x00\x00${form}fmt `, 'latin1');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('allowlist + sniffing', () => {
  it('by extension: media, images, pdf, md; never svg/html/js; case-insensitive; no prototype keys', () => {
    expect(viewableOf('a.MP4')?.kind).toBe('video');
    expect(viewableOf('a.mov')?.type).toBe('video/quicktime');
    expect(viewableOf('song.opus')?.kind).toBe('audio');
    expect(viewableOf('x.heic')?.kind).toBe('image');
    expect(viewableOf('doc.pdf')?.type).toBe('application/pdf');
    expect(viewableOf('README.markdown')?.type).toBe('text/plain; charset=utf-8');
    for (const n of [
      'a.svg',
      'a.html',
      'a.htm',
      'a.js',
      'a.xhtml',
      'a.xml',
      'a.txt',
      'Makefile',
      '.png',
      'a.',
      'a.constructor',
      'a.__proto__',
    ]) {
      expect(viewableOf(n), n).toBeNull();
    }
    expect(Object.keys(VIEWABLE)).not.toContain('svg');
  });

  it('the first bytes must match the extension', () => {
    const ok = (name: string, head: Buffer) => checkViewable(name, 100, head).ok;
    expect(ok('a.png', PNG)).toBe(true);
    expect(ok('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(ok('a.gif', Buffer.from('GIF89a'))).toBe(true);
    expect(ok('a.webp', riff('WEBP'))).toBe(true);
    expect(ok('a.wav', riff('WAVE'))).toBe(true);
    expect(ok('a.webp', riff('WAVE'))).toBe(false);
    expect(ok('a.mp4', box('ftyp'))).toBe(true);
    expect(ok('a.mov', box('moov'))).toBe(true);
    expect(ok('a.mp4', box('moov'))).toBe(false);
    expect(ok('a.heic', box('ftyp'))).toBe(true);
    expect(ok('a.mp3', Buffer.from('ID3\x04'))).toBe(true);
    expect(ok('a.mp3', Buffer.from([0xff, 0xfb, 0x90]))).toBe(true);
    expect(ok('a.flac', Buffer.from('fLaC'))).toBe(true);
    expect(ok('a.ogg', Buffer.from('OggS'))).toBe(true);
    expect(ok('a.bmp', Buffer.from('BM6'))).toBe(true);
    expect(ok('a.pdf', Buffer.from('%PDF-1.4\n'))).toBe(true);
    expect(ok('a.md', Buffer.from('# hi'))).toBe(true);
    // Pages and SVG renamed to something viewable are refused.
    for (const n of ['a.png', 'a.jpg', 'a.mp4', 'a.mov', 'a.pdf', 'a.mp3', 'a.gif', 'a.webp', 'a.bmp']) {
      expect(ok(n, HTML), n).toBe(false);
      expect(ok(n, SVG), n).toBe(false);
    }
    expect(ok('a.png', Buffer.alloc(0))).toBe(false);
    expect(checkViewable('a.svg', 10, SVG)).toMatchObject({ ok: false, status: 415, code: 'not-viewable' });
    expect(checkViewable('a.html', 10, HTML)).toMatchObject({ ok: false, status: 415 });
  });

  it('Markdown is capped', () => {
    expect(checkViewable('a.md', FS_MARKDOWN_MAX, Buffer.from('#')).ok).toBe(true);
    expect(checkViewable('a.md', FS_MARKDOWN_MAX + 1, Buffer.from('#'))).toMatchObject({ ok: false, status: 413, code: 'too-big' });
  });

  it('CSP: sandboxed, nothing loads; PDF unsandboxed (viewer) but framable only by the app', () => {
    for (const k of ['video', 'audio', 'image', 'markdown'] as const) {
      expect(viewCsp(k)).toMatch(/^sandbox; default-src 'none'/);
      expect(viewCsp(k)).toContain("frame-ancestors 'none'");
      expect(viewCsp(k)).not.toContain('script-src');
    }
    expect(viewCsp('pdf')).toMatch(/^default-src 'none'/);
    expect(viewCsp('pdf')).toContain("frame-ancestors 'self'");
  });
});

function get(base: string, p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const [host, port] = base.split(':');
    const r = http.request({ host, port: Number(port), path: p, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
const view = (p: string) => `/api/fs/view?path=${encodeURIComponent(p)}`;

describe('GET /api/fs/view', () => {
  let dir = '';
  let home = '';
  let cfg = '';
  let tb: TestBridge | null = null;
  let log = '';
  beforeEach(async () => {
    dir = fs.realpathSync(tmpDir('view'));
    home = path.join(dir, 'home');
    cfg = path.join(home, '.config', 'herdr-mobile');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'token'), 'secret-token');
    fs.writeFileSync(path.join(cfg, 'pic.png'), PNG);
    fs.writeFileSync(path.join(home, 'pic.png'), Buffer.concat([PNG, Buffer.alloc(84, 7)]));
    fs.writeFileSync(path.join(home, 'clip ö.mp4'), Buffer.concat([box('ftyp'), Buffer.alloc(1000, 1)]));
    fs.writeFileSync(path.join(home, 'page.png'), HTML);
    fs.writeFileSync(path.join(home, 'logo.svg'), SVG);
    fs.writeFileSync(path.join(home, 'page.html'), HTML);
    fs.writeFileSync(path.join(home, 'doc.pdf'), '%PDF-1.4\n%%EOF\n');
    fs.writeFileSync(path.join(home, 'notes.md'), '# Hi\n<script>alert(1)</script>\n');
    fs.writeFileSync(path.join(home, 'big.md'), Buffer.alloc(FS_MARKDOWN_MAX + 1, 0x61));
    const stream = new PassThrough();
    log = '';
    stream.on('data', (c: Buffer) => {
      log += c.toString();
    });
    tb = await startBridge({ home, configDir: cfg, logLevel: 'info', logStream: stream, diagFile: path.join(dir, 'diag.jsonl') });
  });
  afterEach(async () => {
    await tb?.stop();
    tb = null;
    rmDir(dir);
  });

  it('401 without a session, 403 cross-site, private folder refused', async () => {
    const { base, cookie } = tb as TestBridge;
    expect((await get(base, view('~/pic.png'))).status).toBe(401);
    expect((await get(base, view('~/pic.png'), { cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await get(base, view('~/pic.png'), { cookie, origin: 'http://evil.example' })).status).toBe(403);
    for (const p of [`${cfg}/pic.png`, '~/.config/herdr-mobile/token', '~/.config/herdr-mobile/../herdr-mobile/pic.png']) {
      const r = await get(base, view(p), { cookie });
      expect(r.status, p).toBe(403);
      expect(r.body.toString()).not.toContain('secret-token');
    }
    expect((await get(base, view('/proc/self/environ'), { cookie })).status).toBe(400);
    expect((await get(base, view('~'), { cookie })).status).toBe(400);
  });

  it('inline with the type, RFC 5987 name, nosniff, sandbox CSP, no-store; logged', async () => {
    const { base, cookie } = tb as TestBridge;
    const r = await get(base, view('~/pic.png'), { cookie });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toBe(`inline; filename="pic.png"; filename*=UTF-8''pic.png`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-length']).toBe('100');
    const v = await get(base, view('~/clip ö.mp4'), { cookie });
    expect(v.headers['content-type']).toBe('video/mp4');
    expect(v.headers['content-disposition']).toBe(`inline; filename="clip _.mp4"; filename*=UTF-8''clip%20%C3%B6.mp4`);
    const md = await get(base, view('~/notes.md'), { cookie });
    expect(md.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(md.body.toString()).toContain('<script>');
    const pdf = await get(base, view('~/doc.pdf'), { cookie });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(pdf.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(log).toContain('"msg":"file view"');
    expect(log).toContain(path.join(home, 'pic.png'));
  });

  it('Range: 206 with Content-Range/Length, 416 past the end', async () => {
    const { base, cookie } = tb as TestBridge;
    const all = fs.readFileSync(path.join(home, 'clip ö.mp4'));
    const r = await get(base, view('~/clip ö.mp4'), { cookie, range: 'bytes=0-1' });
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 0-1/${all.length}`);
    expect(r.headers['content-length']).toBe('2');
    expect(r.headers['accept-ranges']).toBe('bytes');
    const mid = await get(base, view('~/clip ö.mp4'), { cookie, range: 'bytes=500-' });
    expect(mid.status).toBe(206);
    expect(mid.body.equals(all.subarray(500))).toBe(true);
    const bad = await get(base, view('~/clip ö.mp4'), { cookie, range: `bytes=${all.length}-` });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${all.length}`);
  });

  it('415 for svg, html and pages renamed to .png; 413 for big Markdown; download still works for them', async () => {
    const { base, cookie } = tb as TestBridge;
    for (const p of ['~/logo.svg', '~/page.html', '~/page.png']) {
      const r = await get(base, view(p), { cookie });
      expect(r.status, p).toBe(415);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      expect(JSON.parse(r.body.toString())).toMatchObject({ code: 'not-viewable' });
      expect(r.body.toString()).not.toContain('<script');
      const d = await get(base, `/api/fs/download?path=${encodeURIComponent(p)}`, { cookie });
      expect(d.headers['content-disposition']).toMatch(/^attachment;/);
      expect(d.headers['content-type']).toBe('application/octet-stream');
    }
    const big = await get(base, view('~/big.md'), { cookie });
    expect(big.status).toBe(413);
    expect(JSON.parse(big.body.toString())).toMatchObject({ code: 'too-big' });
  });
});
