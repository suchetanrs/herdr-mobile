import { unreadSeenTurn } from '@herdr-mobile/protocol';
import { useEffect, useState } from 'react';
import { useServices, useWorld } from '../hooks/app';
import { watchLongPress } from '../lib/longpress';
import { Icon } from './Icon';

const WIDTH = 200;
const HEIGHT = 62;

/**
 * Hold an agent row (or right-click it): "Mark as unread". The bridge lowers its `herdr.seen` to
 * turn - 1, so it shows done here, on Herdr desktop and on every other phone. Rows opt in with
 * `data-press={unreadId(t)}`.
 */
export function UnreadMenu() {
  const { conn } = useServices();
  const world = useWorld();
  const [at, setAt] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => watchLongPress(document, (id, x, y) => setAt({ id, x, y })), []);
  useEffect(() => {
    if (!at) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAt(null);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [at]);
  const t = at ? world.terminals[at.id] : undefined;
  if (!at || !t || unreadSeenTurn(t) === null) return null;
  // Below the finger (so it isn't under it), kept on screen.
  const left = Math.max(8, Math.min(at.x - WIDTH / 2, window.innerWidth - WIDTH - 8));
  const top = at.y + 12 + HEIGHT < window.innerHeight - 8 ? at.y + 12 : Math.max(8, at.y - 12 - HEIGHT);
  return (
    <div className="unread-backdrop" role="presentation" onPointerDown={(e) => e.target === e.currentTarget && setAt(null)}>
      <div className="menu unread-menu" role="menu" style={{ left, top, width: WIDTH }}>
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() => {
            conn.send({ t: 'unread', terminalId: t.id });
            setAt(null);
          }}
        >
          <Icon name="mail" size={16} />
          <span className="menu-item-text">Mark as unread</span>
        </button>
      </div>
    </div>
  );
}

/** The row's `data-press` value: its id when it can be marked unread, else nothing (no long press). */
export function unreadId(t: Parameters<typeof unreadSeenTurn>[0] & { id: string }): string | undefined {
  return unreadSeenTurn(t) === null ? undefined : t.id;
}
