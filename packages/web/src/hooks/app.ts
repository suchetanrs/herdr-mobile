import type { World } from '@herdr-mobile/protocol';
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Services } from '../lib/app';
import { drafts } from '../lib/drafts';
import { type Settings, settings } from '../lib/settings';
import type { AppState, ConnState } from '../lib/store';
import type { Toast } from '../notify/toasts';
import { useMediaQuery } from './dom';

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s;
}

/** Shallow equality of two plain objects (or arrays). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * A slice of the app state: the component re-renders only when the slice changes (by `equal`),
 * not on every patch, ping or alert.
 */
export function useSelector<T>(select: (s: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const { store } = useServices();
  const cache = useRef<{ state: AppState; select: (s: AppState) => T; value: T } | null>(null);
  const get = () => {
    const state = store.getState();
    const prev = cache.current;
    if (prev && prev.state === state && prev.select === select) return prev.value;
    const value = select(state);
    const kept = prev && equal(prev.value, value) ? prev.value : value;
    cache.current = { state, select, value: kept };
    return kept;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

const selectView = (s: AppState) => s.view;
const selectAlerts = (s: AppState) => s.alerts;

/** The world as screens show it (doesn't change for grid-size-only patches). */
export function useWorld(): World {
  return useSelector(selectView);
}

export function useAlerts(): AppState['alerts'] {
  return useSelector(selectAlerts);
}

/** Some fields of the connection state (pings change `rttMs` every 10 s: ask for it only to show it). */
export function useConn<K extends keyof ConnState>(...keys: K[]): Pick<ConnState, K> {
  return useSelector((s) => {
    const out = {} as Pick<ConnState, K>;
    for (const k of keys) out[k] = s.conn[k];
    return out;
  }, shallowEqual);
}

/** The bridge is connected and so is Herdr: what's on screen is current. */
export function useLive(): boolean {
  return useSelector((s) => s.conn.status === 'open' && s.view.core.connected);
}

export function useToasts(): Toast[] {
  const { toasts } = useServices();
  return useSyncExternalStore(toasts.subscribe, toasts.get, toasts.get);
}

export function useSettings(): Settings {
  return useSyncExternalStore(settings.subscribe, settings.get, settings.get);
}

/** Re-renders every `ms` (ages like "4m"). */
export function useNow(ms = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The person is looking at this agent while the component is mounted (and the page visible). */
export function useLooking(terminalId: string | null): void {
  const { looking } = useServices();
  useEffect(() => (terminalId ? looking.add(terminalId) : undefined), [looking, terminalId]);
}

/** Herdr's light theme (paper) is showing: only when Settings picks it, or picks System on a light system. */
export function useLight(): boolean {
  const { theme } = useSettings();
  const system = useMediaQuery('(prefers-color-scheme: light)');
  return theme === 'system' ? system : theme === 'light';
}

/** Agents with a composer draft on this device. */
export function useDrafts(): ReadonlySet<string> {
  return useSyncExternalStore(drafts.subscribe, drafts.withDrafts, drafts.withDrafts);
}

/** The diagnostics recorder's state (Settings > Diagnostics). */
export function useDiag(): { enabled: boolean; count: number; lastSend: { at: number; result: string } | null } {
  const { diag } = useServices();
  const sub = useRef((l: () => void) => diag.subscribe(l)).current;
  useSyncExternalStore(
    sub,
    () => diag.snapshot(),
    () => '',
  );
  return { enabled: diag.enabled, count: diag.count, lastSend: diag.lastSend };
}
