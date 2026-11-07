import type { NewSpaceOptions, NewSpaceStart, StartChoice } from '@herdr-mobile/protocol';
import { SPACE_NAME_MAX } from '@herdr-mobile/protocol';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { ProgramIcon } from '../components/ProgramIcon';
import { BackButton, Screen } from '../components/Screen';
import { useLive, useServices } from '../hooks/app';
import { useTapFocus } from '../hooks/gestures';
import { programOf } from '../lib/programs';
import { back, navigate } from '../lib/router';
import { completeFolder, createSpace, folderBase, NewSpaceFailure, newSpaceOptions } from '../lib/spaces';

type Field = 'folder' | 'name' | 'start' | 'form';
type Errors = Partial<Record<Field, string>>;

const SHELL: NewSpaceStart = { kind: 'shell' };
const sameStart = (a: NewSpaceStart, c: StartChoice) =>
  a.kind === c.kind && (a.kind === 'agent' ? a.key : a.kind === 'template' ? a.name : '') === c.key;
const startOf = (c: StartChoice): NewSpaceStart => (c.kind === 'agent' ? { kind: 'agent', key: c.key } : { kind: 'template', name: c.key });

/** Folder completions as you type (debounced), from the bridge (home folder only). */
function useCompletions(typed: string, active: boolean): string[] {
  const [entries, setEntries] = useState<string[]>([]);
  useEffect(() => {
    if (!active) return;
    let gone = false;
    const id = setTimeout(() => {
      completeFolder(typed)
        .then((e) => {
          if (!gone) setEntries(e.filter((x) => x !== typed));
        })
        .catch(() => {
          if (!gone) setEntries([]);
        });
    }, 120);
    return () => {
      gone = true;
      clearTimeout(id);
    };
  }, [typed, active]);
  // Answers for what was typed before still show only while they fit what's typed now.
  const t = typed.trim().toLowerCase();
  const now = t === '' || t.startsWith('~') || t.startsWith('/') ? t : `~/${t}`;
  return active ? entries.filter((e) => e.toLowerCase().startsWith(now) && e !== typed) : [];
}

/**
 * New space: a folder (an open or recent space's, or typed with completion), an optional name,
 * and what runs first (the shell, or an agent from Herdr's + menu). The bridge starts it and the
 * Herdr window adopts it; once it shows up here, this opens it.
 */
