import { type ReactNode, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusVisible } from '../hooks/dom';

/**
 * The layer every sheet sits on: a backdrop on <body> (a sheet inside a bar or a transformed box would be clipped
 * or shifted) sized to the visual viewport like .app (--vvh / --vv-top, see lib/viewport.ts), so a bottom sheet
 * rides above the phone keyboard while one of its fields has focus and is back at the bottom once it closes.
 * A tap on the backdrop itself dismisses.
 */
export function SheetLayer({ className, onDismiss, children }: { className?: string; onDismiss: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusVisible(box);
  return createPortal(
    <div
      ref={box}
      className={`sheet-backdrop${className ? ` ${className}` : ''}`}
      role="presentation"
      onPointerDown={(e) => e.target === e.currentTarget && onDismiss()}
    >
      {children}
    </div>,
    document.body,
  );
}
