import { CLAUDE_SETTING_KINDS, type ClaudeSettingError, type ClaudeSettingKind } from '@herdr-mobile/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type ClaudeSettings, ClaudeSettingsError } from '../claude/settings.js';
import { TerminalInputError } from '../terminal/hub.js';
import { WindowLimiter } from './files.js';

/** Local terminal addresses (`t1m3`); agents on other machines are refused. */
const TERMINAL_ID = /^[a-z0-9]{1,32}$/;
/** Menu openings per device per minute (each one types into the agent's terminal). */
const PER_MINUTE = 20;

/**
 * A Claude Code agent's model and effort (behind the session and the cross-site guard of transport/http.ts):
 * `GET /api/agents/:id/claude/:kind` lists the options and the one in use, `POST` with `{value}` switches.
 */
export function registerClaudeRoutes(app: FastifyInstance, opts: { settings: ClaudeSettings }): void {
  const limiter = new WindowLimiter(PER_MINUTE, 60_000);
  const keyOf = (req: FastifyRequest) => req.device?.id ?? 'local';

  const target = (req: FastifyRequest<{ Params: { id: string; kind: string } }>, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const { id, kind } = req.params;
    if (!TERMINAL_ID.test(id) || !CLAUDE_SETTING_KINDS.includes(kind as ClaudeSettingKind)) {
      reply.code(404);
      return null;
    }
    if (!limiter.allow(keyOf(req))) {
      reply.code(429);
      return null;
    }
    return { id, kind: kind as ClaudeSettingKind };
  };
  const failed = (e: unknown, req: FastifyRequest, reply: FastifyReply): ClaudeSettingError => {
    if (e instanceof ClaudeSettingsError) {
      reply.code(e.status);
      return { error: e.message };
    }
    if (e instanceof TerminalInputError) {
      reply.code(e.code === 'not_found' ? 404 : 503);
      return { error: e.message };
    }
    req.log.error({ err: (e as Error).message }, 'claude settings failed');
    reply.code(500);
    return { error: 'Something went wrong talking to Claude' };
  };
  const refused = (reply: FastifyReply): ClaudeSettingError => ({
    error: reply.statusCode === 429 ? 'Too many changes; slow down' : 'Not found',
  });

  app.get<{ Params: { id: string; kind: string } }>('/api/agents/:id/claude/:kind', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return refused(reply);
    try {
      return await opts.settings.read(t.id, t.kind);
    } catch (e) {
      return failed(e, req, reply);
    }
  });

  app.post<{ Params: { id: string; kind: string }; Body: unknown }>(
    '/api/agents/:id/claude/:kind',
    { bodyLimit: 1024 },
    async (req, reply) => {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        reply.code(415);
        return { error: 'Send JSON' } satisfies ClaudeSettingError;
      }
      const t = target(req, reply);
      if (!t) return refused(reply);
      const body = req.body as { value?: unknown } | null;
      try {
        return await opts.settings.choose(t.id, t.kind, body && typeof body === 'object' ? body.value : undefined);
      } catch (e) {
        return failed(e, req, reply);
      }
    },
  );
}
