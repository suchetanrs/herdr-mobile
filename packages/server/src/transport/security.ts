import type { FastifyInstance } from 'fastify';

/**
 * Content Security Policy for the app. Everything is served by the bridge
 * itself; inline styles are allowed because React and xterm.js set `style`
 * attributes. `ws:`/`wss:` because older Safari doesn't match WebSockets
 * against 'self'. No `upgrade-insecure-requests`: the bridge is plain HTTP.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self' ws: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'x-robots-tag': 'noindex, nofollow',
};

const STATUS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  413: 'Payload Too Large',
  421: 'Misdirected Request',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  503: 'Service Unavailable',
};

/**
 * A complete refusal written straight to a socket (WebSocket upgrades, malformed requests): the security
 * headers, a tiny JSON body that names nothing, and `Connection: close`.
 */
export function rawRefusal(status: number, extra: Record<string, string> = {}): string {
  const body = JSON.stringify({ error: (STATUS[status] ?? 'Error').toLowerCase() });
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    connection: 'close',
    ...extra,
  };
  return `HTTP/1.1 ${status} ${STATUS[status] ?? 'Error'}\r\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')}\r\n\r\n${body}`;
}

/** Adds the security headers to every HTTP response (pages, assets, API, errors). */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });
  // Errors raised before or outside the hooks (bad URLs, body parsing) get them here too.
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
}
