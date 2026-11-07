import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { refuse } from './http.js';
import { socketKind } from './listen.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt']);
/** Never cached: they name everything else (index.html) or must update promptly (service worker, manifest). */
const FRESH = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);

interface Cached {
  mtimeMs: number;
  body: Buffer;
  gzip: Buffer | null;
}

/**
 * Serves the built web app (packages/web/dist): files as they are, and
 * index.html for any other GET that isn't an API or WebSocket path (SPA
 * fallback). The app shell is public; everything it shows comes over the
 * session-guarded API/WebSocket. Text files are gzipped once and kept in memory. Source maps are never
 * served, however the path is spelled (the decision is made on the resolved file).
 */
export function registerStatic(app: FastifyInstance, webDir: string): void {
  const root = path.resolve(webDir);
  const cache = new Map<string, Cached>();

  const load = (file: string): Cached | null => {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit;
    const body = fs.readFileSync(file);
    const gzip = COMPRESSIBLE.has(path.extname(file)) && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null;
    const entry = { mtimeMs: st.mtimeMs, body, gzip };
    cache.set(file, entry);
    return entry;
  };

  const send = (req: FastifyRequest, reply: FastifyReply, urlPath: string, file: string, entry: Cached) => {
    const ext = path.extname(file);
    reply.header('content-type', TYPES[ext] ?? 'application/octet-stream');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', cacheControl(urlPath, ext, socketKind(req.raw.socket), req.protocol === 'https'));
    if (urlPath === '/sw.js') reply.header('service-worker-allowed', '/');
    const accepts = String(req.headers['accept-encoding'] ?? '');
    if (entry.gzip && /\bgzip\b/.test(accepts)) {
      reply.header('content-encoding', 'gzip').header('vary', 'accept-encoding');
      return reply.send(entry.gzip);
    }
    return reply.send(entry.body);
  };

  app.setNotFoundHandler((req, reply) => {
    const urlPath = decodeURIComponentSafe((req.url.split('?')[0] ?? '/').split('#')[0] ?? '/');
    const api = urlPath.startsWith('/api/') || urlPath === '/ws';
    if ((req.method !== 'GET' && req.method !== 'HEAD') || api) return refuse(req, reply, 404, { error: 'not found' });
    const index = path.join(root, 'index.html');
    const wanted = path.resolve(root, `.${urlPath}`);
    if (isSourceMap(urlPath) || isSourceMap(wanted))
      return reply.code(404).header('cache-control', 'no-store').send({ error: 'not found' });
    if (wanted.startsWith(root + path.sep) && urlPath !== '/') {
      const entry = load(wanted);
      // `x.js/` resolves to `x.js`: a file is only ever served at its exact name.
      if (entry && urlPath.endsWith('/')) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not found' });
      if (entry) return send(req, reply, urlPath, wanted, entry);
      // A missing asset is a 404, not the app (a stale page asking for an old bundle should fail loudly).
      if (path.extname(urlPath) && !urlPath.endsWith('.html')) return reply.code(404).send({ error: 'not found' });
    }
    const entry = load(index);
    if (!entry) {
      return reply
        .code(503)
        .header('content-type', 'text/plain; charset=utf-8')
        .send(`The web app isn't built (no ${index}). Run: npm run build\n`);
    }
    return send(req, reply, '/index.html', index, entry);
  });
}

function isSourceMap(p: string): boolean {
  return /\.map[/\\.\s]*$/i.test(p) || path.extname(p.replace(/[/\\.\s]+$/, '')).toLowerCase() === '.map';
}

/**
 * Hashed assets are cached for a year only where nobody else can tamper with them in transit: loopback,
 * the Tailscale address (WireGuard) or HTTPS. On a cleartext network (an opted-in LAN address) nothing is
 * cached, so an asset rewritten on the way can't outlive that one page load.
 */
export function cacheControl(urlPath: string, ext: string, kind: 'loopback' | 'tailscale' | 'lan', https: boolean): string {
  if (kind === 'lan' && !https) return 'no-store';
  if (FRESH.has(urlPath) || ext === '.html') return 'no-cache';
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The served web app's build id (`<meta name="herdr-build">` in index.html, written by the web build: git sha +
 * build time), re-read when index.html changes; '' when there's none (not built, dev server).
 */
export function webBuildReader(webDir: string): () => string {
  const index = path.join(path.resolve(webDir), 'index.html');
  let seen = -1;
  let build = '';
  return () => {
    try {
      const st = fs.statSync(index);
      if (st.mtimeMs !== seen) {
        seen = st.mtimeMs;
        const m = /<meta name="herdr-build" content="([^"]{1,80})"/.exec(fs.readFileSync(index, 'utf8'));
        build = m?.[1] ?? '';
      }
    } catch {
      seen = -1;
      build = '';
    }
    return build;
  };
}
