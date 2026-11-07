import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { BackButton, Screen } from '../components/Screen';
import { useConn, useDiag, useSelector, useServices, useSettings } from '../hooks/app';
import { AB_FLAGS, type AbFlag, ab, setAb } from '../lib/ab';
import { checkSession, type Device, listDevices, revokeDevice, signOutEverywhere } from '../lib/auth';
import { BUILD } from '../lib/build';
import { isStandalone } from '../lib/diag';
import { duration } from '../lib/format';
import { back } from '../lib/router';
import { type Settings, settings as store } from '../lib/settings';
import { askSystemPermission, systemNotificationsPossible, systemPermission } from '../notify/system';

export function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="setting">
      <span className="setting-text">
        <span>{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: IconName }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="setting setting-stack">
      <span className="setting-text">
        <span>{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <fieldset className="choice-set" aria-label={label}>
        <div className="segmented choice">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={value === o.value}
              className={value === o.value ? 'on' : ''}
              onClick={() => onChange(o.value)}
            >
              {o.icon && <Icon name={o.icon} size={14} />}
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function Stepper({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="setting">
      <span className="setting-text">
        <span>{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <div className="stepper">
        <button
          type="button"
          className="tool-btn"
          aria-label={`${label} smaller`}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          <Icon name="minus" size={16} />
        </button>
        <span className="stepper-value">{value}</span>
        <button
          type="button"
          className="tool-btn"
          aria-label={`${label} bigger`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="section-head settings-head">{title}</h2>
      <div className="settings">{children}</div>
    </>
  );
}

const set = (patch: Partial<Settings>) => store.set(patch);

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Signed-in devices (one session each): when, from where, and a way to sign any of them out. */
export function DevicesGroup() {
  const { conn } = useServices();
  const [state, setState] = useState<{ current: string | null; devices: Device[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await listDevices());
      setError(null);
    } catch {
      setError('Can’t load the list right now.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<void>, signsThisOut: boolean) => {
    setBusy(key);
    try {
      await action();
      if (signsThisOut) conn.retryNow();
      else await load();
    } catch {
      setError('That didn’t work. Try again.');
    }
    setBusy(null);
  };

  const now = Date.now();
  return (
    <Group title="Signed-in devices">
      {error && (
        <div className="setting">
          <span className="setting-text">
            <span className="setting-hint">{error}</span>
          </span>
        </div>
      )}
      {state?.devices.map((d) => {
        const current = d.id === state.current;
        return (
          <div className="setting device" key={d.id}>
            <span className="setting-text">
              <span>
                {d.name}
                {current && <span className="device-this"> · this device</span>}
              </span>
              <span className="setting-hint">
                Signed in {day(d.created)} · seen {current ? 'now' : `${duration(now - Date.parse(d.lastSeen))} ago`} ·{' '}
                {d.ip || 'unknown address'}
              </span>
            </span>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy !== null}
              onClick={() => void run(d.id, () => revokeDevice(d.id), current)}
              aria-label={current ? 'Sign out this device' : `Sign out ${d.name}`}
            >
              {busy === d.id ? <Icon name="spinner" size={14} spin /> : null}
              Sign out
            </button>
          </div>
        );
      })}
      <div className="setting-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={busy !== null || !state}
          onClick={() => {
            if (window.confirm('Sign out every device, this one included? Each will need the sign-in link again.')) {
              void run('all', signOutEverywhere, true);
            }
          }}
        >
          {busy === 'all' ? <Icon name="spinner" size={14} spin /> : <Icon name="key" size={14} />}
          Sign out everywhere
        </button>
      </div>
    </Group>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting">
      <span className="setting-text">
        <span>{label}</span>
        <span className="setting-hint about-value">{value}</span>
      </span>
    </div>
  );
}

const SEND_TEXT: Record<string, string> = {
  sent: 'Sent to the bridge',
  limited: 'Too many reports; wait a minute',
  'signed-out': 'Not signed in',
  failed: 'Couldn’t send',
};

/** Build, connection facts, and on-device diagnostics (lib/diag.ts) with the A/B switches (lib/ab.ts). */
export function AboutGroup() {
  const { diag } = useServices();
  const d = useDiag();
  const conn = useConn('status', 'offline');
  const serverBuild = useSelector((st) => st.serverBuild);
  const [signedIn, setSignedIn] = useState<string>('checking…');
  const [flags, setFlags] = useState(() => Object.fromEntries(Object.keys(AB_FLAGS).map((f) => [f, ab(f as AbFlag)])));
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let live = true;
    void checkSession().then((r) => {
      if (live) setSignedIn(r === 'ok' ? 'yes (session cookie accepted)' : r === 'unauthorized' ? 'no' : 'can’t tell (bridge unreachable)');
    });
    return () => {
      live = false;
    };
  }, []);
  const mode = window.matchMedia?.('(display-mode: standalone)').matches ? 'standalone' : 'browser';
  const navStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  return (
    <Group title="About">
      <Fact label="This page’s build" value={BUILD} />
      <Fact
        label="The bridge serves"
        value={serverBuild ? (serverBuild === BUILD ? `${serverBuild} (same)` : `${serverBuild} (differs: reloads when idle)`) : 'unknown'}
      />
      <Fact label="Connection" value={`${conn.status}${conn.offline ? ' · device offline' : ''}`} />
      <Fact label="Signed in" value={signedIn} />
      <Fact
        label="Display mode"
        value={`${mode}${navStandalone !== undefined ? ` · navigator.standalone ${navStandalone}` : ''}${isStandalone() ? ' (home-screen app)' : ''}`}
      />
      <Toggle
        on={d.enabled}
        onChange={(v) => diag.setEnabled(v)}
        label="Diagnostics"
        hint="Records touches, focus, the viewport and the connection (never what you type or see) and sends them to the bridge every 20 s"
      />
      {d.enabled && (
        <>
          <div className="setting-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                await diag.flush('manual');
                setSending(false);
              }}
            >
              {sending ? <Icon name="spinner" size={14} spin /> : null}
              Send now
            </button>
            <span className="setting-hint">
              {d.count} events
              {d.lastSend ? ` · ${SEND_TEXT[d.lastSend.result] ?? d.lastSend.result} ${duration(Date.now() - d.lastSend.at)} ago` : ''}
            </span>
          </div>
          {(Object.keys(AB_FLAGS) as AbFlag[]).map((f) => (
            <Toggle
              key={f}
              on={flags[f] === true}
              onChange={(v) => {
                setAb(f, v);
                setFlags((x) => ({ ...x, [f]: v }));
                diag.push('ab', { flag: f, on: v });
              }}
              label={`A/B: ${f}`}
              hint={AB_FLAGS[f]}
            />
          ))}
          <div className="setting-actions">
            <button type="button" className="btn btn-small" onClick={() => window.location.reload()}>
              Reload with these switches
            </button>
            <a className="btn btn-small" href="/app/keyboard-test.html">
              Keyboard test page (no app code)
            </a>
          </div>
        </>
      )}
    </Group>
  );
}

