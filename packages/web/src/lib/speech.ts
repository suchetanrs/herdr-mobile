import { load, save } from './storage';

/**
 * Read aloud with the browser's speechSynthesis, one utterance per sentence. The browsers' own pause()/resume()
 * are never used (unreliable on Android Chrome): pause = cancel() and keep the index, resume = speak that sentence
 * again, previous/next = cancel and speak the one before/after. Short utterances also stay clear of Chrome's
 * ~15 s cutoff. iOS only starts speech from a tap, so start()/play()/prev()/next() must be called inside one,
 * synchronously.
 */

export const RATES = [1, 1.25, 1.5, 2] as const;
/** Longer sentences are cut (at a comma, else a space) so no utterance runs long. */
const MAX_CHUNK = 220;
const SPEAKABLE = /[\p{L}\p{N}]/u;

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

export function pageLang(): string | undefined {
  return (typeof document !== 'undefined' && document.documentElement.lang) || undefined;
}

type SegmenterCtor = new (locale?: string, opts?: { granularity: 'sentence' }) => { segment(s: string): Iterable<{ segment: string }> };

function segment(text: string, locale: string | undefined): string[] {
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (typeof Seg === 'function') {
    try {
      return Array.from(new Seg(locale, { granularity: 'sentence' }).segment(text), (s) => s.segment);
    } catch {
      // fall through
    }
  }
  // Fallback: end of sentence = . ! ? … (and closing quotes/brackets) followed by a space.
  const out: string[] = [];
  const end = /[.!?…]+["'”’)\]]*\s+/g;
  let from = 0;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    out.push(text.slice(from, m.index + m[0].length));
    from = m.index + m[0].length;
  }
  out.push(text.slice(from));
  return out;
}

function chunk(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_CHUNK) {
    const head = rest.slice(0, MAX_CHUNK);
    let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' – '));
    if (cut < MAX_CHUNK / 3) cut = head.lastIndexOf(' ');
    if (cut < MAX_CHUNK / 3) cut = MAX_CHUNK - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Plain text (blocks separated by blank lines) -> the sentences to speak, in order, none empty. */
export function splitSentences(text: string, locale = pageLang()): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const flat = block.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    for (const s of segment(flat, locale)) {
      for (const c of chunk(s.trim())) if (SPEAKABLE.test(c)) out.push(c);
    }
  }
  return out;
}

export interface SpeechState {
  /** The terminal whose conversation is loaded. */
  owner: string | null;
  /** What is loaded (a reply's id); null = no player. */
  key: string | null;
  sentences: readonly string[];
  index: number;
  playing: boolean;
  /** Read to the end (play starts over). */
  ended: boolean;
  rate: number;
  /** voiceURI picked in Settings; null = the platform default for the page language. */
  voice: string | null;
}

type Synth = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices' | 'speaking' | 'pending'>;

export interface SpeechEnv {
  synth(): Synth | undefined;
  utterance(): typeof SpeechSynthesisUtterance | undefined;
  lang(): string | undefined;
}

const browserEnv: SpeechEnv = {
  synth: () => (speechSupported() ? window.speechSynthesis : undefined),
  utterance: () => (speechSupported() ? window.SpeechSynthesisUtterance : undefined),
  lang: pageLang,
};

const EMPTY = { owner: null, key: null, sentences: [], index: 0, playing: false, ended: false } as const;

export class SpeechPlayer {
  private state: SpeechState;
  private readonly listeners = new Set<() => void>();
  /** Bumped on every cancel: events from older utterances are ignored. */
  private gen = 0;
  /** Held so the utterance isn't collected before its end event (Chrome). */
  current: SpeechSynthesisUtterance | null = null;

  constructor(private readonly env: SpeechEnv = browserEnv) {
    const rate = load<number>('speech.rate', 1);
    this.state = {
      ...EMPTY,
      rate: (RATES as readonly number[]).includes(rate) ? rate : 1,
      voice: load<string | null>('speech.voice', null),
    };
  }

