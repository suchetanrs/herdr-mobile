/**
 * herdr-core shapes the bridge reads (schema/hc.openrpc.json, generation 1).
 * Only the fields we use are typed; records are kept whole so nothing is lost.
 */

export interface CoreStatus {
  app?: string | null;
  state?: string | null;
  msg?: string | null;
  title?: string | null;
  kind?: string | null;
}

export interface CoreForeground {
  pid?: number | null;
  name?: string | null;
  argv?: string[];
  cwd?: string | null;
}

export interface CoreTerminal {
  address: string;
  state: 'live' | 'finished' | string;
  argv?: string[];
  cols?: number;
  rows?: number;
  cwd?: string | null;
  foreground?: CoreForeground | null;
  labels?: Record<string, string>;
  name?: string | null;
  parent?: string | null;
  pid?: number | null;
  reported?: boolean;
  /** An object from 7501 reports; tolerate a bare word too. */
  status?: CoreStatus | string | null;
  status_ms?: number | null;
  title?: string | null;
  turn?: number;
  [key: string]: unknown;
}

export interface CoreSnapshot {
  seq: number;
  terminals: CoreTerminal[];
  channel?: number | null;
}

export interface CoreEvent {
  seq: number;
  type: string;
  terminal?: string;
  machine?: string;
  data?: unknown;
}

export interface HelloResult {
  core?: { id?: string; name?: string };
  features?: string[];
  framed?: boolean;
  generation?: number;
  methods?: string[];
  version?: string;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: { kind?: string; hint?: string };
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly body: RpcErrorBody,
  ) {
    super(`${method}: ${body.message}${body.data?.hint ? ` (${body.data.hint})` : ''}`);
    this.name = 'RpcError';
  }
  get kind(): string | undefined {
    return this.body.data?.kind;
  }
}

export class CoreUnavailableError extends Error {
  constructor(message = 'herdr-core is not connected') {
    super(message);
    this.name = 'CoreUnavailableError';
  }
}

/** The protocol generation the bridge speaks. */
export const GENERATION = 1;