export function NewSpaceScreen({ embedded = false }: { embedded?: boolean }) {
  const { store } = useServices();
  const live = useLive();
  const [opts, setOpts] = useState<NewSpaceOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [start, setStart] = useState<NewSpaceStart>(SHELL);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [folderFocus, setFolderFocus] = useState(false);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const tapFocusFolder = useTapFocus<HTMLInputElement>();
  const tapFocusName = useTapFocus<HTMLInputElement>();
  const folderRef = useCallback(
    (el: HTMLInputElement | null) => {
      folderInput.current = el;
      tapFocusFolder(el);
    },
    [tapFocusFolder],
  );
  const completions = useCompletions(folder, folderFocus);

  useEffect(() => {
    let gone = false;
    newSpaceOptions()
      .then((o) => {
        if (gone) return;
        setOpts(o);
        setFolder((f) => f || (o.folders[0]?.display ?? '~'));
      })
      .catch((e: Error) => {
        if (!gone) setLoadError(e.message);
      });
    return () => {
      gone = true;
    };
  }, []);

  const pickFolder = (f: string) => {
    setFolder(f);
    setErrors((e) => ({ ...e, folder: undefined, form: undefined }));
  };

  /** Resolves once the world shows the space (and its terminal), or after a few seconds anyway. */
  const appeared = (spaceId: string, terminalId: string) =>
    new Promise<void>((resolve) => {
      const has = () => {
        const v = store.getState().view;
        return Boolean(v.spaces[spaceId] && v.terminals[terminalId]);
      };
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

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!folder.trim()) {
      setErrors({ folder: 'Pick a folder' });
      folderInput.current?.focus();
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const r = await createSpace({ folder: folder.trim(), ...(name.trim() ? { name: name.trim() } : {}), start });
      await appeared(r.spaceId, r.terminalId);
      if (start.kind === 'shell') navigate({ name: 'space', spaceId: r.spaceId }, { replace: true });
      else navigate({ name: 'agent', terminalId: r.terminalId }, { replace: true });
    } catch (err) {
      const f = err instanceof NewSpaceFailure ? err.field : undefined;
      setErrors({ [f ?? 'form']: (err as Error).message });
      setBusy(false);
    }
  };

  const installed = opts?.starts.filter((s) => s.installed) ?? [];
  const missing = opts?.starts.filter((s) => !s.installed) ?? [];
  const choice = (c: StartChoice | null) => {
    const on = c ? sameStart(start, c) : start.kind === 'shell';
    const program = c ? (c.kind === 'agent' ? programOf(c.key, null) : programOf(null, 'template')) : programOf(null, null);
    return (
      <button
        key={c ? `${c.kind}:${c.key}` : 'shell'}
        type="button"
        aria-pressed={on}
        disabled={c ? !c.installed : false}
        className={`ns-choice${on ? ' on' : ''}`}
        onClick={() => {
          setStart(c ? startOf(c) : SHELL);
          setErrors((e) => ({ ...e, start: undefined }));
        }}
      >
        <ProgramIcon program={program} size={16} />
        <span className="ns-choice-text">
          <span className="truncate">{c ? c.name : 'Terminal'}</span>
          {c?.description && <span className="ns-hint truncate">{c.description}</span>}
        </span>
        {c && !c.installed ? (
          <span className="ns-hint">not installed</span>
        ) : on ? (
          <Icon name="check" size={16} className="ns-check" />
        ) : null}
      </button>
    );
  };

  const body = (
    <form className="scroll ns-page" onSubmit={submit} noValidate>
      {loadError && <div className="ns-note t-blocked">{loadError}</div>}
      {opts && !opts.appOpen && (
        <div className="ns-note">
          <Icon name="monitor" size={14} />
          Herdr isn’t open on the computer. It makes the space, so open it first.
        </div>
      )}
      <h2 className="section-head settings-head">Folder</h2>
      <div className="ns-folder">
        <label className={`field${errors.folder ? ' invalid' : ''}`}>
          <Icon name="folder" size={16} />
          <input
            ref={folderRef}
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder="~/code/project"
            value={folder}
            maxLength={1024}
            aria-label="Folder"
            aria-invalid={Boolean(errors.folder)}
            onFocus={() => setFolderFocus(true)}
            onBlur={() => setTimeout(() => setFolderFocus(false), 150)}
            onChange={(e) => pickFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && completions[0] && !e.shiftKey) {
                e.preventDefault();
                pickFolder(completions[0]);
              }
            }}
          />
        </label>
        {completions.length > 0 && (
          <div className="ns-complete" role="listbox" aria-label="Folder suggestions">
            {completions.slice(0, 8).map((c) => (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={false}
                className="ns-complete-row"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  pickFolder(c);
                  folderInput.current?.focus();
                }}
              >
                <Icon name="folder" size={14} />
                <span className="truncate">{c}</span>
              </button>
            ))}
          </div>
        )}
        {errors.folder && <div className="ns-error">{errors.folder}</div>}
      </div>
      {opts && opts.folders.length > 0 && (
        <div className="list-card ns-list">
          {opts.folders.slice(0, 8).map((f) => (
            <button
              key={f.path}
              type="button"
              className={`ns-folder-row${folder === f.display || folder === f.path ? ' on' : ''}`}
              onClick={() => pickFolder(f.display)}
            >
              <Icon name={f.from === 'recent' ? 'clock' : 'folder'} size={15} />
              <span className="ns-choice-text">
                <span className="truncate">{f.label}</span>
                <span className="ns-hint truncate">{f.display}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <h2 className="section-head settings-head">Name</h2>
      <label className={`field${errors.name ? ' invalid' : ''}`}>
        <Icon name="layers" size={16} />
        <input
          ref={tapFocusName}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={`${folderBase(folder)} (Herdr’s name)`}
          value={name}
          maxLength={SPACE_NAME_MAX}
          aria-label="Name"
          aria-invalid={Boolean(errors.name)}
          onChange={(e) => {
            setName(e.target.value);
            setErrors((x) => ({ ...x, name: undefined }));
          }}
        />
      </label>
      {errors.name && <div className="ns-error">{errors.name}</div>}

      <h2 className="section-head settings-head">Start</h2>
      <fieldset className="choice-set" aria-label="Start">
        <div className="list-card ns-list">
          {choice(null)}
          {opts ? (
            [...installed, ...missing].map((c) => choice(c))
          ) : !loadError ? (
            <div className="ns-hint ns-loading">
              <Icon name="spinner" size={14} spin /> Checking installed agents…
            </div>
          ) : null}
        </div>
      </fieldset>
      {errors.start && <div className="ns-error">{errors.start}</div>}

      {errors.form && (
        <div className="ns-error ns-form-error" role="alert">
          {errors.form}
        </div>
      )}
      <div className="ns-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !live}>
          {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="plus" size={14} />}
          {busy ? 'Starting…' : 'Create space'}
        </button>
      </div>
    </form>
  );
  if (embedded) return <div className="main-page">{body}</div>;
  return (
    <Screen
      bar={
        <header className="topbar">
          <BackButton onClick={() => back({ name: 'spaces' })} />
          <span className="topbar-title">New space</span>
        </header>
      }
    >
      {body}
    </Screen>
  );
}
