import { type ViewKind, viewableOf } from '@herdr-mobile/protocol';
import { type PointerEvent, useEffect, useRef, useState, type WheelEvent } from 'react';
import { Icon } from '../components/Icon';
import { Markdown } from '../conversation/Markdown';
import { downloadUrl, viewUrl } from '../lib/files';
import '../styles/conversation.css';

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;

/** Why a file can't be shown, with the way out (download). */
function CantShow({ path, name, text }: { path: string; name: string; text: string }) {
  return (
    <div className="state-card fv-cant">
      <Icon name="ban" size={22} />
      <h3>Can’t show this here</h3>
      <p>{text}</p>
      <a className="btn btn-small" href={downloadUrl(path)} download={name}>
        <Icon name="download" size={15} /> Download instead
      </a>
    </div>
  );
}

/** An image fitted to the screen: pinch (or ctrl+wheel) to zoom, drag to pan when zoomed, double-tap to toggle. */
function ZoomImage({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ d: number; s: number; x: number; y: number; px: number; py: number } | null>(null);
  const clamp = (s: number) => Math.min(8, Math.max(1, s));
  const fix = (n: { s: number; x: number; y: number }) => (n.s <= 1.01 ? { s: 1, x: 0, y: 0 } : n);
  const begin = () => {
    const p = [...pts.current.values()];
    const [a, b] = p;
    if (!a) return;
    const d = b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    const px = b ? (a.x + b.x) / 2 : a.x;
    const py = b ? (a.y + b.y) / 2 : a.y;
    start.current = { d, s: t.s, x: t.x, y: t.y, px, py };
  };
  const down = (e: PointerEvent) => {
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    begin();
  };
  const move = (e: PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = start.current;
    const [a, b] = [...pts.current.values()];
    if (!st || !a) return;
    if (b && st.d > 0) {
      const s = clamp((st.s * Math.hypot(a.x - b.x, a.y - b.y)) / st.d);
      const px = (a.x + b.x) / 2;
      const py = (a.y + b.y) / 2;
      setT({ s, x: st.x + px - st.px, y: st.y + py - st.py });
    } else if (!b && st.s > 1) {
      setT({ s: st.s, x: st.x + a.x - st.px, y: st.y + a.y - st.py });
    }
  };
  const up = (e: PointerEvent) => {
    pts.current.delete(e.pointerId);
    setT((n) => fix(n));
    begin();
  };
  const wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    setT((n) => fix({ ...n, s: clamp(n.s * Math.exp(-e.deltaY / 200)) }));
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pinch/pan surface for touch and mouse; the image has its alt text
    <div
      className="fv-stage"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onWheel={wheel}
      onDoubleClick={() => setT((n) => (n.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }))}
    >
      <img
        className="fv-img"
        src={src}
        alt={name}
        draggable={false}
        onError={onError}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})` }}
      />
    </div>
  );
}

/** A Markdown file, fetched as text and rendered like a conversation message (raw HTML shows as text). */
function MarkdownFile({ path, name }: { path: string; name: string }) {
  const [state, setState] = useState<{ text: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(viewUrl(path), { cache: 'no-store', credentials: 'same-origin' });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          if (live) setState({ error: body.error ?? `The bridge said ${r.status}` });
          return;
        }
        const text = await r.text();
        if (live) setState({ text });
      } catch {
        if (live) setState({ error: 'Can’t reach the bridge right now' });
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);
  if (!state)
    return (
      <div className="ns-hint ns-loading">
        <Icon name="spinner" size={14} spin /> Loading…
      </div>
    );
  if ('error' in state) return <CantShow path={path} name={name} text={state.error} />;
  return (
    <div className="scroll fv-doc">
      <Markdown text={state.text} className="fv-md" />
    </div>
  );
}

const MEDIA_ERROR = 'This browser can’t play it (an unsupported format or codec, e.g. ProRes or HEVC on some phones).';

function Body({ path, name, kind }: { path: string; name: string; kind: ViewKind }) {
  const [failed, setFailed] = useState(false);
  const src = viewUrl(path);
  if (failed)
    return (
      <CantShow
        path={path}
        name={name}
        text={kind === 'image' ? 'This browser can’t show this image format (HEIC shows on Apple devices only).' : MEDIA_ERROR}
      />
    );
  switch (kind) {
    case 'video':
      return (
        // biome-ignore lint/a11y/useMediaCaption: the person's own files have no caption tracks
        <video className="fv-media" src={src} controls playsInline preload="metadata" onError={() => setFailed(true)} />
      );
    case 'audio':
      return (
        <div className="fv-audio">
          <Icon name="file" size={40} />
          <span className="fv-audio-name">{name}</span>
          {/* biome-ignore lint/a11y/useMediaCaption: the person's own files have no caption tracks */}
          <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />
        </div>
      );
    case 'image':
      return <ZoomImage src={src} name={name} onError={() => setFailed(true)} />;
    case 'markdown':
      return <MarkdownFile path={path} name={name} />;
    case 'pdf':
      // The browser's own PDF viewer, framed (same origin, so the session cookie goes along; a new tab from the
      // home-screen app would open without it). Browsers without an inline viewer (Android Chrome) get links.
      return navigator.pdfViewerEnabled === false ? (
        <div className="state-card fv-cant">
          <Icon name="file" size={22} />
          <h3>{name}</h3>
          <p>This browser shows PDFs outside the app.</p>
          <div className="fv-actions">
            <a className="btn btn-small" href={src} target="_blank" rel="noopener">
              Open
            </a>
            <a className="btn btn-small" href={downloadUrl(path)} download={name}>
              <Icon name="download" size={15} /> Download
            </a>
          </div>
        </div>
      ) : (
        <iframe className="fv-frame" src={src} title={name} />
      );
  }
}

/**
 * A file shown full screen over the Files list: video and audio in the browser's own players (streamed in
 * ranges, so they seek), images fitted with pinch zoom, PDFs in the browser's viewer, Markdown rendered.
 * Close (or Back / swipe back) returns to the list.
 */
export function FileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const name = baseName(path);
  const kind = viewableOf(name)?.kind ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={`file-viewer fv-${kind ?? 'none'}`} role="dialog" aria-modal="true" aria-label={name}>
      <header className="topbar fv-bar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <Icon name="close" size={18} />
        </button>
        <span className="topbar-title fv-title">{name}</span>
        <a className="icon-btn fv-download" href={downloadUrl(path)} download={name} aria-label={`Download ${name}`} title="Download">
          <Icon name="download" size={18} />
        </a>
      </header>
      <div className="fv-body">
        {kind ? (
          <Body path={path} name={name} kind={kind} />
        ) : (
          <CantShow path={path} name={name} text="This kind of file opens by downloading it." />
        )}
      </div>
    </div>
  );
}
