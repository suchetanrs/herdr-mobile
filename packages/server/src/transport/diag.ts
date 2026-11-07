import type { FastifyInstance } from 'fastify';
import { DIAG_BODY_LIMIT, type DiagLimiter, type DiagLog, sanitize } from '../diag/log.js';
import type { Logger } from '../log.js';

/**
 * `POST /api/diag`: a signed-in device's diagnostics report (web lib/diag.ts: its recent navigation, connection,
 * error and UI events), appended to the diagnostics file. Session only (the auth hook of
 * transport/http.ts already refused anything else; local bearer tools are refused here too), JSON only,
 * DIAG_BODY_LIMIT bytes, rate-limited per device, sanitized again before it's written.
 */
export function registerDiagRoutes(
  app: FastifyInstance,
  opts: { log: DiagLog; limiter: DiagLimiter; build: () => string; logger?: Logger },
): void {
  app.post<{ Body: unknown }>('/api/diag', { bodyLimit: DIAG_BODY_LIMIT }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!req.device) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reply.code(415);
      return { error: 'send JSON' };
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400);
      return { error: 'bad request' };
    }
    if (!opts.limiter.allow(req.device.id)) {
      reply.code(429).header('retry-after', '60');
      return { error: 'too many reports' };
    }
    try {
      opts.log.append({
        at: new Date().toISOString(),
        device: req.device.id,
        name: req.device.name,
        bridgeBuild: opts.build(),
        report: sanitize(body),
      });
    } catch (e) {
      opts.logger?.warn({ err: (e as Error).message }, 'could not write the diagnostics file');
      reply.code(500);
      return { error: 'internal error' };
    }
    opts.logger?.info({ device: req.device.id, file: opts.log.file }, 'diagnostics report saved');
    return { ok: true };
  });
}
