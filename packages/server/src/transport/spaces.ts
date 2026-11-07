import type { FolderCompletion, NewSpaceError } from '@herdr-mobile/protocol';
import { FOLDER_MAX } from '@herdr-mobile/protocol';
import type { FastifyInstance } from 'fastify';
import { CreateError, type SpaceCreator } from '../spaces/create.js';
import { complete } from '../spaces/folders.js';

/** Folder completions per `windowMs` (each reads one folder), across all clients. */
const COMPLETIONS_PER_WINDOW = 120;
const WINDOW_MS = 60_000;

/**
 * New spaces over REST (behind the token and the cross-site guard of transport/http.ts):
 * `GET /api/new-space` (folders, agents), `GET /api/folders?path=` (completion in the home
 * folder), `POST /api/spaces` (make one).
 */
export function registerSpaceRoutes(app: FastifyInstance, opts: { creator: SpaceCreator; home: string }): void {
  const asked: number[] = [];

  app.get('/api/new-space', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return opts.creator.options();
  });

  app.get<{ Querystring: { path?: string } }>('/api/folders', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const now = Date.now();
    while (asked.length && now - (asked[0] as number) > WINDOW_MS) asked.shift();
    if (asked.length >= COMPLETIONS_PER_WINDOW) {
      reply.code(429);
      return { error: 'Too many lookups; slow down' } satisfies NewSpaceError;
    }
    asked.push(now);
    const typed = typeof req.query.path === 'string' ? req.query.path : '';
    if (typed.length > FOLDER_MAX) return { entries: [] } satisfies FolderCompletion;
    return { entries: complete(typed, opts.home) } satisfies FolderCompletion;
  });

  app.post('/api/spaces', { bodyLimit: 4096 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reply.code(415);
      return { error: 'Send JSON' } satisfies NewSpaceError;
    }
    try {
      return await opts.creator.create(req.body);
    } catch (e) {
      if (e instanceof CreateError) {
        reply.code(e.status);
        return { error: e.message, ...(e.field ? { field: e.field } : {}) } satisfies NewSpaceError;
      }
      req.log.error({ err: (e as Error).message }, 'new space failed');
      reply.code(500);
      return { error: 'Something went wrong making the space' } satisfies NewSpaceError;
    }
  });
}
