import type { FsEntry, FsFile, FsListing } from '@herdr-mobile/protocol';
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { BackButton, Screen } from '../components/Screen';
import { useTapFocus } from '../hooks/gestures';
import {
  completeFrom,
  crumbs,
  downloadUrl,
  FsProblem,
  fileSize,
  joinPath,
  lookup,
  modified,
  startDownload,
  tildePath,
  typedToPath,
} from '../lib/files';
import { back } from '../lib/router';
import { load, save } from '../lib/storage';

const LAST_DIR = 'files.dir';
const SHOW_HIDDEN = 'files.hidden';

function Row({ dir, e, now, onOpen }: { dir: string; e: FsEntry; now: number; onOpen: (path: string) => void }) {
  const full = joinPath(dir, e.name);
  const when = modified(e.mtime, now);
  if (e.kind === 'dir') {
    return (
      <button type="button" className="fs-row" onClick={() => onOpen(full)}>
        <Icon name="folder" size={18} className="fs-icon fs-dir" />
        <span className="fs-text">
          <span className="fs-name">{e.name}</span>
          <span className="fs-meta">{[e.link ? 'Link' : '', when].filter(Boolean).join(' · ')}</span>
        </span>
        <Icon name="chevron-right" size={16} className="chev" />
      </button>
    );
  }
  if (e.kind === 'file') {
    return (
      <a className="fs-row" href={downloadUrl(full)} download={e.name} aria-label={`Download ${e.name}`}>
        <Icon name="file" size={18} className="fs-icon" />
        <span className="fs-text">
          <span className="fs-name">{e.name}</span>
          <span className="fs-meta">{[e.link ? 'Link' : '', fileSize(e.size), when].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="fs-dl" aria-hidden="true">
          <Icon name="download" size={17} />
        </span>
      </a>
    );
  }
  return (
    <div className="fs-row fs-other">
      <Icon name="file" size={18} className="fs-icon" />
      <span className="fs-text">
        <span className="fs-name">{e.name}</span>
        <span className="fs-meta">{e.link ? 'Broken link' : 'Not a regular file'}</span>
      </span>
    </div>
  );
}

/**
 * The computer's files, read only: a path bar (type or paste a folder to open it, or a file to download it),
 * the path as tappable parts, then the folder: folders first, tap one to open it, tap a file to download it.
 * Starts in the last folder shown on this device, else the home folder.
 */
export function FilesScreen({ embedded = false }: { embedded?: boolean }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [problem, setProblem] = useState<FsProblem | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [hidden, setHidden] = useState(() => load<boolean>(SHOW_HIDDEN, false));
  const [typed, setTyped] = useState('');
  const [fetched, setFetched] = useState<FsFile | null>(null);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);
  const tapFocus = useTapFocus<HTMLInputElement>();
  const inputRef = useCallback(
    (el: HTMLInputElement | null) => {
      input.current = el;
      tapFocus(el);
    },
    [tapFocus],
  );
  const now = Date.now();
  const crumbBar = useRef<HTMLElement | null>(null);
  const shownPath = listing?.path;
  // The path's end (the folder shown) is what matters: keep the crumbs scrolled to it.
  useEffect(() => {
    const el = crumbBar.current;
    if (el && shownPath !== undefined) el.scrollLeft = el.scrollWidth;
  }, [shownPath]);

  const open = useCallback(async (target: string, opts: { hidden: boolean; fallback?: boolean; fromBar?: boolean }) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await lookup(target, { hidden: opts.hidden });
      if (mine !== seq.current) return;
      setProblem(null);
      if (r.kind === 'dir') {
        setListing(r);
        setFetched(null);
        setTyped(tildePath(r.path, r.home));
        save(LAST_DIR, r.path);
        if (opts.fromBar) input.current?.blur();
      } else {
        setFetched(r);
        if (r.downloadable) startDownload(r.path, r.name);
      }
    } catch (e) {
      if (mine !== seq.current) return;
      if (opts.fallback) {
        // The remembered folder is gone (or private now): the home folder instead.
        void openRef.current('~', { hidden: opts.hidden });
        return;
      }
      setFetched(null);
      setProblem(e instanceof FsProblem ? e : new FsProblem((e as Error).message, 'not-found'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const last = load<string | null>(LAST_DIR, null);
    void open(last ?? '~', { hidden: load<boolean>(SHOW_HIDDEN, false), fallback: last !== null });
  }, [open]);

  const go = (target: string) => void open(target, { hidden });
  const where = listing?.path ?? null;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = typedToPath(typed, where);
    void open(t === '' ? '~' : t, { hidden, fromBar: true });
  };

  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    save(SHOW_HIDDEN, next);
    if (where) void open(where, { hidden: next });
  };

  const loadMore = async () => {
    if (!listing || more) return;
    setMore(true);
    const mine = seq.current;
    try {
      const r = await lookup(listing.path, { hidden, offset: listing.offset + listing.entries.length });
      if (mine !== seq.current || r.kind !== 'dir') return;
      setListing({ ...r, offset: listing.offset, entries: [...listing.entries, ...r.entries] });
    } catch (e) {
      if (mine === seq.current) setProblem(e instanceof FsProblem ? e : null);
    } finally {
      setMore(false);
    }
  };

  // Tab completes the last part of the path from its folder (like a shell).
  const onKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Tab' || e.shiftKey || !typed) return;
    e.preventDefault();
    const cut = typed.lastIndexOf('/');
    const dirPart = cut >= 0 ? typed.slice(0, cut + 1) : '';
    const folder = typedToPath(dirPart || '.', where);
    const part = typed.slice(cut + 1);
    try {
      const r = await lookup(folder === '.' ? '~' : folder, { hidden: hidden || part.startsWith('.') });
      if (r.kind !== 'dir') return;
      const done = completeFrom(typed, r.entries);
      if (done) setTyped(done);
    } catch {}
  };

  const parts = listing ? crumbs(listing.path) : [];
  const shown = listing?.entries ?? [];
  const left = listing ? listing.total - listing.offset - shown.length : 0;

  const body = (
    <div className="fs-page">
      <div className="fs-bar">
        <form className="fs-path" onSubmit={submit}>
          <label className="field">
            <Icon name="folder" size={16} />
            <input
              ref={inputRef}
              type="text"
              inputMode="url"
              enterKeyHint="go"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="Type or paste a path"
              aria-label="Path"
              value={typed}
              maxLength={4096}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <button type="submit" className="btn btn-small fs-go" disabled={loading}>
            {loading ? <Icon name="spinner" size={14} spin /> : 'Go'}
          </button>
        </form>
        <div className="fs-tools">
          <button
            type="button"
            className="icon-btn sm"
            aria-label="Up one folder"
            title="Up one folder"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && go(listing.parent)}
          >
            <Icon name="arrow-up" size={17} />
          </button>
          <button type="button" className="icon-btn sm" aria-label="Home folder" title="Home folder" onClick={() => go('~')}>
            <Icon name="home" size={16} />
          </button>
          <nav ref={crumbBar} className="fs-crumbs" aria-label="Folders in the path">
            {parts.map((c, i) => (
              <span key={c.path} className="fs-crumb-wrap">
                {i > 1 && <Icon name="chevron-right" size={12} className="fs-sep" />}
                <button
                  type="button"
                  className={`fs-crumb${i === parts.length - 1 ? ' on' : ''}`}
                  aria-current={i === parts.length - 1 ? 'page' : undefined}
                  onClick={() => go(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
          <button
            type="button"
            className={`fs-hidden${hidden ? ' on' : ''}`}
            aria-pressed={hidden}
            title="Show hidden files"
            onClick={toggleHidden}
          >
            <Icon name={hidden ? 'eye' : 'eye-off'} size={15} />
            <span>Hidden</span>
          </button>
        </div>
      </div>
      <div className={`scroll fs-list${loading ? ' loading' : ''}`}>
        {fetched && (
          <div className="fs-notice" role="status">
            <Icon name={fetched.downloadable ? 'download' : 'ban'} size={16} />
            {fetched.downloadable ? (
              <>
                <span className="fs-notice-text">
                  Downloading <b>{fetched.name}</b> · {fileSize(fetched.size)}
                </span>
                <a className="link-btn" href={downloadUrl(fetched.path)} download={fetched.name}>
                  Again
                </a>
              </>
            ) : (
              <span className="fs-notice-text">
                <b>{fetched.name}</b> isn’t a regular file, so it can’t be downloaded
              </span>
            )}
          </div>
        )}
        {problem ? (
          <div className="state-card">
            <Icon
              name={problem.code === 'not-found' || problem.code === 'bad-path' ? 'alert' : problem.code === 'offline' ? 'offline' : 'ban'}
              size={22}
            />
            <h3>
              {problem.code === 'denied'
                ? 'Permission denied'
                : problem.code === 'private'
                  ? 'Private'
                  : problem.code === 'not-found'
                    ? 'Not found'
                    : problem.code === 'offline'
                      ? 'Offline'
                      : 'Can’t open that'}
            </h3>
            <p>{problem.message}</p>
            <button type="button" className="btn btn-small" onClick={() => go(where ?? '~')}>
              {where ? 'Back to the folder' : 'Home folder'}
            </button>
          </div>
        ) : !listing ? (
          <div className="ns-hint ns-loading">
            <Icon name="spinner" size={14} spin /> Loading…
          </div>
        ) : shown.length === 0 ? (
          <div className="state-card">
            <Icon name="folder-open" size={22} />
            <h3>Empty folder</h3>
            {listing.hidden > 0 && (
              <>
                <p>{listing.hidden === 1 ? '1 hidden item' : `${listing.hidden} hidden items`}</p>
                <button type="button" className="btn btn-small" onClick={toggleHidden}>
                  Show hidden files
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="list-card fs-entries">
              {shown.map((e) => (
                <Row key={e.name} dir={listing.path} e={e} now={now} onOpen={go} />
              ))}
            </div>
            {left > 0 && (
              <button type="button" className="btn btn-small fs-more" onClick={loadMore} disabled={more}>
                {more ? <Icon name="spinner" size={14} spin /> : null}
                Show {Math.min(left, 500)} more of {left}
              </button>
            )}
            <p className="fs-foot">
              {listing.total === 1 ? '1 item' : `${listing.total} items`}
              {listing.hidden > 0 && ` · ${listing.hidden} hidden`}
              {listing.truncated && ' · very large folder: only the first ones are listed'}
            </p>
          </>
        )}
      </div>
    </div>
  );
  if (embedded) return <div className="main-page">{body}</div>;
  return (
    <Screen
      className="fs-screen"
      bar={
        <header className="topbar">
          <BackButton onClick={() => back({ name: 'spaces' })} />
          <span className="topbar-title">Files</span>
        </header>
      }
    >
      {body}
    </Screen>
  );
}
