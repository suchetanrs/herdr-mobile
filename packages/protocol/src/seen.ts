import type { TerminalView } from './world.js';

/**
 * The `herdr.seen` value that marks an agent unread, or null when it can't be marked (Herdr
 * docs/labels.md: "Mark unread is the one lower write: `herdr.seen=<turn - 1>`. At turn 0 nothing
 * has finished yet"). Only a top-level agent on this machine that finished and was seen (idle):
 * a done one already is unread, and working/blocked ones show that instead.
 */
export function unreadSeenTurn(t: Pick<TerminalView, 'machine' | 'parent' | 'status' | 'turn'>): number | null {
  if (t.machine !== null || t.parent !== null || t.status !== 'idle' || t.turn < 1) return null;
  return t.turn - 1;
}
