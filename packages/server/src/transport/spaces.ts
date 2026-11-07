import type { FolderCompletion, NewSpaceError } from '@herdr-mobile/protocol';
import { FOLDER_MAX } from '@herdr-mobile/protocol';
import type { FastifyInstance } from 'fastify';
import { CreateError, type SpaceCreator } from '../spaces/create.js';
import { complete } from '../spaces/folders.js';
import type { TabCreator } from '../spaces/tabs.js';

/** Folder completions per `windowMs` (each reads one folder), across all clients. */
const COMPLETIONS_PER_WINDOW = 120;
/** Session listings per `windowMs` (each reads a project folder), across all clients. */
const LISTINGS_PER_WINDOW = 30;
/** herdr-app's space ids (model.rs `fresh_id`); only local spaces get new tabs. */
const SPACE_ID = /^sp[0-9a-f]{32}$/;
const WINDOW_MS = 60_000;

/**
 * New spaces over REST (behind the token and the cross-site guard of transport/http.ts):
 * `GET /api/new-space` (folders, agents), `GET /api/folders?path=` (completion in the home
 * folder), `POST /api/spaces` (make one). New tabs in an open space: `GET /api/spaces/:id/sessions`
 * (its folder, Claude sessions to resume), `POST /api/spaces/:id/tabs` (open one).
 */
export function registerSpaceRoutes(app: FastifyInstance, opts: { creator: SpaceCreator; tabs: TabCreator; home: string }): void {
  const asked: number[] = [];
  const listed: number[] = [];

  const failed = (e: unknown, reply: { code: (n: number) => unknown }, what: string, log: { error: (o: object, m: string) => void }) => {
    if (e instanceof CreateError) {
      reply.code(e.status);
      return { error: e.message, ...(e.field ? { field: e.field } : {}) } satisfies NewSpaceError;
    }
    log.error({ err: (e as Error).message }, `${what} failed`);
    reply.code(500);
    return { error: `Something went wrong ${what}` } satisfies NewSpaceError;
  };

  app.get<{ Params: { id: string } }>('/api/spaces/:id/sessions', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!SPACE_ID.test(req.params.id)) {
      reply.code(404);
      return { error: 'No such space' } satisfies NewSpaceError;
    }
    const now = Date.now();
    while (listed.length && now - (listed[0] as number) > WINDOW_MS) listed.shift();
    if (listed.length >= LISTINGS_PER_WINDOW) {
      reply.code(429);
      return { error: 'Too many lookups; slow down' } satisfies NewSpaceError;
    }
    listed.push(now);
    try {
      return await opts.tabs.sessions(req.params.id);
    } catch (e) {
      return failed(e, reply, 'listing sessions', req.log);
    }
  });

  app.post<{ Params: { id: string } }>('/api/spaces/:id/tabs', { bodyLimit: 4096 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reply.code(415);
      return { error: 'Send JSON' } satisfies NewSpaceError;
    }
    if (!SPACE_ID.test(req.params.id)) {
      reply.code(404);
      return { error: 'No such space' } satisfies NewSpaceError;
    }
    try {
      return await opts.tabs.create(req.params.id, req.body);
    } catch (e) {
      return failed(e, reply, 'opening the tab', req.log);
    }
  });

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