/** Settings: this device's alerts, look, terminal and composer behaviour. Kept on the device (localStorage). */
export function SettingsScreen({ embedded = false }: { embedded?: boolean }) {
  const s = useSettings();
  const { notifier } = useServices();
  const [perm, setPerm] = useState(systemPermission());
  const anyTerminal = useSelector((st) => Object.keys(st.view.terminals)[0] ?? 't0');
  const conn = useConn('status', 'rttMs');
  const core = useSelector((st) => st.view.core);

  const test = () =>
    void notifier.notify(
      {
        id: `test-${Date.now()}`,
        kind: 'blocked',
        terminalId: anyTerminal,
        title: 'This is how an alert looks',
        body: 'Space / Tab',
        level: 'error',
        turn: 0,
        at: Date.now(),
      },
      { visible: true, looking: false },
    );

  const body = (
    <div className="scroll settings-page">
      <Group title="Alerts">
        <Toggle
          on={s.sounds}
          onChange={(v) => set({ sounds: v })}
          label="Sounds"
          hint="Herdr's sounds when an agent needs you or finishes"
        />
        <Toggle on={s.vibrate} onChange={(v) => set({ vibrate: v })} label="Vibrate" hint="Where the phone allows it (Android)" />
        {systemNotificationsPossible() ? (
          perm === 'granted' ? (
            <Toggle
              on={s.desktop}
              onChange={(v) => set({ desktop: v })}
              label="System notifications"
              hint="When this page isn't in front"
            />
          ) : (
            <div className="setting">
              <span className="setting-text">
                <span>System notifications</span>
                <span className="setting-hint">
                  {perm === 'denied' ? 'Blocked in the browser settings' : 'When this page isn’t in front'}
                </span>
              </span>
              {perm !== 'denied' && (
                <button type="button" className="btn btn-small" onClick={async () => setPerm(await askSystemPermission())}>
                  Allow
                </button>
              )}
            </div>
          )
        ) : (
          <div className="setting">
            <span className="setting-text">
              <span>System notifications</span>
              <span className="setting-hint">Need HTTPS. Alerts show in this page meanwhile.</span>
            </span>
          </div>
        )}
        <div className="setting-actions">
          <button type="button" className="btn btn-small" onClick={test}>
            <Icon name="bell" size={14} />
            Test alert
          </button>
        </div>
      </Group>

      <Group title="Look">
        <Choice
          label="Theme"
          hint="Herdr's graphite and paper"
          value={s.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'dark', label: 'Dark', icon: 'moon' },
            { value: 'light', label: 'Light', icon: 'sun' },
          ]}
        />
        <Stepper
          label="Conversation text"
          hint="px, on phones"
          value={s.chatFont}
          min={12}
          max={20}
          onChange={(v) => set({ chatFont: v })}
        />
      </Group>

      <Group title="Agents">
        <Choice
          label="Open agents on"
          hint="For agents with a transcript; each agent remembers the tab you last picked"
          value={s.agentView}
          onChange={(v) => set({ agentView: v })}
          options={[
            { value: 'conversation', label: 'Conversation', icon: 'message' },
            { value: 'terminal', label: 'Terminal', icon: 'terminal' },
          ]}
        />
        <Choice
          label="Terminal text"
          hint="Auto: readable, pans sideways with the cursor. Fit: the whole terminal at once. The desktop's size never changes."
          value={s.termZoom}
          onChange={(v) => set({ termZoom: v })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'fit', label: 'Fit' },
          ]}
        />
        <Toggle
          on={s.sendEnter}
          onChange={(v) => set({ sendEnter: v })}
          label="Send presses Enter"
          hint="Off: the send button types the text without submitting it"
        />
      </Group>

      <DevicesGroup />

      <AboutGroup />

      <Group title="Connection">
        <div className="setting">
          <span className="setting-text">
            <span>{core.name ?? 'This computer'}</span>
            <span className="setting-hint">
              {conn.status === 'open'
                ? `${core.connected ? `Herdr ${core.version ?? ''}`.trim() : 'Herdr is not running'}${conn.rttMs !== null ? ` · ${conn.rttMs} ms` : ''}`
                : 'Reconnecting…'}
            </span>
          </span>
          <span className={`conn conn-${conn.status === 'open' ? (core.connected ? 'ok' : 'warn') : 'down'}`}>
            <span className="conn-dot" />
          </span>
        </div>
      </Group>
    </div>
  );
  if (embedded) return <div className="main-page">{body}</div>;
  return (
    <Screen
      bar={
        <header className="topbar">
          <BackButton onClick={() => back({ name: 'spaces' })} />
          <span className="topbar-title">Settings</span>
        </header>
      }
    >
      {body}
    </Screen>
  );
}
