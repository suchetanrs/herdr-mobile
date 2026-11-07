import { type AgentStatus, STATUS_PRIORITY } from '@herdr-mobile/protocol';
import type { CoreTerminal } from '../core/types.js';

/** The 7501 word a terminal reports (`status.state`), or null when it doesn't report. */
export function wordOf(t: CoreTerminal): string | null {
  const s = t.status;
  if (typeof s === 'string') return s || null;
  if (s && typeof s === 'object' && typeof s.state === 'string' && s.state) return s.state;
  return null;
}

export function appOf(t: CoreTerminal): string | null {
  const s = t.status;
  return s && typeof s === 'object' && typeof s.app === 'string' && s.app ? s.app : null;
}

/** `herdr.seen` as a number; null when missing or unreadable (a missing label is not 0). */
export function seenTurnOf(t: CoreTerminal): number | null {
  const raw = t.labels?.['herdr.seen'];
  // Rust `parse::<u64>`: ASCII digits only (no hex, exponents, signs or spaces).
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * What Herdr shows for an agent (docs/labels.md, model.rs `status`):
 * blocked/error -> blocked; working -> working; otherwise done when
 * turn > herdr.seen (or, without the label, when not seen locally), else idle.
 */
export function displayStatus(word: string | null, turn: number, seenTurn: number | null, seenLocally: boolean): AgentStatus | null {
  if (word === null) return null;
  if (word === 'working') return 'working';
  if (word === 'blocked' || word === 'error') return 'blocked';
  const done = seenTurn === null ? !seenLocally : turn > seenTurn;
  return done ? 'done' : 'idle';
}

/** Most urgent of some statuses (blocked > done > working > idle); null when none is an agent. */
export function rollup(statuses: Iterable<AgentStatus | null>): AgentStatus | null {
  let best: AgentStatus | null = null;
  for (const s of statuses) {
    if (s !== null && (best === null || STATUS_PRIORITY[s] > STATUS_PRIORITY[best])) best = s;
  }
  return best;
}

export const isBlockedWord = (w: string | null): boolean => w === 'blocked' || w === 'error';
export const isBusyWord = (w: string | null): boolean => w === 'working' || w === 'blocked' || w === 'error';
