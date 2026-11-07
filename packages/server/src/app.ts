import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ClaudeAccounts } from './accounts/accounts.js';
import { AttentionEngine } from './attention/engine.js';
import { AuthLimiter } from './auth/limiter.js';
import { SessionStore } from './auth/sessions.js';
import { stripToken, TokenSource } from './auth/token.js';
import { type Config, DEFAULT_LIMITS } from './config.js';
import { CoreClient } from './core/client.js';
import { DiagLimiter, DiagLog } from './diag/log.js';
import { Health } from './health.js';
import type { Logger } from './log.js';
import { InPageSink } from './notify/inpage.js';
import { NotifierHub } from './notify/notifier.js';
import { NtfySink } from './notify/ntfy.js';
import { SeenSync } from './seen/sync.js';
import { InstalledAgents, userShell } from './spaces/agents.js';
import { HerdrApp } from './spaces/app.js';
import { SpaceCreator } from './spaces/create.js';
import { ClaudeSessions } from './spaces/sessions.js';
import { TabCreator } from './spaces/tabs.js';
import { TerminalHub } from './terminal/hub.js';
import { ConversationHub } from './transcripts/hub.js';
import { TranscriptLocator } from './transcripts/locate.js';
import { ConversationSession } from './transport/conversation.js';
import { registerDiagRoutes } from './transport/diag.js';
import { HostCheck } from './transport/guard.js';
import { frameworkError, registerHttp } from './transport/http.js';
import { ConnectionGate, isLoopback, NetworkListeners, peerMatcher } from './transport/listen.js';
import { StreamLog } from './transport/log.js';
import { rawRefusal, registerSecurityHeaders } from './transport/security.js';
import { registerSpaceRoutes } from './transport/spaces.js';
import { registerStatic, webBuildReader } from './transport/static.js';
import { TerminalSession } from './transport/terminal.js';
import { WsTransport } from './transport/ws.js';
import { AgentTimes } from './world/agentTimes.js';
import { SpaceColors } from './world/colors.js';
import { wordOf } from './world/status.js';
import { WorldStore } from './world/store.js';

export interface Bridge {
  http: FastifyInstance;
  store: WorldStore;
  ws: WsTransport;
  engine: AttentionEngine;
  hub: TerminalHub;
  conversations: ConversationHub;
  seen: SeenSync | null;
  sessions: SessionStore;
  /** Network listeners (non-loopback); their addresses once started. */
  listeners: NetworkListeners;
  /** Starts the core sync and listens; resolves with the listening URL. */
  start(): Promise<string>;
  stop(): Promise<void>;
}

