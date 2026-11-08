import type { ReactNode } from 'react';
import { shallowEqual, useSelector } from '../hooks/app';
import { navigate } from '../lib/router';
import { ReconnectBanner } from './Chrome';
import { Icon } from './Icon';

/** A full-height screen: top bar, the reconnect banner, then its scrolling body. */
export function Screen({ bar, children, className }: { bar: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`screen${className ? ` ${className}` : ''}`}>
      {bar}
      <ReconnectBanner />
      {children}
    </section>
  );
}

export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="icon-btn back-btn" onClick={onClick} aria-label={label}>
      <Icon name="chevron-left" size={20} />
    </button>
  );
}

/** The computer's files: browse and download. */
export function FilesButton({ className = 'icon-btn', size = 18 }: { className?: string; size?: number }) {
  return (
    <button type="button" className={className} onClick={() => navigate({ name: 'files' })} aria-label="Files" title="Files">
      <Icon name="folder" size={size} />
    </button>
  );
}

/** Settings (alerts, theme, text sizes, how agents open). */
export function SettingsButton() {
  return (
    <button type="button" className="icon-btn" onClick={() => navigate({ name: 'settings' })} aria-label="Settings">
      <Icon name="settings" size={18} />
    </button>
  );
}

/** The bell: opens the alerts inbox; a dot with the unread count. */
export function AlertsButton() {
  const { unread, urgent } = useSelector(
    (s) => ({ unread: s.alerts.filter((a) => !a.read).length, urgent: s.alerts.some((a) => !a.read && a.kind === 'blocked') }),
    shallowEqual,
  );
  return (
    <button
      type="button"
      className="icon-btn bell"
      onClick={() => navigate({ name: 'alerts' })}
      aria-label={`Alerts${unread ? `, ${unread} unread` : ''}`}
    >
      <Icon name="bell" size={18} />
      {unread > 0 && <span className={`bell-count${urgent ? ' urgent' : ''}`}>{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}
