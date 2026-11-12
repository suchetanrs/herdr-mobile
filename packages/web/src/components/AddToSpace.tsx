import type { NewTabStart, ResumableSession, SpaceSessions } from '@herdr-mobile/protocol';
import { type ReactNode, useEffect, useState } from 'react';
import { useServices } from '../hooks/app';
import { duration, plural } from '../lib/format';
import { programOf } from '../lib/programs';
import { navigate } from '../lib/router';
import { addTab, spaceSessions } from '../lib/spaces';
import { Icon } from './Icon';
import { ProgramIcon } from './ProgramIcon';
import { SheetLayer } from './Sheet';

type Step = 'pick' | 'claude' | 'resume';
const TITLES: Record<Step, string> = { pick: 'New tab', claude: 'Claude session', resume: 'Resume a session' };
/** The session's own login. */
const OWN = '';

/** A long `~/a/b/c/d` as its end (`…/c/d`), whole folder names only. */
export function shortPath(p: string, max = 32): string {
  if (p.length <= max) return p;
  const parts = p.split('/');
  let out = parts.pop() ?? '';
  while (parts.length && out.length + (parts.at(-1)?.length ?? 0) + 3 <= max) out = `${parts.pop()}/${out}`;
  return `…/${out}`;
}

/** The small + of a space (its top bar on a phone, after the tabs on a desktop), as Herdr's tab-bar +. */
export function AddButton({ onClick, className = 'icon-btn' }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`${className} add-btn`} onClick={onClick} aria-label="New tab" title="New tab">
      <Icon name="plus" size={16} />
    </button>
  );
}

/**
 * What the + opens, after Herdr's + menu: a terminal, or a Claude session, new or resumed (one of
 * this folder's sessions; one that is already open opens where it runs). The bridge starts it as a
 * new tab of the space and Herdr adopts it; once it shows up here, its screen opens.
 */
