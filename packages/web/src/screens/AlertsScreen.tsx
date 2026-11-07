import { useEffect } from 'react';
import { Icon } from '../components/Icon';
import { BackButton, Screen, SettingsButton } from '../components/Screen';
import { useAlerts, useNow, useServices, useWorld } from '../hooks/app';
import { duration } from '../lib/format';
import { back, navigate } from '../lib/router';

/** The alerts inbox: every "needs you" / "finished" the bridge raised. How they're announced is in Settings. */
export function AlertsScreen({ embedded = false }: { embedded?: boolean }) {
  const alerts = useAlerts();
  const world = useWorld();
  const { store, notifier } = useServices();
  const now = useNow(15000);

  // Opening the inbox reads it.
  useEffect(() => {
    const id = setTimeout(() => store.markAlertsRead(), 1200);
    return () => clearTimeout(id);
  }, [store]);

  const test = () =>
    void notifier.notify(
      {
        id: `test-${Date.now()}`,
        kind: 'blocked',
        terminalId: Object.keys(world.terminals)[0] ?? 't0',
        title: 'This is how an alert looks',
        body: 'Space / Tab',
        level: 'error',
        turn: 0,
        at: Date.now(),
      },
      { visible: true, looking: false },
    );

  const body = (
    <div className="scroll">
      <div className="list-head">
        <h2 className="section-head">Recent</h2>
        <span className="spacer" />
        {alerts.length > 0 && (
          <button type="button" className="link-btn" onClick={() => store.clearAlerts()}>
            Clear
          </button>
        )}
      </div>
      {alerts.length === 0 && (
        <div className="state-card">
          <Icon name="bell" size={22} />
          <h3>No alerts yet</h3>
          <p>Agents that need you or finish show up here, with Herdr's sound, while this page is open.</p>
          <button type="button" className="btn btn-small" onClick={test}>
            <Icon name="bell" size={14} />
            Test alert
          </button>
        </div>
      )}
      <div className="alert-list">
        {alerts.map((a) => {
          const t = world.terminals[a.terminalId];
          const live = t && ((a.kind === 'blocked' && t.status === 'blocked') || (a.kind === 'done' && t.status === 'done'));
          return (
            <button
              type="button"
              key={a.id}
              className={`alert-row${a.read ? '' : ' unread'}${live ? ' live' : ''}`}
              onClick={() => navigate({ name: 'agent', terminalId: a.terminalId })}
              disabled={!t}
            >
              <span className={`toast-dot bg-${a.kind === 'blocked' ? 'blocked' : 'accent'}`} />
              <span className="alert-text">
                <span className="alert-title">{a.title}</span>
                <span className="alert-body">
                  {a.body ?? ''}
                  {!t && ' · gone'}
                  {live && <span className={`t-${a.kind}`}> · {a.kind === 'blocked' ? 'still waiting' : 'unseen'}</span>}
                </span>
              </span>
              <span className="age">{duration(now - a.at)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
  if (embedded) return <div className="main-page">{body}</div>;
  return (
    <Screen
      bar={
        <header className="topbar">
          <BackButton onClick={() => back({ name: 'spaces' })} />
          <span className="topbar-title">Alerts</span>
          <span className="spacer" />
          <SettingsButton />
          {alerts.some((a) => !a.read) && (
            <button type="button" className="icon-btn" aria-label="Mark all read" onClick={() => store.markAlertsRead()}>
              <Icon name="check-all" size={18} />
            </button>
          )}
        </header>
      }
    >
      {body}
    </Screen>
  );
}
