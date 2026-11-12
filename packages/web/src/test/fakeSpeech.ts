/** A stand-in speechSynthesis that records utterances; finish()/fail() end the one being spoken. */
export class FakeUtterance {
  rate = 1;
  lang = '';
  voice: { voiceURI: string; lang: string } | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

export class FakeSynth {
  spoken: FakeUtterance[] = [];
  cancels = 0;
  speaking = false;
  pending = false;
  voices: Array<{ voiceURI: string; name: string; lang: string; localService: boolean; default: boolean }> = [];
  private current: FakeUtterance | null = null;

  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.current = u;
    this.speaking = true;
  }

  cancel(): void {
    this.cancels++;
    const u = this.current;
    this.current = null;
    this.speaking = false;
    // Like Chrome: a cancelled utterance reports an error (and Safari an end).
    u?.onerror?.({ error: 'interrupted' });
    u?.onend?.();
  }

  getVoices() {
    return this.voices;
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  /** The utterance being spoken reaches its end. */
  finish(): void {
    const u = this.current;
    this.current = null;
    this.speaking = false;
    u?.onend?.();
  }

  fail(): void {
    const u = this.current;
    this.current = null;
    this.speaking = false;
    u?.onerror?.({ error: 'synthesis-failed' });
  }

  get texts(): string[] {
    return this.spoken.map((u) => u.text);
  }

  get last(): FakeUtterance | undefined {
    return this.spoken[this.spoken.length - 1];
  }
}
