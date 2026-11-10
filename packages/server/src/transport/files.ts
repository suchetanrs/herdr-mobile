import { FS_PATH_MAX, type FsError } from '@herdr-mobile/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { contentDisposition, type FileBrowser, FsFailure, parseRange } from '../files/browse.js';
import { checkViewable, SNIFF_BYTES, type ViewCheck, viewCsp } from '../files/view.js';
import type { Logger } from '../log.js';

/** Sliding-window counts per key (a device, or `local` for tools on this machine). */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 1000) for (const k of this.hits.keys()) if (k !== key) this.hits.delete(k);
    return true;
  }
}

export interface FileRouteLimits {
  /** Listings per device per minute. */
  listsPerMinute: number;
  /** Downloads started per device per 10 minutes. */
  downloadsPer10Min: number;
  /** Viewer requests (each range a player asks for) per device per 10 minutes. */
  viewsPer10Min: number;
  /** Downloads running at once, per device. */
  concurrentPerDevice: number;
  /** Downloads running at once, all devices. */
  concurrentTotal: number;
}

export const FILE_ROUTE_LIMITS: FileRouteLimits = {
  listsPerMinute: 240,
  downloadsPer10Min: 120,
  viewsPer10Min: 1200,
  concurrentPerDevice: 4,
  concurrentTotal: 8,
};

const keyOf = (req: FastifyRequest) => req.device?.id ?? 'local';

/**
 * The file browser over REST, read only, behind the session and cross-site guard of transport/http.ts:
 * `GET /api/fs/list?path=&hidden=1&offset=` (a folder page, or a typed file's facts) and
 * `GET /api/fs/download?path=` (a regular file as an attachment, one byte range if asked) and
 * `GET /api/fs/view?path=` (the same, inline, only for files/view.ts's allowlist, sandboxed). Every download
 * and view is logged with its path (never its content).
 */
export function registerFileRoutes(
  app: FastifyInstance,
  opts: { browser: FileBrowser; logger?: Logger; limits?: Partial<FileRouteLimits> },
): void {
  const limits = { ...FILE_ROUTE_LIMITS, ...opts.limits };
  const lists = new WindowLimiter(limits.listsPerMinute, 60_000);
  const downloads = new WindowLimiter(limits.downloadsPer10Min, 600_000);
  const views = new WindowLimiter(limits.viewsPer10Min, 600_000);
  const running = new Map<string, number>();
  let runningTotal = 0;

  const fail = (reply: FastifyReply, status: number, code: FsError['code'], error: string) => {
    reply.code(status).header('cache-control', 'no-store');
    return { error, code } satisfies FsError;
  };
  const failed = (reply: FastifyReply, e: unknown, req: FastifyRequest) => {
    if (e instanceof FsFailure) return fail(reply, e.status, e.code, e.message);
    req.log.error({ err: (e as Error).message }, 'file browser failed');
    return fail(reply, 500, 'not-found', 'Something went wrong reading that');
  };
  const typedPath = (q: unknown): string | null => (typeof q === 'string' && q.length <= FS_PATH_MAX * 3 ? q : null);

  app.get<{ Querystring: { path?: unknown; hidden?: unknown; offset?: unknown } }>('/api/fs/list', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!lists.allow(keyOf(req))) {
      reply.header('retry-after', '60');
      return fail(reply, 429, 'busy', 'Too many lookups; slow down');
    }
    const typed = req.query.path === undefined ? '' : typedPath(req.query.path);
    if (typed === null) return fail(reply, 400, 'bad-path', 'That path is too long');
    const offset = Number(req.query.offset ?? 0);
    try {
      return await opts.browser.lookup(typed, {
        hidden: req.query.hidden === '1' || req.query.hidden === 'true',
        offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
      });
    } catch (e) {
      return failed(reply, e, req);
    }
  });

  /** Sends a file whole or one byte range: as an attachment, or (view) inline if it passes checkViewable. */
  const send = async (req: FastifyRequest<{ Querystring: { path?: unknown } }>, reply: FastifyReply, view: boolean) => {
    reply.header('cache-control', 'no-store');
    const key = keyOf(req);
    const typed = typedPath(req.query.path);
    if (!typed) return fail(reply, 400, 'bad-path', 'Which file?');
    if ((running.get(key) ?? 0) >= limits.concurrentPerDevice || runningTotal >= limits.concurrentTotal) {
      reply.header('retry-after', '5');
      return fail(reply, 429, 'busy', 'Too many downloads at once; wait for one to finish');
    }
    if (!(view ? views : downloads).allow(key)) {
      reply.header('retry-after', '60');
      return fail(reply, 429, 'busy', 'Too many downloads; wait a few minutes');
    }
    let file: Awaited<ReturnType<FileBrowser['open']>>;
    try {
      file = await opts.browser.open(typed);
    } catch (e) {
      return failed(reply, e, req);
    }
    const { handle, stat } = file;
    const size = stat.size;
    let type = 'application/octet-stream';
    if (view) {
      let check: ViewCheck;
      try {
        const head = Buffer.alloc(SNIFF_BYTES);
        const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
        check = checkViewable(file.name, size, head.subarray(0, bytesRead));
      } catch (e) {
        await handle.close().catch(() => {});
        return failed(reply, e, req);
      }
      if (!check.ok) {
        await handle.close().catch(() => {});
        return fail(reply, check.status, check.code, check.error);
      }
      type = check.type;
      reply.headers({ 'content-security-policy': viewCsp(check.kind), 'x-frame-options': check.kind === 'pdf' ? 'SAMEORIGIN' : 'DENY' });
    }
    const lastModified = stat.mtime.toUTCString();
    const ifRange = req.headers['if-range'];
    const range = ifRange && ifRange !== lastModified ? null : parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      await handle.close().catch(() => {});
      reply.header('content-range', `bytes */${size}`);
      return fail(reply, 416, 'bad-path', 'That part of the file doesn’t exist');
    }
    reply.headers({
      'content-type': type,
      'content-disposition': contentDisposition(file.name, view ? 'inline' : 'attachment'),
      'accept-ranges': 'bytes',
      'last-modified': lastModified,
      'x-content-type-options': 'nosniff',
    });
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    opts.logger?.info(
      { device: req.device?.id ?? null, path: file.path, size, ...(range ? { range: `${start}-${end}` } : {}) },
      view ? 'file view' : 'file download',
    );
    running.set(key, (running.get(key) ?? 0) + 1);
    runningTotal++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      running.set(key, Math.max(0, (running.get(key) ?? 1) - 1));
      if (running.get(key) === 0) running.delete(key);
      runningTotal--;
      handle.close().catch(() => {});
    };
    reply.raw.once('close', finish);
    if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
    reply.header('content-length', String(size === 0 ? 0 : end - start + 1));
    if (size === 0) {
      finish();
      return reply.send('');
    }
    // The handle stays ours (autoClose off): `finish` closes it once the response is over, however it ends.
    const stream = handle.createReadStream({ start, end, autoClose: false });
    stream.once('error', finish);
    return reply.send(stream);
  };

  app.get<{ Querystring: { path?: unknown } }>('/api/fs/download', (req, reply) => send(req, reply, false));
  // A player asks for many ranges while seeking, hence its own (larger) budget.
  app.get<{ Querystring: { path?: unknown } }>('/api/fs/view', (req, reply) => send(req, reply, true));
}
