import { type RefObject, useEffect, useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon';
import { RATES, type SpeechState, speech, speechSupported, splitSentences } from '../lib/speech';
import { markdownToSpeech } from './speechText';

export function useSpeech(): SpeechState {
  return useSyncExternalStore(speech.subscribe, speech.get);
}

/** The speaker next to a reply's copy button: reads that reply (or pauses/resumes it when it is the one loaded). */
export function SpeakButton({ owner, replyId, text }: { owner: string; replyId: string; text: string }) {
  const s = useSpeech();
  if (!speechSupported()) return null;
  const mine = s.key === replyId && s.owner === owner;
  const playing = mine && s.playing;
  return (
    <button
      type="button"
      className={`msg-act${mine ? ' on' : ''}`}
      aria-label={playing ? 'Pause reading' : 'Read the reply aloud'}
      title={playing ? 'Pause reading' : 'Read aloud'}
      aria-pressed={playing}
      onClick={() => {
        // Synchronous: iOS only lets speech start inside the tap.
        if (mine) speech.toggle();
        else speech.start(owner, replyId, splitSentences(markdownToSpeech(text)));
      }}
    >
      <Icon name={playing ? 'pause' : 'volume'} size={14} />
    </button>
  );
}

const rateLabel = (r: number) => `${r}×`;

/** The player docked under the conversation while a reply is loaded. */
export function SpeechDock({ s }: { s: SpeechState }) {
  const n = s.sentences.length;
  const text = n === 0 ? 'Nothing to read aloud in this reply (only code).' : (s.sentences[s.index] ?? '');
  const nextRate = RATES[(RATES.indexOf(s.rate as (typeof RATES)[number]) + 1) % RATES.length] ?? 1;
  return (
    <section className="speak-dock" aria-label="Read aloud">
      <div className="speak-now">
        <span className="speak-count">{n === 0 ? '' : s.ended ? 'Done' : `${s.index + 1} / ${n}`}</span>
        <span className="speak-text" aria-live="off">
          {text}
        </span>
      </div>
      <div className="speak-controls">
        <button type="button" className="speak-btn" aria-label="Previous sentence" disabled={n === 0} onClick={() => speech.prev()}>
          <Icon name="skip-back" size={18} />
        </button>
        <button
          type="button"
          className="speak-btn speak-play"
          aria-label={s.playing ? 'Pause' : 'Play'}
          disabled={n === 0}
          onClick={() => speech.toggle()}
        >
          <Icon name={s.playing ? 'pause' : 'play'} size={18} />
        </button>
        <button type="button" className="speak-btn" aria-label="Next sentence" disabled={n === 0} onClick={() => speech.next()}>
          <Icon name="skip-forward" size={18} />
        </button>
        <button
          type="button"
          className="speak-btn speak-rate"
          aria-label={`Reading speed ${rateLabel(s.rate)}`}
          title="Reading speed"
          onClick={() => speech.setRate(nextRate)}
        >
          {rateLabel(s.rate)}
        </button>
        <button type="button" className="speak-btn" aria-label="Close the player" onClick={() => speech.close()}>
          <Icon name="x" size={18} />
        </button>
      </div>
    </section>
  );
}

const WORD = /[\p{L}\p{N}]/u;

/** Letters and digits only, lower case, so markdown symbols, spacing and punctuation never break a match. */
function norm(s: string): string {
  let out = '';
  for (const ch of s) if (WORD.test(ch)) out += ch.toLowerCase();
  return out;
}

interface TextMap {
  text: string;
  /** For each char of `text`: its text node and offset. */
  at: Array<[Text, number]>;
}

/** The rendered reply's text, without code (it isn't spoken either). */
export function textMap(roots: readonly Element[]): TextMap {
  let text = '';
  const at: Array<[Text, number]> = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('pre, code, .md-code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const v = n.data;
      for (let i = 0; i < v.length; i++) {
        const ch = v[i] as string;
        if (!WORD.test(ch)) continue;
        for (const c of ch.toLowerCase()) {
          text += c;
          at.push([n, i]);
        }
      }
    }
  }
  return { text, at };
}

/** Where sentence `index` is in the rendered text: sentences are found in order; when one isn't found exactly
 * (a bare URL read as "link"), its first and last few letters are. */
export function sentenceRange(map: TextMap, sentences: readonly string[], index: number): Range | null {
  let from = 0;
  for (let i = 0; i <= index; i++) {
    const s = norm(sentences[i] ?? '');
    if (!s) continue;
    let start = map.text.indexOf(s, from);
    let end = start + s.length;
    if (start < 0) {
      // The longest head (and then tail) of the sentence, 3 to 12 letters, that is in the page.
      let k = Math.min(12, s.length);
      for (; k >= 3; k--) {
        start = map.text.indexOf(s.slice(0, k), from);
        if (start >= 0) break;
      }
      let tail = -1;
      let j = Math.min(12, s.length);
      for (; start >= 0 && j >= 3; j--) {
        tail = map.text.indexOf(s.slice(-j), start + k);
        if (tail >= 0) break;
      }
      if (start < 0 || tail < 0 || tail + j - start > s.length * 2 + 40) {
        if (i === index) return null;
        continue;
      }
      end = tail + j;
    }
    from = end;
    if (i === index) {
      const a = map.at[start];
      const b = map.at[end - 1];
      if (!a || !b) return null;
      const r = document.createRange();
      r.setStart(a[0], a[1]);
      // Through the closing punctuation (the map holds letters and digits only).
      let e = b[1] + 1;
      while (e < b[0].data.length && /[.!?…"'”’)\]]/.test(b[0].data[e] as string)) e++;
      r.setEnd(b[0], e);
      return r;
    }
  }
  return null;
}

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}
const registry = (): HighlightRegistry | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function'
    ? (CSS as unknown as { highlights: HighlightRegistry }).highlights
    : null;

/**
 * Marks the sentence being read in the reply (CSS Custom Highlight; where that's missing, its paragraph) and
 * scrolls it into view when it is out of sight.
 */
export function useSpeechHighlight(
  s: SpeechState,
  owner: string,
  list: RefObject<HTMLElement | null>,
  scroller: RefObject<HTMLElement | null>,
) {
  const active = s.owner === owner && s.key !== null && !s.ended && s.sentences.length > 0;
  const { key, index, sentences } = s;
  useEffect(() => {
    const root = list.current;
    if (!active || !root || key === null) return;
    const roots = Array.from(root.querySelectorAll(`[data-reply="${CSS.escape(key)}"] .md`));
    const range = sentenceRange(textMap(roots), sentences, index);
    if (!range) return;
    const reg = registry();
    let block: Element | null = null;
    if (reg) {
      const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
      reg.set('hm-speech', new H(range));
    } else {
      block = range.startContainer.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote') ?? null;
      block?.classList.add('speak-block');
    }
    const sc = scroller.current;
    if (sc && typeof range.getBoundingClientRect === 'function') {
      const r = range.getBoundingClientRect();
      const box = sc.getBoundingClientRect();
      if (r.top < box.top + 8 || r.bottom > box.bottom - 8) {
        sc.scrollTo({ top: sc.scrollTop + r.top - box.top - box.height / 3, behavior: 'smooth' });
      }
    }
    return () => {
      reg?.delete('hm-speech');
      block?.classList.remove('speak-block');
    };
  }, [active, key, index, sentences, list, scroller]);
}
