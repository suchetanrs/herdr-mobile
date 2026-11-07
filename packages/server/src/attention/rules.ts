import type { AlertKind } from '@herdr-mobile/protocol';
import { isBlockedWord, isBusyWord } from '../world/status.js';
import type { WordTransition } from '../world/store.js';

/**
 * Herdr's attention rule for a change of 7501 word (model.rs `alert`):
 * needing you (blocked/error) always alerts on entry; finishing (busy -> a
 * non-busy word) alerts only if nobody was looking.
 */
export function alertKind(prev: string | null, next: string | null, looking: boolean): AlertKind | null {
  if (isBlockedWord(next) && !isBlockedWord(prev)) return 'blocked';
  if (isBusyWord(prev) && next !== null && !isBusyWord(next) && !looking) return 'done';
  return null;
}

/** `alertKind` for one terminal (model.rs `alert_for`): sub-agents and paneless terminals never ring. */
export function alertFor(t: WordTransition): AlertKind | null {
  if (t.subAgent || !t.hasPane) return null;
  return alertKind(t.prev, t.next, t.looking);
}

/** Toast text as the desktop builds it (window.rs `alert`). */
export function alertText(kind: AlertKind, name: string | null): { title: string; level: 'error' | 'info' } {
  const who = name || 'An agent';
  return kind === 'blocked' ? { title: `${who} needs you`, level: 'error' } : { title: `${who} finished`, level: 'info' };
}
