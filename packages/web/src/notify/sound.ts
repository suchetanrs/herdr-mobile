import type { AttentionAlert } from '@herdr-mobile/protocol';
import { settings } from '../lib/settings';
import type { ClientNotifier } from './notifier';

/** Herdr's alert sounds: request.mp3 when an agent needs you, done.mp3 when one finishes (window.rs `alert`). */
export class SoundSink implements ClientNotifier {
  readonly name = 'sound';
  private readonly audio = new Map<string, HTMLAudioElement>();
  private unlocked = false;

  constructor(private readonly base = '/sounds/') {
    if (typeof window === 'undefined') return;
    // Browsers only play sound after the person touched the page once: warm the players up on the first touch.
    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      for (const a of this.players()) {
        a.muted = true;
        a.play()
          .then(() => {
            a.pause();
            a.currentTime = 0;
            a.muted = false;
          })
          .catch(() => {
            a.muted = false;
          });
      }
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  private players(): HTMLAudioElement[] {
    return ['request', 'done'].map((n) => this.player(n));
  }

  private player(name: string): HTMLAudioElement {
    let a = this.audio.get(name);
    if (!a) {
      a = new Audio(`${this.base}${name}.mp3`);
      a.preload = 'auto';
      this.audio.set(name, a);
    }
    return a;
  }

  async notify(alert: AttentionAlert): Promise<void> {
    if (!settings.get().sounds) return;
    const a = this.player(alert.kind === 'blocked' ? 'request' : 'done');
    a.currentTime = 0;
    await a.play().catch(() => {
      // Not allowed yet (no touch since the page loaded): the toast still shows.
    });
  }
}

/** A short buzz where the phone allows it (Android; iOS has no Vibration API). */
export class VibrateSink implements ClientNotifier {
  readonly name = 'vibrate';
  notify(alert: AttentionAlert): void {
    if (!settings.get().vibrate || typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
    try {
      navigator.vibrate(alert.kind === 'blocked' ? [90, 70, 90] : 60);
    } catch {
      // Not allowed without a recent touch.
    }
  }
}