/** Wires the modules together: core -> world -> (patches, attention -> notifiers) -> transport. */
export function createBridge(config: Config): Bridge {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const http = Fastify({
    // Behind `tailscale serve` (loopback): req.ip / req.protocol come from X-Forwarded-*.
    trustProxy: config.trustProxy ? 'loopback' : false,
    // One line per request (every asset, every API poll) floods journald: only at debug.
    disableRequestLogging: !['debug', 'trace'].includes(config.logLevel),
    logger: {
      level: config.logLevel,
      serializers: {
        req: (req) => ({ method: req.method, url: stripToken(req.url) }),
      },
      ...(config.logStream ? { stream: config.logStream } : {}),
    },
    // Slow or silent clients can't hold connections: headers within 10 s, the whole request within 15 s.
    connectionTimeout: 0,
    requestTimeout: limits.requestTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    maxRequestsPerSocket: 1000,
    bodyLimit: 64 * 1024,
    http: { headersTimeout: limits.headersTimeoutMs, connectionsCheckingInterval: limits.checkIntervalMs, maxHeaderSize: 16 * 1024 },
    frameworkErrors: frameworkError,
    // Malformed requests and timeouts: a minimal answer with the security headers, then the socket is gone.
    clientErrorHandler: (err, socket) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || socket.destroyed) return;
      const code = (err as NodeJS.ErrnoException).code;
      const status = code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
      if (socket.writable) socket.end(rawRefusal(status));
      setTimeout(() => socket.destroy(), 1000).unref();
    },
  });
  http.server.maxConnections = limits.maxConnections;
  // Node's headers timeout starts at a request's first byte: a connection that never sends one is closed here.
  http.server.on('connection', (sock: Socket) => {
    const timer = setTimeout(() => sock.destroy(), limits.headersTimeoutMs);
    timer.unref();
    sock.once('data', () => clearTimeout(timer));
    sock.once('close', () => clearTimeout(timer));
  });
  const logger = http.log as unknown as Logger;
  if (config.legacyHost) {
    logger.warn(
      { HERDR_MOBILE_HOST: config.legacyHost },
      'HERDR_MOBILE_HOST is no longer used for network access (loopback + Tailscale by default); set HERDR_MOBILE_BIND to add addresses',
    );
  }
  const tokens = new TokenSource(config.configDir, config.token);
  const sessions = new SessionStore({
    dir: config.configDir,
    logger,
    ...(config.sessionIdleMs !== undefined ? { idleMs: config.sessionIdleMs } : {}),
  });
  const gate = new ConnectionGate({
    maxTotal: limits.maxConnections,
    maxPerPeer: limits.maxConnectionsPerPeer,
    allowPeer: peerMatcher(config.allowPeers ?? []),
    logger,
  });
  const limiter =
    config.authMaxFailures === 0
      ? undefined
      : new AuthLimiter({
          ...(config.authMaxFailures !== undefined ? { maxFailures: config.authMaxFailures } : {}),
          ...(config.authBlockMs !== undefined ? { blockMs: config.authBlockMs } : {}),
        });

  const hosts = new HostCheck(config.allowedHosts ?? []);
  const listeners = new NetworkListeners({
    target: http.server,
    gate,
    logger,
    ...(config.bindPollMs !== undefined ? { pollMs: config.bindPollMs } : {}),
    ...(config.ifaces ? { ifaces: config.ifaces } : {}),
  });

  const client = new CoreClient({ socketPath: config.socketPath, logger });
  const transcripts = new TranscriptLocator({
    home: config.home,
    ...(config.transcriptRoots ? { extraRoots: config.transcriptRoots } : {}),
    ...(config.transcriptOverrides ? { overrides: config.transcriptOverrides } : {}),
  });
  let colors: SpaceColors | null = null;
  let times: AgentTimes | null = null;
  let accounts: ClaudeAccounts | null = null;
  const store = new WorldStore({
    client,
    logger,
    home: config.home,
    includeUnplaced: config.includeUnplaced,
    ...(config.machinePollMs !== undefined ? { machinePollMs: config.machinePollMs } : {}),
    ...(config.lookingTtlMs !== undefined ? { lookingTtlMs: config.lookingTtlMs } : {}),
    spaceColor: (id) => colors?.get(id) ?? null,
    statusSince: (id, status) => times?.since(id, status) ?? null,
    transcriptOf: (t) => transcripts.locate(t)?.source.path ?? null,
    ...(config.claudeAccounts ? { accountOf: (id: string) => accounts?.get(id) ?? null } : {}),
  });
  colors = new SpaceColors(config.herdrAppDir, () => store.refresh(), logger);
  times = new AgentTimes(config.herdrAppDir, () => store.refresh(), logger);
  if (config.claudeAccounts) {
    const scanner = new ClaudeAccounts({
      procRoot: config.procRoot ?? '/proc',
      home: config.home,
      coreSocket: config.socketPath,
      onChange: () => store.refresh(),
      logger,
    });
    accounts = scanner;
    // A terminal appearing, exiting or starting/leaving `claude` changes who runs where.
    let shape = '';
    store.on('patch', (_ops, world) => {
      const next = Object.values(world.terminals)
        .filter((t) => t.machine === null)
        .map((t) => `${t.id}:${t.program ?? ''}`)
        .sort()
        .join(',');
      if (next === shape) return;
      shape = next;
      scanner.poke();
    });
  }
  const log = new StreamLog();

  const notifier = new NotifierHub(logger);
  const engine = new AttentionEngine({
    notifier,
    logger,
    doneGraceMs: config.doneGraceMs,
    isSettled: (id) => {
      const t = store.world.terminals[id];
      return !t || (t.seenTurn !== null && t.seenTurn >= t.turn) || t.status !== 'done';
    },
  });

  const hub = new TerminalHub({
    client,
    logger,
    graceMs: config.streamGraceMs,
    customSubmit: (id) => {
      const submit = (store.terminal(id) as { submit?: string | null } | undefined)?.submit;
      return Boolean(submit && submit.toLowerCase() !== 'enter');
    },
    facts: (id) => {
      const t = store.terminal(id);
      return t ? { word: wordOf(t), turn: t.turn ?? 0, cols: t.cols ?? 0, rows: t.rows ?? 0 } : null;
    },
  });

  const conversations = new ConversationHub({
    locate: (id) => {
      const t = store.terminal(id);
      return t ? transcripts.locate(t) : 'gone';
    },
    logger,
    ...(config.transcriptPollMs ? { pollMs: config.transcriptPollMs } : {}),
  });
  store.on('patch', () => conversations.refresh());
  store.on('patch', () => hub.refreshSizes());

  const seen = config.seenSync
    ? new SeenSync({
        world: () => store.world,
        looking: () => store.lookingIds(),
        isLive: (id) => store.terminal(id)?.state === 'live',
        write: async (id, turn) => {
          await client.call('terminal.label', { terminal: id, labels: { 'herdr.seen': String(turn) } });
        },
        logger,
      })
    : null;
  if (seen) {
    store.on('looking', () => seen.update());
    store.on('patch', () => seen.update());
  }

  const webBuild = webBuildReader(config.webDir);
  const ws = new WsTransport({
    sessions,
    log,
    world: () => store.world,
    recentAlerts: () => engine.recent,
    onLooking: (clientId, ids) => store.setLooking(clientId, ids),
    terminals: (sink) => new TerminalSession({ hub, logger }, sink),
    conversations: (send) => new ConversationSession({ hub: conversations, logger }, send),
    heartbeatMs: config.heartbeatMs,
    webBuild,
    logger,
    hosts,
    maxPerPeer: limits.maxWsPerPeer,
    addressOf: (req) => clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustProxy === true),
  });
  sessions.on('revoke', (ids) => ws.closeDevices(ids));
  notifier.add(new InPageSink((alert) => ws.publish(log.alert(alert))));
  if (config.ntfy) {
    notifier.add(new NtfySink({ config: config.ntfy, isLooking: (id) => store.lookingIds().has(id), logger }));
    logger.info({ server: new URL(config.ntfy.server).host, private: config.ntfy.private === true }, 'ntfy notifications on');
  }
  // WebPushSink (notify/webpush.ts) registers here once HTTPS is set up.

  store.on('patch', (ops) => ws.publish(log.patch(ops)));
  store.on('transitions', (t) => engine.onTransitions(t));

  const health = new Health({ client, world: () => store.world, clients: () => ws.clientCount, webBuild });
  registerSecurityHeaders(http);
  registerHttp(http, {
    tokens,
    sessions,
    world: () => store.world,
    seq: () => log.seq,
    serverId: ws.serverId,
    health: () => health.report(),
    hosts,
    logger,
    ...(limiter ? { limiter } : {}),
  });
  const shell = userShell();
  const herdrApp = new HerdrApp(config.herdrAppDir);
  const creator = new SpaceCreator({
    core: client,
    store,
    app: herdrApp,
    installed: config.installedAgents ?? new InstalledAgents(shell),
    home: config.home,
    herdrAppDir: config.herdrAppDir,
    shell,
    logger,
  });
  const tabs = new TabCreator({
    core: client,
    store,
    app: herdrApp,
    offers: () => creator.offers(),
    sessions: new ClaudeSessions({ home: config.claudeHome ?? config.home, coreSocket: config.socketPath }),
    home: config.home,
    logger,
  });
  registerSpaceRoutes(http, { creator, tabs, home: config.home });
  registerDiagRoutes(http, {
    log: new DiagLog(config.diagFile ?? path.join(config.configDir, 'diag.jsonl')),
    limiter: new DiagLimiter(),
    build: webBuild,
    logger,
  });
  registerStatic(http, config.webDir);
  ws.attach(http.server);

  return {
    http,
    store,
    ws,
    engine,
    hub,
    conversations,
    seen,
    sessions,
    listeners,
    async start() {
      colors?.start();
      times?.start();
      accounts?.start();
      store.start();
      // The HTTP server itself listens on loopback only; every other address is a gated network listener.
      const host = isLoopback(config.host) ? config.host : '127.0.0.1';
      const url = await http.listen({ host, port: config.port });
      const port = (http.server.address() as AddressInfo).port;
      hosts.setBound([host], port);
      listeners.onChange((addresses) => {
        hosts.setBound(addresses, port);
        logger.info({ addresses, port }, 'listening on');
      });
      await listeners.start(config.bind ?? [], host, port);
      hosts.setBound(listeners.addresses, port);
      return url;
    },
    async stop() {
      engine.stop();
      seen?.stop();
      colors?.stop();
      times?.stop();
      accounts?.stop();
      ws.close();
      hub.stop();
      conversations.stop();
      store.stop();
      sessions.flush();
      await listeners.stop();
      await http.close();
    },
  };
}

/**
 * The peer's address; behind a trusted loopback proxy, the rightmost X-Forwarded-For entry that isn't
 * loopback (the one the proxy itself added; entries left of it are whatever the client claimed).
 */
export function clientAddress(remote: string | undefined, forwarded: string | string[] | undefined, trustProxy: boolean): string {
  const peer = remote ?? '';
  if (!trustProxy || !isLoopback(peer) || !forwarded) return peer;
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!isLoopback(hop)) return hop;
  }
  return peer;
}
