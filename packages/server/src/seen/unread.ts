import { unreadSeenTurn, type World } from '@herdr-mobile/protocol';

export interface MarkUnreadDeps {
  world: () => World;
  isLive: (terminalId: string) => boolean;
  /** Writes `herdr.seen=<turn>` (through core/policy.ts, which allows only that label). */
  write: (terminalId: string, turn: number) => Promise<void>;
}

/**
 * "Mark as unread" from a phone: lowers `herdr.seen` to turn - 1, so Herdr desktop, the my-agents
 * mod and every phone show the agent done again. Resolves with an error for the client, or null.
 * Seen sync (sync.ts) won't raise it back while the agent merely stays on a screen: it writes once
 * per turn per look, as the desktop does.
 */
export async function markUnread(deps: MarkUnreadDeps, terminalId: string): Promise<string | null> {
  const t = deps.world().terminals[terminalId];
  if (!t || !deps.isLive(terminalId)) return 'no such live terminal';
  const seen = unreadSeenTurn(t);
  if (seen === null) return 'only a finished agent you have seen can be marked unread';
  await deps.write(terminalId, seen);
  return null;
}
