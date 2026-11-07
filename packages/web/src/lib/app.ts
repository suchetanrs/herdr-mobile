import { ConversationClient } from '../conversation/client';
import { AttentionBadge } from '../notify/badge';
import { ClientNotifierHub } from '../notify/notifier';
import { SoundSink, VibrateSink } from '../notify/sound';
import { SystemSink } from '../notify/system';
import { ToastSink, ToastStore } from '../notify/toasts';
import { TerminalClient } from '../terminal/streams';
import { checkSession, wsUrl } from './auth';
import { Connection } from './connection';
import { LookingTracker } from './looking';
import { attentionCounts } from './model';
import { navigate } from './router';
import { AppStore } from './store';

/** The page's services, wired once. Components reach them through hooks (hooks/app.ts). */
export interface Services {
  store: AppStore;
  conn: Connection;
  terminals: TerminalClient;
  conversations: ConversationClient;
  looking: LookingTracker;
  toasts: ToastStore;
  notifier: ClientNotifierHub;
}

export function createServices(): Services {
  const store = new AppStore();
  let terminals: TerminalClient | null = null;
  const conn = new Connection({
    store,
    url: () => wsUrl(),
    checkAuth: () => checkSession(),
    onBinary: (stream, data) => terminals?.onBinary(stream, data),
  });
  terminals = new TerminalClient(conn, store);
  const conversations = new ConversationClient(conn, store);
  const looking = new LookingTracker(conn);
  const toasts = new ToastStore();
  const openAgent = (id: string) => navigate({ name: 'agent', terminalId: id });
  const notifier = new ClientNotifierHub()
    .add(new ToastSink(toasts))
    .add(new SoundSink())
    .add(new VibrateSink())
    .add(new SystemSink(openAgent));
  // Web Push (needs HTTPS + the service worker) registers here as one more sink.

  store.onAlert((alert) => {
    const visible = document.visibilityState === 'visible';
    void notifier.notify(alert, { visible, looking: visible && looking.isLooking(alert.terminalId) });
  });

  const badge = new AttentionBadge();
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  let counted: unknown = null;
  store.subscribe(() => {
    const view = store.getState().view;
    if (view === counted) return;
    counted = view;
    badge.update(attentionCounts(view), { blocked: color('--blocked', '#f0705f'), done: color('--done', '#76a8ff') });
  });

  return { store, conn, terminals, conversations, looking, toasts, notifier };
}
