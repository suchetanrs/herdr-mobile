import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { copyText } from '../lib/copy';
import { load, save } from '../lib/storage';
import { Icon } from './Icon';
import { SheetLayer } from './Sheet';

/**
 * The terminal's text (scrollback + screen) as plain, selectable text: select a part with the
 * phone's own handles, or copy it all. Wrapped to the phone's width, so long lines read without
 * panning. A snapshot: reopen it for newer output.
 */
export function TextSheet({ title, read, onClose }: { title: string; read: () => string; onClose: () => void }) {
  const [text, setText] = useState(read);
  const [wrap, setWrap] = useState(() => load<boolean>('textWrap', true));
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: to the end on open and refresh.
  useLayoutEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <SheetLayer onDismiss={onClose}>
      <div className="sheet text-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-head">
          <span className="sheet-title">{title}</span>
          <span className="spacer" />
          <button
            type="button"
            className={`tool-btn${wrap ? ' on' : ''}`}
            aria-pressed={wrap}
            aria-label="Wrap long lines"
            title="Wrap long lines"
            onClick={() => {
              save('textWrap', !wrap);
              setWrap(!wrap);
            }}
          >
            <Icon name="wrap-text" size={16} />
          </button>
          <button type="button" className="tool-btn" aria-label="Refresh" title="Newer output" onClick={() => setText(read())}>
            <Icon name="refresh" size={16} />
          </button>
          <button
            type="button"
            className="btn btn-small sheet-copy"
            onClick={async () => {
              const sel = window.getSelection()?.toString();
              if (await copyText(sel && pre.current?.contains(window.getSelection()?.anchorNode ?? null) ? sel : text)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="tool-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>
        <pre ref={pre} className={`text-sheet-pre${wrap ? ' wrap' : ''}`}>
          {text || 'Nothing on the screen yet.'}
        </pre>
        <footer className="sheet-foot">Copy takes the selection, or everything when nothing is selected.</footer>
      </div>
    </SheetLayer>
  );
}
