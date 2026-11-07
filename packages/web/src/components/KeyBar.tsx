import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from 'react';
import { useTapGuard } from '../hooks/gestures';
import { TapTracker } from '../lib/tap';
import { Icon } from './Icon';

export type CtrlState = 'off' | 'once' | 'locked';

interface KeyDef {
  id: string;
  label: string;
  /** term.keys name. */
  key: string;
  title: string;
  repeat?: boolean;
  wide?: boolean;
}

// Tuned for agents (Moshi's bar): Claude's mode toggle (shift+tab), menus (arrows, enter), answers (y/n/1-3), stop (esc, ctrl+c).
const KEYS: KeyDef[] = [
  { id: 'esc', label: 'esc', key: 'esc', title: 'Escape' },
  { id: 'tab', label: 'tab', key: 'tab', title: 'Tab' },
  { id: 'stab', label: '⇧tab', key: 'shift+tab', title: 'Shift+Tab' },
  { id: 'cc', label: '^C', key: 'ctrl+c', title: 'Ctrl+C' },
  { id: 'up', label: '↑', key: 'up', title: 'Up', repeat: true },
  { id: 'down', label: '↓', key: 'down', title: 'Down', repeat: true },
  { id: 'left', label: '←', key: 'left', title: 'Left', repeat: true },
  { id: 'right', label: '→', key: 'right', title: 'Right', repeat: true },
  { id: 'enter', label: '⏎', key: 'enter', title: 'Enter', wide: true },
  { id: 'y', label: 'y', key: 'y', title: 'y' },
  { id: 'n', label: 'n', key: 'n', title: 'n' },
  { id: '1', label: '1', key: '1', title: '1' },
  { id: '2', label: '2', key: '2', title: '2' },
  { id: '3', label: '3', key: '3', title: '3' },
  { id: 'slash', label: '/', key: '/', title: 'Slash' },
  { id: 'bs', label: '⌫', key: 'backspace', title: 'Backspace', repeat: true },
];

/** Applies an armed Ctrl to a key name (only letters have a ctrl form). */
export function withCtrl(key: string, ctrl: CtrlState): string {
  return ctrl !== 'off' && /^[a-z]$/.test(key) ? `ctrl+${key}` : key;
}

/**
 * Quick keys under the composer: tap to press, hold arrows/backspace to
 * repeat. Ctrl is sticky: tap arms it for the next key, double tap locks it.
 * The bar scrolls sideways: a pan across it never presses a key.
 */
export function KeyBar({
  onKey,
  ctrl,
  onCtrl,
  onKeyboard,
  keyboardOn,
}: {
  onKey: (key: string) => void;
  ctrl: CtrlState;
  onCtrl: (next: CtrlState) => void;
  onKeyboard?: () => void;
  keyboardOn?: boolean;
}) {
  const lastCtrlTap = useRef(0);
  const taps = useRef(new TapTracker());
  const guard = useTapGuard<HTMLDivElement>();
  const repeat = useRef<{ delay: ReturnType<typeof setTimeout> | null; every: ReturnType<typeof setInterval> | null; fired: boolean }>({
    delay: null,
    every: null,
    fired: false,
  });
  const stop = useCallback(() => {
    if (repeat.current.delay) clearTimeout(repeat.current.delay);
    if (repeat.current.every) clearInterval(repeat.current.every);
    repeat.current = { delay: null, every: null, fired: false };
  }, []);
  useEffect(() => stop, [stop]);

  // A key fires when the finger lifts after a tap (moved < TAP_SLOP, the bar didn't scroll), never on the way
  // down: a sideways pan across the bar starts on a key. Arrows/backspace repeat after a still hold.
  const down = (k: KeyDef, e: ReactPointerEvent<HTMLButtonElement>) => {
    // Keep focus (and the phone keyboard) where it is.
    e.preventDefault();
    if (!e.isPrimary) return;
    stop();
    const bar = e.currentTarget.parentElement;
    taps.current.down(e.pointerId, e.clientX, e.clientY, bar?.scrollLeft ?? 0, performance.now());
    if (!k.repeat || !taps.current.pending) return;
    repeat.current.delay = setTimeout(() => {
      if (!taps.current.pending) return;
      repeat.current.fired = true;
      onKey(k.key);
      repeat.current.every = setInterval(() => onKey(k.key), 70);
    }, 380);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (taps.current.pending && !taps.current.move(e.pointerId, e.clientX, e.clientY)) stop();
  };
  const up = (k: KeyDef, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary) return;
    const held = repeat.current.fired;
    stop();
    const bar = e.currentTarget.parentElement;
    if (taps.current.up(e.pointerId, e.clientX, e.clientY, bar?.scrollLeft ?? 0) && !held) onKey(k.key);
  };
  const cancel = () => {
    taps.current.cancel();
    stop();
  };

  const tapCtrl = () => {
    const now = Date.now();
    if (now - lastCtrlTap.current < 320) onCtrl('locked');
    else onCtrl(ctrl === 'off' ? 'once' : 'off');
    lastCtrlTap.current = now;
  };

  return (
    <div
      ref={guard}
      className="keybar"
      role="toolbar"
      aria-label="Quick keys"
      onScroll={() => {
        taps.current.scrolled(performance.now());
        stop();
      }}
    >
      {onKeyboard && (
        <button
          type="button"
          className={`key key-icon${keyboardOn ? ' on' : ''}`}
          title="Type into the terminal"
          aria-label="Type into the terminal"
          aria-pressed={keyboardOn}
          onPointerDown={(e) => e.preventDefault()}
          onClick={onKeyboard}
        >
          <Icon name="keyboard" size={17} />
        </button>
      )}
      <button
        type="button"
        className={`key key-mod${ctrl !== 'off' ? ' on' : ''}${ctrl === 'locked' ? ' locked' : ''}`}
        title="Ctrl (tap: next key, double tap: lock)"
        aria-pressed={ctrl !== 'off'}
        onPointerDown={(e) => e.preventDefault()}
        onClick={tapCtrl}
      >
        ctrl
      </button>
      {KEYS.map((k) => (
        <button
          key={k.id}
          type="button"
          className={`key${k.wide ? ' key-wide' : ''}${k.id === 'cc' ? ' key-danger' : ''}`}
          title={k.title}
          aria-label={k.title}
          onPointerDown={(e) => down(k, e)}
          onPointerMove={move}
          onPointerUp={(e) => up(k, e)}
          onPointerCancel={cancel}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onKey(k.key);
            }
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
