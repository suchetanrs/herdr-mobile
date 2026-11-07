import type { World } from '@herdr-mobile/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthLimiter } from '../auth/limiter.js';
import { type DeviceSession, deviceName, type SessionStore } from '../auth/sessions.js';
import {
  bearer,
  clearCookie,
  hasQueryToken,
  LEGACY_COOKIE,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
  sessionSetCookie,
  stripToken,
  type TokenSource,
} from '../auth/token.js';
import type { Logger } from '../log.js';
import { foreignRequest, type HostCheck } from './guard.js';
import { isLoopback, isNetworkSocket } from './listen.js';
import { SECURITY_HEADERS } from './security.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in device (session cookie); null for public paths and local tools. */
    device: DeviceSession | null;
  }
}

/** Largest body a request without a session may send (the sign-in form is ~100 bytes). */
export const UNAUTHENTICATED_BODY_LIMIT = 1024;

export interface HttpRoutesOptions {
  tokens: TokenSource;
  sessions: SessionStore;
  world: () => World;
  seq: () => number;
  serverId: string;
  /** Failed sign-ins per client address. */
  limiter?: AuthLimiter;
  /** Host names the bridge answers to (DNS rebinding guard). */
  hosts?: HostCheck;
  /** The body of `GET /api/health` for a signed-in caller (others get `{ ok: true }`). */
  health?: () => Record<string, unknown>;
  logger?: Logger;
}

/**
 * Refuses a request and closes its connection once the answer is out, so a client that declared a large body
 * (or keeps the socket for more requests) can't hold it. The short delay lets the answer arrive before the
 * close (closing with unread data would reset the connection and lose it).
 */
export function refuse(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): FastifyReply {
  const sock = req.raw.socket;
  reply.raw.once('finish', () => {
    sock.end();
    setTimeout(() => sock.destroy(), 1000).unref();
  });
  reply
    .code(status)
    .headers({ ...headers, 'cache-control': 'no-store', connection: 'close' })
    .send(body);
  return reply;
}

function declaredBody(req: FastifyRequest): boolean {
  const len = Number(req.headers['content-length'] ?? 0);
  return req.headers['transfer-encoding'] !== undefined || !Number.isFinite(len) || len > UNAUTHENTICATED_BODY_LIMIT;
}

/**
 * Auth for every HTTP request plus the session and data endpoints. The app shell (everything outside /api) is
 * public: it shows the sign-in screen. Under /api: other sites' requests are refused first (403, never
 * counted), then a session cookie lets a device in; the token itself is accepted only by `POST /api/session`
 * (sign-in, rate-limited per address) and, as a bearer header, from loopback tools on this machine.
 */
