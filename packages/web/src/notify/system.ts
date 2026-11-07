import type { AttentionAlert } from '@herdr-mobile/protocol';
import { settings } from '../lib/settings';
import type { AlertContext, ClientNotifier } from './notifier';

/** System notifications need a secure context (HTTPS, or http://localhost). */
export function systemNotificationsPossible(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window;
}

export function systemPermission(): NotificationPermission | 'unavailable' {
  return systemNotificationsPossible() ? Notification.permission : 'unavailable';
}

export async function askSystemPermission(): Promise<NotificationPermission | 'unavailable'> {
  if (!systemNotificationsPossible()) return 'unavailable';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function agentUrl(terminalId: string): string {
  return `/#/a/${encodeURIComponent(terminalId)}`;
}

/**
 * The Notification API, for when the page isn't in front. Uses the service
 * worker's `showNotification` when one is registered (required on Android,
 * and where Web Push will land later), else `new Notification`.
 */
export class SystemSink implements ClientNotifier {
  readonly name = 'system';
  constructor(private readonly open: (terminalId: string) => void) {}

  async notify(alert: AttentionAlert, ctx: AlertContext): Promise<void> {
    if (!settings.get().desktop || systemPermission() !== 'granted') return;
    if (ctx.visible) return;
    const options: NotificationOptions = {
      body: alert.body ?? undefined,
      tag: `herdr-${alert.terminalId}`,
      icon: '/app/icon-192.png',
      badge: '/app/badge-96.png',
      data: { url: agentUrl(alert.terminalId), terminalId: alert.terminalId },
    };
    const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
    if (reg) {
      await reg.showNotification(alert.title, options);
      return;
    }
    const n = new Notification(alert.title, options);
    n.onclick = () => {
      window.focus();
      this.open(alert.terminalId);
      n.close();
    };
  }
}