  get = (): SpeechState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Load a reply and read it from its first sentence. */
  start(owner: string, key: string, sentences: readonly string[]): void {
    this.halt();
    this.set({ owner, key, sentences, index: 0, playing: false, ended: sentences.length === 0 });
    if (sentences.length > 0) this.speakAt(0);
  }

  play(): void {
    const s = this.state;
    if (s.key === null || s.sentences.length === 0) return;
    this.speakAt(s.ended ? 0 : s.index);
  }

  pause(): void {
    if (!this.state.playing) return;
    this.halt();
    this.set({ playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  next(): void {
    const s = this.state;
    if (s.key === null || s.sentences.length === 0) return;
    if (s.index + 1 >= s.sentences.length) {
      this.halt();
      this.set({ playing: false, ended: true });
    } else this.speakAt(s.index + 1);
  }

  prev(): void {
    const s = this.state;
    if (s.key === null || s.sentences.length === 0) return;
    this.speakAt(s.ended ? s.sentences.length - 1 : Math.max(0, s.index - 1));
  }

  setRate(rate: number): void {
    save('speech.rate', rate);
    this.set({ rate });
    if (this.state.playing) this.speakAt(this.state.index);
  }

  setVoice(voice: string | null): void {
    save('speech.voice', voice);
    this.set({ voice });
  }

  /** Stop and drop the player. */
  close(): void {
    this.halt();
    this.set({ ...EMPTY });
  }

  /** The screen changed or the page was hidden: stop, but stay loaded (paused, resumable at the same sentence). */
  suspend(owner?: string): void {
    if (owner === undefined || this.state.owner === owner) this.pause();
  }

  /** Settings' Test: one utterance with the chosen voice and speed (pauses the player). */
  sample(text: string): void {
    this.pause();
    this.halt();
    const u = this.utterance(text);
    if (!u) return;
    this.current = u;
    this.env.synth()?.speak(u);
  }

  /** The chosen voice, if this device has it (iOS fills getVoices() late; until then the default is used). */
  voice(): SpeechSynthesisVoice | null {
    const uri = this.state.voice;
    if (!uri) return null;
    return (
      this.env
        .synth()
        ?.getVoices()
        .find((v) => v.voiceURI === uri) ?? null
    );
  }

  private utterance(text: string): SpeechSynthesisUtterance | null {
    const U = this.env.utterance();
    if (!U || !this.env.synth()) return null;
    const u = new U(text);
    u.rate = this.state.rate;
    const v = this.voice();
    const lang = this.env.lang();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else if (lang) u.lang = lang;
    return u;
  }

  private halt(): void {
    this.gen++;
    this.current = null;
    const synth = this.env.synth();
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
  }

  private speakAt(i: number): void {
    this.halt();
    const text = this.state.sentences[i];
    const u = text === undefined ? null : this.utterance(text);
    if (!u) {
      this.set({ index: i, playing: false });
      return;
    }
    const gen = this.gen;
    u.onend = () => {
      if (gen !== this.gen) return;
      this.current = null;
      if (i + 1 < this.state.sentences.length) this.speakAt(i + 1);
      else this.set({ playing: false, ended: true });
    };
    u.onerror = () => {
      if (gen !== this.gen) return;
      this.current = null;
      this.set({ playing: false });
    };
    this.current = u;
    this.set({ index: i, playing: true, ended: false });
    this.env.synth()?.speak(u);
  }

  private set(patch: Partial<SpeechState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

export const speech = new SpeechPlayer();

/** Calls back whenever this device's voice list changes (it loads late, and on iOS sometimes without the event). */
export function watchVoices(onChange: (voices: SpeechSynthesisVoice[]) => void): () => void {
  if (!speechSupported()) return () => {};
  const synth = window.speechSynthesis;
  const read = () => onChange(synth.getVoices());
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => {
    read();
    if (synth.getVoices().length === 0 && tries++ < 20) timer = setTimeout(poll, 250);
  };
  poll();
  synth.addEventListener?.('voiceschanged', read);
  return () => {
    clearTimeout(timer);
    synth.removeEventListener?.('voiceschanged', read);
  };
}