export function AddToSpace({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { store } = useServices();
  const [step, setStep] = useState<Step>('pick');
  const [info, setInfo] = useState<SpaceSessions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [config, setConfig] = useState(OWN);

  const load = () => {
    setLoading(true);
    return spaceSessions(spaceId)
      .then((s) => {
        setInfo(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per open.
  useEffect(() => {
    load();
  }, [spaceId]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  /** Resolves once the world shows the terminal in its tab (or after a few seconds anyway). */
  const appeared = (terminalId: string) =>
    new Promise<void>((resolve) => {
      const has = () => Boolean(store.getState().view.terminals[terminalId]?.tabId);
      if (has()) return resolve();
      const timer = setTimeout(done, 5000);
      const off = store.subscribe(() => {
        if (has()) done();
      });
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });

  const open = async (key: string, start: NewTabStart) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const r = await addTab(spaceId, start);
      await appeared(r.terminalId);
      onClose();
      navigate({ name: 'agent', terminalId: r.terminalId });
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const go = (s: Step) => {
    setError(null);
    setStep(s);
    if (s === 'resume') load();
  };

  const claudeOk = info?.claudeInstalled !== false;
  const resumable = info?.sessions.filter((s) => !s.openIn && !s.runningElsewhere).length ?? 0;
  const row = (
    key: string,
    icon: ReactNode,
    name: string,
    hint: string,
    onClick: () => void,
    opts: { more?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      key={key}
      type="button"
      className="add-row"
      disabled={opts.disabled || (busy !== null && busy !== key)}
      aria-busy={busy === key}
      onClick={onClick}
    >
      <span className="add-row-icon">{icon}</span>
      <span className="add-row-text">
        <span className="truncate">{name}</span>
        {hint && <span className="add-hint truncate">{hint}</span>}
      </span>
      {busy === key ? (
        <Icon name="spinner" size={14} spin />
      ) : opts.more ? (
        <Icon name="chevron-right" size={16} className="add-more" />
      ) : null}
    </button>
  );

  const claudeIcon = <ProgramIcon program={programOf('claude', null)} size={16} />;
  let body: ReactNode;
  if (step === 'pick') {
    body = (
      <>
        {row('shell', <Icon name="terminal" size={16} />, 'Terminal', info ? `A shell in ${shortPath(info.display)}` : 'A shell', () =>
          open('shell', { kind: 'shell' }),
        )}
        {row('claude', claudeIcon, 'Claude session', claudeOk ? 'New, or resume one' : 'Claude Code isn’t installed', () => go('claude'), {
          more: true,
          disabled: !claudeOk,
        })}
      </>
    );
  } else if (step === 'claude') {
    body = (
      <>
        {row('new', claudeIcon, 'New session', info ? `Claude Code in ${shortPath(info.display)}` : 'Claude Code', () =>
          open('new', { kind: 'claude' }),
        )}
        {row(
          'resume',
          <Icon name="clock" size={16} />,
          'Resume session',
          loading && !info ? 'Looking…' : resumable ? `${plural(resumable, 'session')} in this folder` : 'None in this folder yet',
          () => go('resume'),
          { more: true },
        )}
      </>
    );
  } else {
    const configs = info?.configs ?? [];
    const labelOf = (id: string) => configs.find((c) => c.id === id)?.label ?? id;
    const now = Date.now();
    body = (
      <>
        {configs.length > 1 && (
          <fieldset className="add-accounts">
            <legend className="add-accounts-label">Resume with</legend>
            <div className="add-chips">
              {[{ id: OWN, label: 'Its own login' }, ...configs].map((c) => (
                <button
                  key={c.id || 'own'}
                  type="button"
                  aria-pressed={config === c.id}
                  className={`add-chip${config === c.id ? ' on' : ''}`}
                  onClick={() => setConfig(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {loading && !info?.sessions.length ? (
          <div className="add-empty">
            <Icon name="spinner" size={14} spin /> Looking for sessions…
          </div>
        ) : info && info.sessions.length === 0 ? (
          <div className="add-empty">No Claude sessions in {shortPath(info.display)} yet.</div>
        ) : (
          <div className="add-sessions">
            {info?.sessions.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                now={now}
                account={configs.length > 1 ? labelOf(s.config) : null}
                busy={busy === s.id}
                disabled={busy !== null && busy !== s.id}
                onPick={() => {
                  if (s.openIn) {
                    onClose();
                    navigate({ name: 'agent', terminalId: s.openIn });
                  } else open(s.id, { kind: 'resume', session: s.id, ...(config ? { config } : {}) });
                }}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <SheetLayer className="add-backdrop" onDismiss={onClose}>
      <div className={`sheet add-sheet add-${step}`} role="dialog" aria-modal="true" aria-label={TITLES[step]}>
        <header className="sheet-head">
          {step !== 'pick' && (
            <button type="button" className="icon-btn sm" aria-label="Back" onClick={() => go(step === 'resume' ? 'claude' : 'pick')}>
              <Icon name="chevron-left" size={16} />
            </button>
          )}
          <span className="add-head">
            <span className="sheet-title">{TITLES[step]}</span>
            {info && (
              <span className="add-folder truncate" title={info.folder}>
                {shortPath(info.display, 44)}
              </span>
            )}
          </span>
          <span className="spacer" />
          <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        {info && !info.appOpen && (
          <div className="add-note">
            <Icon name="monitor" size={14} /> Herdr isn’t open on the computer. It adds the tab, so open it first.
          </div>
        )}
        <div className="add-body">
          {body}
          {error && (
            <div className="add-error t-blocked" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </SheetLayer>
  );
}

function SessionRow({
  s,
  now,
  account,
  busy,
  disabled,
  onPick,
}: {
  s: ResumableSession;
  now: number;
  account: string | null;
  busy: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const name = s.title ?? s.prompt;
  const meta = [`${duration(now - s.modifiedMs)} ago`, plural(s.messages, 'message'), account].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className={`add-session${s.openIn ? ' open' : ''}`}
      disabled={disabled || s.runningElsewhere}
      aria-busy={busy}
      onClick={onPick}
      title={s.prompt}
    >
      <span className="add-row-text">
        <span className="add-session-name">{name}</span>
        {s.title && s.prompt && <span className="add-hint truncate">{s.prompt}</span>}
        <span className="add-hint">{meta}</span>
      </span>
      {busy ? (
        <Icon name="spinner" size={14} spin />
      ) : s.openIn ? (
        <span className="add-badge">Open</span>
      ) : s.runningElsewhere ? (
        <span className="add-badge dim">Running elsewhere</span>
      ) : null}
    </button>
  );
}
