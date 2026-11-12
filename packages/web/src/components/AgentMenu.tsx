import { BRANCH_NAME_MAX, branchNameError, type ClaudeSettingKind, type TerminalView } from '@herdr-mobile/protocol';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useServices, useWorld } from '../hooks/app';
import { useTapFocus } from '../hooks/gestures';
import { terminalName } from '../lib/model';
import { navigate } from '../lib/router';
import { addTab } from '../lib/spaces';
import { ClaudeSettingSheet, settingBlocker } from './ClaudeSettingSheet';
import { Icon } from './Icon';
import { SheetLayer } from './Sheet';

const TRANSCRIPT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** A Claude Code agent on this computer, in a space, whose session (transcript) the bridge knows: it can be branched. */
export function branchable(t: TerminalView): boolean {
  return t.machine === null && t.program === 'claude' && Boolean(t.spaceId) && TRANSCRIPT.test(t.transcript ?? '');
}

/** "<name> (branch)", cut so it fits. */
export function branchName(name: string): string {
  const suffix = ' (branch)';
  return `${name.slice(0, BRANCH_NAME_MAX - suffix.length).trim()}${suffix}`;
}

/**
 * The agent's "⋯" (top right of its screen): branch out from this conversation (a new Claude
 * session in a new tab of the same space that starts with this conversation's history), choose
 * the session's model or effort level (Claude's own /model and /effort lists), and a placeholder
 * for what comes next.
 */
export function AgentMenu({ t, small = false }: { t: TerminalView; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const [branching, setBranching] = useState(false);
  const [setting, setSetting] = useState<ClaudeSettingKind | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different agent closes it.
  useEffect(() => {
    setOpen(false);
    setBranching(false);
    setSetting(null);
  }, [t.id]);
  const canBranch = branchable(t);
  const blocker = settingBlocker(t);
  const settingItem = (kind: ClaudeSettingKind, icon: 'cpu' | 'gauge', label: string, hint: string) => (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      disabled={blocker !== null}
      onClick={() => {
        setOpen(false);
        setSetting(kind);
      }}
    >
      <Icon name={icon} size={16} />
      <span className="menu-item-text">
        <span>{label}</span>
        <span className="menu-hint">{blocker ?? hint}</span>
      </span>
    </button>
  );
  return (
    <div className="agent-more" ref={box}>
      <button
        type="button"
        className={`icon-btn${small ? ' sm pane-more' : ''}${open ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={small ? 15 : 18} />
      </button>
      {open && (
        <div className="menu agent-more-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!canBranch}
            onClick={() => {
              setOpen(false);
              setBranching(true);
            }}
          >
            <Icon name="git-branch" size={16} />
            <span className="menu-item-text">
              <span>Branch out from this conversation</span>
              <span className="menu-hint">
                {canBranch ? 'A new Claude session in this space, starting from here' : 'Only for Claude Code conversations'}
              </span>
            </span>
          </button>
          {settingItem('model', 'cpu', 'Choose model', 'The models this Claude session offers')}
          {settingItem('effort', 'gauge', 'Choose effort level', 'How hard Claude thinks in this session')}
          <button type="button" role="menuitem" className="menu-item" disabled>
            <Icon name="sparkles" size={16} />
            <span className="menu-item-text">
              <span>More features coming soon</span>
            </span>
          </button>
        </div>
      )}
      {branching && <BranchSheet t={t} onClose={() => setBranching(false)} />}
      {setting && <ClaudeSettingSheet t={t} kind={setting} onClose={() => setSetting(null)} />}
    </div>
  );
}

/** Asks for the new conversation's name, then has the bridge open it; its screen opens once Herdr shows it. */
export function BranchSheet({ t, onClose }: { t: TerminalView; onClose: () => void }) {
  const { store } = useServices();
  const world = useWorld();
  const [name, setName] = useState(() => branchName(terminalName(t, world)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const tapFocus = useTapFocus<HTMLInputElement>();
  const inputRef = useCallback(
    (el: HTMLInputElement | null) => {
      input.current = el;
      tapFocus(el);
    },
    [tapFocus],
  );

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const invalid = branchNameError(name.trim());
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (busy || invalid || !t.spaceId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await addTab(t.spaceId, { kind: 'branch', terminal: t.id, name: name.trim() });
      await appeared(r.terminalId);
      onClose();
      // Claude writes the fork's transcript with its first new message: until then the history is on the terminal.
      navigate({ name: 'agent', terminalId: r.terminalId, view: 'terminal' });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <SheetLayer className="add-backdrop" onDismiss={() => !busy && onClose()}>
      <form className="sheet add-sheet branch-sheet" role="dialog" aria-modal="true" aria-label="Branch out" onSubmit={submit} noValidate>
        <header className="sheet-head">
          <span className="add-head">
            <span className="sheet-title">Branch out</span>
            <span className="add-hint truncate">A new conversation with this one’s history, in a new tab</span>
          </span>
          <span className="spacer" />
          <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="add-body branch-body">
          <label className={`field${touched && invalid ? ' invalid' : ''}`}>
            <Icon name="git-branch" size={16} />
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={name}
              maxLength={BRANCH_NAME_MAX}
              aria-label="Name of the new conversation"
              aria-invalid={Boolean(touched && invalid)}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value);
                setTouched(true);
                setError(null);
              }}
            />
          </label>
          {touched && invalid && <div className="ns-error">{invalid}</div>}
          {error && (
            <div className="add-error t-blocked" role="alert">
              {error}
            </div>
          )}
          <div className="branch-actions">
            <button type="button" className="btn btn-small" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-small btn-primary" disabled={busy || Boolean(invalid)}>
              {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="git-branch" size={14} />}
              {busy ? 'Starting…' : 'Create'}
            </button>
          </div>
        </div>
      </form>
    </SheetLayer>
  );
}
