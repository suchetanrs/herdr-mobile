// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSynth, FakeUtterance } from '../test/fakeSpeech';
import { SpeechPlayer, splitSentences } from './speech';

describe('splitSentences', () => {
  it('splits into sentences, one block at a time', () => {
    expect(splitSentences('Hello there. How are you? Fine!\n\nNew block.', 'en')).toEqual([
      'Hello there.',
      'How are you?',
      'Fine!',
      'New block.',
    ]);
  });

  it('keeps decimals and file names whole, drops pieces with nothing to say', () => {
    expect(splitSentences('Version 1.5 of main.ts is out.\n\n— ...', 'en')).toEqual(['Version 1.5 of main.ts is out.']);
  });

  it('cuts long sentences at a comma so no utterance runs long', () => {
    const long = `${'word '.repeat(30)}and then, ${'more '.repeat(40)}end.`;
    const parts = splitSentences(long, 'en');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(220);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  describe('without Intl.Segmenter', () => {
    const Seg = (Intl as { Segmenter?: unknown }).Segmenter;
    beforeEach(() => {
      (Intl as { Segmenter?: unknown }).Segmenter = undefined;
    });
    afterEach(() => {
      (Intl as { Segmenter?: unknown }).Segmenter = Seg;
    });
    it('falls back to punctuation followed by a space', () => {
      expect(splitSentences('One 1.5 two. "Three?" Four… five', 'en')).toEqual(['One 1.5 two.', '"Three?"', 'Four…', 'five']);
    });
  });
});

describe('SpeechPlayer', () => {
  let synth: FakeSynth;
  let p: SpeechPlayer;
  const S = ['One.', 'Two.', 'Three.'];
  beforeEach(() => {
    localStorage.clear();
    synth = new FakeSynth();
    p = new SpeechPlayer({
      synth: () => synth as unknown as SpeechSynthesis,
      utterance: () => FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
      lang: () => 'en',
    });
  });

  it('speaks one utterance per sentence, in order, then ends', () => {
    p.start('t1', 'r1', S);
    expect(synth.texts).toEqual(['One.']);
    expect(p.get()).toMatchObject({ owner: 't1', key: 'r1', index: 0, playing: true });
    synth.finish();
    synth.finish();
    expect(synth.texts).toEqual(['One.', 'Two.', 'Three.']);
    synth.finish();
    expect(p.get()).toMatchObject({ playing: false, ended: true });
    // Play after the end starts over.
    p.play();
    expect(synth.last?.text).toBe('One.');
  });

  it('pause cancels and keeps the sentence; resume speaks that sentence again (never the native pause)', () => {
    p.start('t1', 'r1', S);
    synth.finish();
    p.pause();
    expect(synth.cancels).toBe(1);
    // The cancelled utterance's own error/end events change nothing.
    expect(p.get()).toMatchObject({ index: 1, playing: false });
    expect(synth.texts).toEqual(['One.', 'Two.']);
    p.play();
    expect(synth.texts).toEqual(['One.', 'Two.', 'Two.']);
    expect(p.get().playing).toBe(true);
  });

  it('next and previous cancel and speak the neighbour; previous stops at the first, next past the last ends', () => {
    p.start('t1', 'r1', S);
    p.next();
    expect(synth.last?.text).toBe('Two.');
    p.prev();
    p.prev();
    expect(synth.texts).toEqual(['One.', 'Two.', 'One.', 'One.']);
    p.next();
    p.next();
    p.next();
    expect(p.get()).toMatchObject({ index: 2, playing: false, ended: true });
    p.prev();
    expect(synth.last?.text).toBe('Three.');
  });

  it('speed applies to the next utterance and restarts the current sentence at the new speed; it is remembered', () => {
    p.start('t1', 'r1', S);
    p.setRate(1.5);
    expect(synth.texts).toEqual(['One.', 'One.']);
    expect(synth.last?.rate).toBe(1.5);
    synth.finish();
    expect(synth.last?.rate).toBe(1.5);
    expect(localStorage.getItem('hm.speech.rate')).toBe('1.5');
    p.pause();
    p.setRate(2);
    expect(synth.spoken).toHaveLength(3);
  });

  it('suspend (screen change, page hidden) pauses only its own conversation; close drops the player', () => {
    p.start('t1', 'r1', S);
    p.suspend('t2');
    expect(p.get().playing).toBe(true);
    p.suspend('t1');
    expect(p.get()).toMatchObject({ playing: false, index: 0, key: 'r1' });
    p.play();
    expect(synth.last?.text).toBe('One.');
    p.close();
    expect(p.get()).toMatchObject({ key: null, owner: null, playing: false });
  });

  it('a new reply replaces the old one; a synthesis error stops (paused)', () => {
    p.start('t1', 'r1', S);
    p.start('t1', 'r2', ['Other.']);
    expect(p.get()).toMatchObject({ key: 'r2', index: 0 });
    expect(synth.last?.text).toBe('Other.');
    synth.fail();
    expect(p.get().playing).toBe(false);
  });

  it('uses the chosen voice when this device has it, else the page language', () => {
    synth.voices = [{ voiceURI: 'v-good', name: 'Good', lang: 'en-GB', localService: true, default: false }];
    p.start('t1', 'r1', S);
    expect(synth.last).toMatchObject({ voice: null, lang: 'en' });
    p.setVoice('v-good');
    p.play();
    expect(synth.last).toMatchObject({ lang: 'en-GB' });
    expect(synth.last?.voice?.voiceURI).toBe('v-good');
    expect(localStorage.getItem('hm.speech.voice')).toBe('"v-good"');
    p.setVoice('v-missing');
    p.play();
    expect(synth.last).toMatchObject({ lang: 'en' });
  });

  it('a reply with nothing to say loads ended, and Test speaks once without touching the queue', () => {
    p.start('t1', 'r1', []);
    expect(synth.spoken).toHaveLength(0);
    expect(p.get()).toMatchObject({ key: 'r1', ended: true });
    p.play();
    p.next();
    expect(synth.spoken).toHaveLength(0);
    p.sample('Test.');
    expect(synth.texts).toEqual(['Test.']);
  });
});