export function registerHttp(app: FastifyInstance, opts: HttpRoutesOptions): void {
  const { sessions, tokens, limiter } = opts;
  app.decorateRequest('device', null);

  app.addHook('onRequest', async (req, reply) => {
    if (opts.hosts && !opts.hosts.allows(req.headers.host, !isNetworkSocket(req.raw.socket))) {
      return refuse(req, reply, 421, { error: 'unknown host name' });
    }
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) {
      if (declaredBody(req)) return refuse(req, reply, 413, { error: 'request too large' });
      // An old `?token=` link: never accepted (the token goes in the URL fragment now). Take it out of the
      // address bar and history; the page then shows the sign-in screen.
      if ((req.method === 'GET' || req.method === 'HEAD') && hasQueryToken(req.url)) {
        reply.code(302).header('cache-control', 'no-store').header('location', stripToken(req.url)).send();
        return reply;
      }
      return;
    }
    if (foreignRequest(req.headers)) return refuse(req, reply, 403, { error: 'cross-site request refused' });
    const found = sessions.verify(sessionCookie(req.headers), req.ip);
    if (found) {
      req.device = found.session;
      if (found.moved)
        opts.logger?.info({ ip: req.ip, device: found.session.id, name: found.session.name }, 'device seen from a new address');
      return;
    }
    if (declaredBody(req)) return refuse(req, reply, 413, { error: 'request too large' });
    if (req.method === 'GET' && path === '/api/health') return;
    if (req.method === 'POST' && path === '/api/session') return;
    // Local tools (scripts on this machine) may send the token as a bearer header; never over the network.
    const presented = bearer(req.headers);
    if (presented !== null && isLoopback(req.ip)) {
      if (tokens.matches(presented)) return;
      limiter?.fail(req.ip);
    }
    const stale = parseCookies(req.headers.cookie)[SESSION_COOKIE] !== undefined;
    return refuse(req, reply, 401, { error: 'unauthorized' }, stale ? { 'set-cookie': clearCookie(SESSION_COOKIE) } : {});
  });

  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err: err.message }, 'request failed');
    const body = {
      error:
        status === 413
          ? 'request too large'
          : status === 415
            ? 'unsupported media type'
            : status === 500
              ? 'internal error'
              : 'bad request',
    };
    if (!req.device) return refuse(req, reply, status, body);
    return reply.code(status).header('cache-control', 'no-store').send(body);
  });

  app.get('/api/health', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const signedIn = req.device !== null || (isLoopback(req.ip) && tokens.matches(bearer(req.headers)));
    return signedIn && opts.health ? opts.health() : { ok: true };
  });

  // Sign-in: the token, once, for a session cookie. JSON only (no HTML form can send it), small body.
  app.post<{ Body: { token?: unknown; standalone?: unknown } }>(
    '/api/session',
    { bodyLimit: UNAUTHENTICATED_BODY_LIMIT },
    async (req, reply) => {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return refuse(req, reply, 415, { error: 'send JSON' });
      }
      const wait = limiter?.blockedFor(req.ip) ?? 0;
      if (wait > 0) {
        return refuse(req, reply, 429, { error: 'too many failed sign-in attempts' }, { 'retry-after': String(Math.ceil(wait / 1000)) });
      }
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (!tokens.matches(token)) {
        if (limiter?.fail(req.ip)) opts.logger?.warn({ ip: req.ip }, 'too many failed sign-in attempts; blocking this address for a while');
        else opts.logger?.warn({ ip: req.ip }, 'sign-in failed (wrong token)');
        return refuse(req, reply, 401, { error: 'unauthorized' });
      }
      limiter?.succeed(req.ip);
      // Signing in again on a device replaces its old session.
      if (req.device) sessions.revoke(req.device.id);
      const name = deviceName(req.headers['user-agent'], req.body?.standalone === true);
      const { secret, session } = sessions.create({ name, ip: req.ip });
      opts.logger?.info({ ip: req.ip, device: session.id, name, devices: sessions.size }, 'signed in: new device');
      reply
        .code(201)
        .header('cache-control', 'no-store')
        .header('set-cookie', [sessionSetCookie(secret, req.protocol === 'https'), clearCookie(LEGACY_COOKIE)]);
      return { ok: true, serverId: opts.serverId, device: { id: session.id, name: session.name } };
    },
  );

  // "Is this device signed in?" (the app asks after its WebSocket was refused).
  app.get('/api/session', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ok: true, serverId: opts.serverId, device: req.device ? { id: req.device.id, name: req.device.name } : null };
  });

  // Sign this device out.
  app.delete('/api/session', async (req, reply) => {
    if (req.device) {
      sessions.revoke(req.device.id);
      opts.logger?.info({ ip: req.ip, device: req.device.id }, 'device signed out');
    }
    reply.header('cache-control', 'no-store').header('set-cookie', clearCookie(SESSION_COOKIE));
    return { ok: true };
  });

  app.get('/api/sessions', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      current: req.device?.id ?? null,
      devices: sessions.list().map((s) => ({
        id: s.id,
        name: s.name,
        created: new Date(s.created).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(),
        ip: s.ip,
      })),
    };
  });

  // Sign out everywhere (this device included).
  app.delete('/api/sessions', async (req, reply) => {
    const n = sessions.revokeAll();
    opts.logger?.info({ ip: req.ip, revoked: n }, 'signed out everywhere');
    reply.header('cache-control', 'no-store').header('set-cookie', clearCookie(SESSION_COOKIE));
    return { ok: true, revoked: n };
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!sessions.revoke(req.params.id)) {
      reply.code(404);
      return { error: 'no such device' };
    }
    opts.logger?.info({ ip: req.ip, device: req.params.id }, 'device signed out (revoked)');
    if (req.device?.id === req.params.id) reply.header('set-cookie', clearCookie(SESSION_COOKIE));
    return { ok: true };
  });

  app.get('/api/world', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { serverId: opts.serverId, seq: opts.seq(), world: opts.world() };
  });
}

/** Fastify's own early errors (a URL it can't parse): generic body, security headers, connection closed. */
export function frameworkError(_err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  reply.headers(SECURITY_HEADERS);
  refuse(req, reply, 400, { error: 'bad request' });
}
