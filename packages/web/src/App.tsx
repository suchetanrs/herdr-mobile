import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Splash, Toasts } from './components/Chrome';
import { UnreadMenu } from './components/UnreadMenu';
import { useConn, useLight, useLive, useServices } from './hooks/app';
import { DESKTOP, useMediaQuery, useVisualViewport } from './hooks/dom';
import { useEdgeBack } from './hooks/gestures';
import { wakeChunkRetries, watchFailedLinks } from './lib/chunks';
import { back, depth, parseRoute, type Route } from './lib/router';
import { AgentScreen } from './screens/AgentScreen';
import { AlertsScreen } from './screens/AlertsScreen';
import { Desktop } from './screens/Desktop';
import { FilesScreen } from './screens/FilesScreen';
import { NewSpaceScreen } from './screens/NewSpaceScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SpaceScreen } from './screens/SpaceScreen';
import { SpacesScreen } from './screens/SpacesScreen';
import { TokenScreen } from './screens/TokenScreen';
import { preloadViews } from './views/lazy';

type DocWithVT = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void> } };

/** The route from the address, with a slide between screens where the browser can (View Transitions). */
function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const current = useRef(route);
  useEffect(() => {
    const onHash = () => {
      const next = parseRoute(window.location.hash);
      const prev = current.current;
      current.current = next;
      const doc = document as DocWithVT;
      const root = document.documentElement;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const sameAgentSwap = prev.name === 'agent' && next.name === 'agent' && prev.terminalId !== next.terminalId;
      const dir =
        depth(next) > depth(prev)
          ? 'forward'
          : depth(next) < depth(prev)
            ? 'back'
            : sameAgentSwap
              ? (root.dataset.swipe ?? 'next')
              : 'none';
      delete root.dataset.swipe;
      if (!doc.startViewTransition || reduce || dir === 'none' || window.matchMedia?.(DESKTOP).matches) {
        setRoute(next);
        return;
      }
      root.dataset.nav = dir;
      const vt = doc.startViewTransition(() => flushSync(() => setRoute(next)));
      // A transition skipped by a newer one (fast taps) is fine: the newer one shows.
      vt.ready.catch(() => {});
      vt.finished.finally(() => {
        if (root.dataset.nav === dir) delete root.dataset.nav;
      });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

function MobileScreen({ route }: { route: Route }) {
  switch (route.name) {
    case 'spaces':
      return <SpacesScreen />;
    case 'alerts':
      return <AlertsScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'new':
      return <NewSpaceScreen />;
    case 'files':
      return <FilesScreen key={route.space ?? ''} view={route.view} space={route.space} />;
    case 'space':
      return <SpaceScreen spaceId={route.spaceId} />;
    case 'agent':
      return <AgentScreen key={route.terminalId} terminalId={route.terminalId} view={route.view} />;
  }
}

/** The parent screen of a route (where back goes, swiping in from the left edge). */
function parentOf(r: Route): Route | null {
  switch (r.name) {
    case 'spaces':
      return null;
    case 'agent':
      return { name: 'spaces' };
    case 'files':
      return r.view
        ? { name: 'files', ...(r.space ? { space: r.space } : {}) }
        : r.space
          ? { name: 'space', spaceId: r.space }
          : { name: 'spaces' };
    default:
      return { name: 'spaces' };
  }
}

/** Herdr's theme on <html> (tokens.css), and the browser chrome's color to match. */
function useTheme(): void {
  const light = useLight();
  // Before the first paint, so a device that picked Light doesn't show a graphite frame first.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = light ? 'light' : 'dark';
    root.style.colorScheme = light ? 'light' : 'dark';
    for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = light ? '#f1f1ee' : '#101114';
  }, [light]);
}

export function App() {
  useVisualViewport();
  useTheme();
  const { conn: connection } = useServices();
  useEffect(() => {
    watchFailedLinks();
    const off = connection.onOpen(wakeChunkRetries);
    // Warm the lazy views up once idle, and only while connected (a failed warm-up is just noise).
    const warm = () => {
      if (connection.isOpen) preloadViews();
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(warm);
    else setTimeout(warm, 1500);
    return off;
  }, [connection]);
  const conn = useConn('status', 'everSynced', 'attempt');
  const live = useLive();
  const route = useRoute();
  const desktop = useMediaQuery(DESKTOP);
  const parent = desktop ? null : parentOf(route);
  useEdgeBack(parent ? () => back(parent) : null);
  let content: React.ReactNode;
  if (conn.status === 'unauthorized') content = <TokenScreen />;
  else if (!conn.everSynced) content = <Splash text={conn.attempt > 1 ? 'Can’t reach the bridge, retrying…' : 'Connecting to Herdr…'} />;
  else if (desktop) content = <Desktop route={route} />;
  else content = <MobileScreen route={route} />;
  return (
    // Not live: the last screen stays, dimmed, with spinners stopped (they'd claim work that may be over).
    <div className={`app${!live && conn.everSynced ? ' stale' : ''}`}>
      {content}
      <Toasts />
      {conn.everSynced && <UnreadMenu />}
    </div>
  );
}
