/**
 * Attention alerts, the same ones the Herdr desktop raises (model.rs `alert`,
 * window.rs `alert`): an agent needs you (blocked/error) or finished.
 */
export type AlertKind = 'blocked' | 'done';

export interface AttentionAlert {
  /** Unique per alert (for dedupe on the client and notification tags). */
  id: string;
  kind: AlertKind;
  terminalId: string;
  /** "<name> needs you" / "<name> finished". */
  title: string;
  /** "<space> / <tab>", or null when the agent has no place. */
  body: string | null;
  /** Toast level as in Herdr: blocked -> error, done -> info. */
  level: 'error' | 'info';
  /** The turn the agent was on when it fired. */
  turn: number;
  /** ms since the epoch. */
  at: number;
}
