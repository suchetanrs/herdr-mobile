import { CLAUDE_SETTING_READY_WORDS, type ClaudeSettingKind, type ClaudeSettingOptions, type TerminalView } from '@herdr-mobile/protocol';
import { useEffect, useRef, useState } from 'react';
import { chooseClaudeSetting, claudeSettingOptions } from '../lib/claude';
import { Icon } from './Icon';
import { SheetLayer } from './Sheet';

/** A Claude Code agent on this computer: its model and effort can be read and set through Claude's menus. */
export function settable(t: TerminalView): boolean {
  return t.machine === null && t.program === 'claude';
}

/** Why Claude's menus can't be opened right now (null: they can). */
export function settingBlocker(t: TerminalView): string | null {
  if (!settable(t)) return 'Only for Claude Code on this computer';
  if (t.word === 'working') return 'Claude is working: wait until it’s idle';
  if (t.word === 'blocked') return 'Claude is waiting for an answer';
  if (!CLAUDE_SETTING_READY_WORDS.includes(t.word ?? '')) return 'Claude isn’t at its prompt';
  return null;
}

const TITLES: Record<ClaudeSettingKind, string> = { model: 'Choose model', effort: 'Choose effort level' };
const CLOSE_AFTER_MS = 900;
/** Longer when Claude added a note (a model switch mid-conversation re-reads the history), so it can be read. */
const CLOSE_AFTER_NOTE_MS = 3500;

/**
 * The models or effort levels the agent's Claude offers, read from its own /model or /effort menu, the one in use
 * ticked. A tap switches it for this session (the bridge checks Claude confirmed); busy agents can't be changed.
 */
export function ClaudeSettingSheet({ t, kind, onClose }: { t: TerminalView; kind: ClaudeSettingKind; onClose: () => void }) {
  const blocker = settingBlocker(t);
  const [list, setList] = useState<ClaudeSettingOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; note?: string } | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // Read once the agent is at its prompt (now, or when it gets there while the sheet is open).
  const ready = blocker === null;
  useEffect(() => {
    if (!ready || list || loading || error) return;
    setLoading(true);
    claudeSettingOptions(t.id, kind)
      .then((r) => alive.current && setList(r))
      .catch((e: Error) => alive.current && setError(e.message))
      .finally(() => alive.current && setLoading(false));
  }, [ready, list, loading, error, t.id, kind]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !applying && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, applying]);

  const pick = async (value: string) => {
    if (applying || !list) return;
    setApplying(value);
    setError(null);
    setDone(null);
    try {
      const r = await chooseClaudeSetting(t.id, kind, value);
      if (!alive.current) return;
      setList({ ...list, current: value });
      setDone(r);
      setTimeout(() => alive.current && onClose(), r.note ? CLOSE_AFTER_NOTE_MS : CLOSE_AFTER_MS);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setApplying(null);
    }
  };

  const retry = () => {
    setError(null);
    setList(null);
  };

  return (
    <SheetLayer className="add-backdrop" onDismiss={() => !applying && onClose()}>
      <div className={`sheet add-sheet setting-sheet setting-${kind}`} role="dialog" aria-modal="true" aria-label={TITLES[kind]}>
        <header className="sheet-head">
          <span className="add-head">
            <span className="sheet-title">{TITLES[kind]}</span>
            <span className="add-hint truncate">For this session only, from Claude’s /{kind}</span>
          </span>
          <span className="spacer" />
          <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose} disabled={Boolean(applying)}>
            <Icon name="x" size={16} />
          </button>
        </header>
        {blocker && (
          <div className="add-note" role="status">
            <Icon name="clock" size={14} /> {blocker}
          </div>
        )}
        <div className="add-body">
          {loading && (
            <div className="add-empty">
              <Icon name="spinner" size={16} spin /> Asking Claude…
            </div>
          )}
          {list && (
            <div role="radiogroup" aria-label={TITLES[kind]}>
              {list.options.map((o) => {
                const on = o.value === list.current;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a button row (tap target) acting as a radio.
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-busy={applying === o.value}
                    className={`add-row setting-row${on ? ' on' : ''}`}
                    disabled={Boolean(blocker) || Boolean(applying)}
                    onClick={() => void pick(o.value)}
                  >
                    <span className="add-row-text">
                      <span className="truncate">{o.label}</span>
                      {o.detail && <span className="add-hint truncate">{o.detail}</span>}
                    </span>
                    <span className="add-row-icon setting-mark">
                      {applying === o.value ? <Icon name="spinner" size={16} spin /> : on ? <Icon name="check" size={16} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {done && (
            <div className="setting-done" role="status">
              <Icon name="circle-check" size={14} />
              <span>
                {done.message}
                {done.note && <span className="setting-note">{done.note}</span>}
              </span>
            </div>
          )}
          {error && (
            <div className="add-error t-blocked" role="alert">
              {error}
              {!list && (
                <button type="button" className="btn btn-small setting-retry" onClick={retry}>
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </SheetLayer>
  );
}
