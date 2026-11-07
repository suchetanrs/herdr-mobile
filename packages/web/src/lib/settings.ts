import { load, save } from './storage';

export interface Settings {
  /** Herdr's alert sounds (request.mp3 / done.mp3). */
  sounds: boolean;
  /** Buzz on alerts where the phone allows it. */
  vibrate: boolean;
  /** System notifications (only offered in a secure context). */
  desktop: boolean;
  /** The composer's send button presses Enter after the text. */
  sendEnter: boolean;
  /** Herdr's theme: graphite (dark, the default), paper (light), or the system's. */
  theme: 'system' | 'dark' | 'light';
  /** The theme was picked in Settings (only then does a stored theme count). */
  themePicked?: boolean;
  /** How terminals open: readable text that pans sideways (auto), or the whole width (fit). */
  termZoom: 'auto' | 'fit';
  /** The tab an agent with a transcript opens on (a tab picked for one agent wins). */
  agentView: 'conversation' | 'terminal';
  /** Conversation text size, px. */
  chatFont: number;
}

const DEFAULTS: Settings = {
  sounds: true,
  vibrate: true,
  desktop: true,
  sendEnter: true,
  theme: 'dark',
  termZoom: 'auto',
  agentView: 'conversation',
  chatFont: 15,
};

/**
 * Settings from what this device stored. Before dark became the default, every save wrote the then-default
 * theme 'system' with the rest; a stored theme without `themePicked` is that, not a choice, so it's dropped.
 * ('dark'/'light' were only ever stored by picking them.)
 */
export function resolveSettings(stored: Partial<Settings>): Settings {
  const s = { ...stored };
  if (s.theme === 'system' && !s.themePicked) delete s.theme;
  return { ...DEFAULTS, ...s };
}

type Listener = () => void;

/** Per-device preferences, kept in localStorage. */
class SettingsStore {
  private value: Settings = resolveSettings(load<Partial<Settings>>('settings', {}));
  private readonly listeners = new Set<Listener>();

  get = (): Settings => this.value;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch, ...(patch.theme ? { themePicked: true } : {}) };
    save('settings', this.value);
    for (const l of this.listeners) l();
  }
}

export const settings = new SettingsStore();
