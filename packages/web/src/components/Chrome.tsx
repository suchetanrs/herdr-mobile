import { useEffect, useState } from 'react';
import { useConn, useSelector, useServices, useToasts } from '../hooks/app';
import { navigate } from '../lib/router';
import { Icon } from './Icon';

/** Herdr's mark (the ram on its ivory tile), as in the sidebar header. */
export function HerdrMark({ size = 18 }: { size?: number }) {
  return <img className="herdr-mark" src="/app/herdr.svg" width={size} height={size} alt="" draggable={false} />;
}

/** Connection state in a few words + a colored dot (status bar, top bar). */
export function ConnectionDot({ withLabel = false }: { withLabel?: boolean }) {
  const conn = useConn('status', 'rttMs');
  const core = useSelector((s) => s.view.core.connected);
  const up = conn.status === 'open' && core;
  const tone = conn.status === 'open' ? (core ? 'ok' : 'warn') : 'down';
  const label =
    conn.status === 'open'
      ? core
        ? `${conn.rttMs !== null ? `${conn.rttMs} ms` : 'Live'}`
        : 'Herdr is not running'
      : conn.status === 'unauthorized'
        ? 'Signed out'
        : 'Reconnecting';
  return (
    <span className={`conn conn-${tone}`} title={up ? `Connected · ${label}` : label}>
      <span className="conn-dot" />
      {withLabel && <span className="conn-label">{label}</span>}
    </span>
  );
}

function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (at === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** While the bridge is away: a slim bar that keeps the last screen visible under it. */
export function ReconnectBanner() {
  const conn = useConn('status', 'retryAt', 'attempt', 'everSynced', 'lostAt', 'offline');
  const core = useSelector((s) => s.view.core.connected);
  const { conn: connection } = useServices();
  const secs = useCountdown(conn.retryAt);
  if (conn.status === 'open' && core) return null;
  if (!conn.everSynced || conn.status === 'unauthorized') return null;
  const coreDown = conn.status === 'open' && !core;
  // What's on screen is as of when the connection went (statuses may have moved on since).
  const asOf = conn.lostAt ? ` · as of ${new Date(conn.lostAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  const text = coreDown
    ? 'Herdr is not running on this computer'
    : conn.offline
      ? `No network${asOf}`
      : `${conn.attempt > 0 && secs ? `Reconnecting in ${secs}s` : 'Reconnecting'}${asOf}`;
  return (
    <div className={`banner ${coreDown ? 'banner-warn' : ''}`} role="status" aria-live="polite">
      <Icon name={coreDown ? 'monitor' : 'offline'} size={14} />
      <span className="banner-text">{text}</span>
      {!coreDown && (
        <button type="button" className="banner-btn" onClick={() => connection.retryNow()}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Herdr's toast (toast mod): popover, a dot in the level's color, title, "space / tab". Tap to open the agent. */
export function Toasts() {
  const toasts = useToasts();
  const { toasts: store } = useServices();
  const DOT = { error: 'var(--blocked)', warning: 'var(--working)', success: 'var(--done)', info: 'var(--accent)' } as const;
  return (
    <div className="toasts" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <button
            type="button"
            className="toast-main"
            onClick={() => {
              store.dismiss(t.id);
              if (t.terminalId) navigate({ name: 'agent', terminalId: t.terminalId });
            }}
          >
            <span className="toast-dot" style={{ background: DOT[t.level] }} />
            <span className="toast-text">
              <span className="toast-title">{t.title}</span>
              {t.body && <span className="toast-body">{t.body}</span>}
            </span>
          </button>
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => store.dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** First load, nothing to show yet. */
export function Splash({ text }: { text: string }) {
  return (
    <div className="splash">
      <HerdrMark size={44} />
      <div className="splash-text">
        <Icon name="spinner" size={14} spin />
        {text}
      </div>
    </div>
  );
}
