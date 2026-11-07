import { useEffect, useRef, useState } from 'react';
import type { TerminalApi } from '../terminal/TerminalPane';
import { READABLE, type Zoom } from '../terminal/zoom';
import { Icon } from './Icon';

export type View = 'terminal' | 'conversation';

/** Terminal / Conversation. `compact`: icons only (a phone held sideways puts it in the top bar). */
export function ViewSwitch({ view, onPick, compact = false }: { view: View; onPick: (v: View) => void; compact?: boolean }) {
  const tab = (v: View, icon: 'terminal' | 'message', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      aria-label={label}
      title={label}
      className={view === v ? 'on' : ''}
      onClick={() => onPick(v)}
    >
      <Icon name={icon} size={14} />
      {!compact && <span>{label}</span>}
    </button>
  );
  return (
    <div className={`segmented${compact ? ' compact' : ''}`} role="tablist" aria-label="View">
      {tab('terminal', 'terminal', 'Terminal')}
      {tab('conversation', 'message', 'Conversation')}
    </div>
  );
}

export const zoomLabel = (z: Zoom | undefined, font: number | undefined): string =>
  !z || z.mode === 'auto' ? 'Auto' : z.mode === 'fit' ? 'Fit' : `${Math.round(font ?? 14)}px`;

/** The text size button and its menu: auto (readable, pans), fit (the whole grid), or a size. */
export function ZoomButton({ zoom, api }: { zoom: { z: Zoom; font: number } | null; api: TerminalApi | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const mode = zoom?.z.mode ?? 'auto';
  const font = zoom?.font ?? READABLE;
  return (
    <div className="zoom" ref={box}>
      <button
        type="button"
        className={`tool-btn zoom-btn${open ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Text size: ${zoomLabel(zoom?.z, font)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="text-size" size={16} />
        <span className="zoom-label">{zoomLabel(zoom?.z, font)}</span>
      </button>
      {open && (
        <div className="menu zoom-menu" role="menu">
          <div className="menu-label">Text size</div>
          <div className="zoom-steps">
            <button type="button" className="tool-btn" aria-label="Smaller" onClick={() => api?.step(-1)}>
              <Icon name="minus" size={16} />
            </button>
            <span className="zoom-size">{Math.round(font * 10) / 10} px</span>
            <button type="button" className="tool-btn" aria-label="Bigger" onClick={() => api?.step(1)}>
              <Icon name="plus" size={16} />
            </button>
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === 'auto'}
            className={`menu-item${mode === 'auto' ? ' on' : ''}`}
            onClick={() => {
              api?.setZoom({ mode: 'auto' });
              setOpen(false);
            }}
          >
            <span className="menu-item-text">
              <span>Auto</span>
              <span className="menu-hint">Readable; pans sideways with the cursor</span>
            </span>
            {mode === 'auto' && <Icon name="check" size={15} />}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === 'fit'}
            className={`menu-item${mode === 'fit' ? ' on' : ''}`}
            onClick={() => {
              api?.setZoom({ mode: 'fit' });
              setOpen(false);
            }}
          >
            <span className="menu-item-text">
              <span>Fit</span>
              <span className="menu-hint">The whole terminal at once (double tap)</span>
            </span>
            {mode === 'fit' && <Icon name="check" size={15} />}
          </button>
        </div>
      )}
    </div>
  );
}
