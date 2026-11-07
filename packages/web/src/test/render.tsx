import type { World } from '@herdr-mobile/protocol';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ConversationClient } from '../conversation/client';
import { ServicesContext } from '../hooks/app';
import type { Services } from '../lib/app';
import { Connection } from '../lib/connection';
import { LookingTracker } from '../lib/looking';
import { AppStore } from '../lib/store';
import { ClientNotifierHub } from '../notify/notifier';
import { ToastStore } from '../notify/toasts';
import { TerminalClient } from '../terminal/streams';
import { FakeWs } from './fakeWs';

/** Renders with real services fed by hand (no socket is ever opened). */
export function renderWith(ui: ReactElement, world: World) {
  const store = new AppStore();
  store.handle({ t: 'welcome', v: 1, serverId: 'srv', heartbeatMs: 15000 });
  store.handle({ t: 'snapshot', seq: 1, world, alerts: [] });
  const conn = new Connection({
    store,
    url: () => 'ws://x/ws',
    checkAuth: async () => 'ok',
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
  });
  const services: Services = {
    store,
    conn,
    terminals: new TerminalClient(conn, store),
    conversations: new ConversationClient(conn, store),
    looking: new LookingTracker(conn),
    toasts: new ToastStore(),
    notifier: new ClientNotifierHub(),
  };
  const r = render(<ServicesContext.Provider value={services}>{ui}</ServicesContext.Provider>);
  return { ...r, services };
}
