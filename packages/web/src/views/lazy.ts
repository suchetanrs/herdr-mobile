import { lazy } from 'react';
import { retrying } from '../lib/chunks';

// xterm.js is most of the bundle, and the conversation view (markdown + highlighting) is its own chunk too:
// both load when first needed, retried while the bridge is away (lib/chunks.ts).
const importPane = () => import('../terminal/TerminalPane').then((m) => ({ default: m.TerminalPane }));
const importConversation = () => import('../conversation/ConversationView').then((m) => ({ default: m.ConversationView }));

export const TerminalPane = lazy(retrying(importPane));
export const ConversationView = lazy(retrying(importConversation));
// The file viewer shares the Markdown renderer with the conversation view; it loads when a file is opened.
export const FileViewer = lazy(retrying(() => import('../screens/FileViewer').then((m) => ({ default: m.FileViewer }))));

type Connection = { effectiveType?: string; saveData?: boolean };

/** Warms both chunks up once the app is idle, unless the phone is saving data or on a slow link. */
export function preloadViews(): void {
  const c = (navigator as Navigator & { connection?: Connection }).connection;
  if (c?.saveData || (c?.effectiveType && /(^|-)(2g|3g)$/.test(c.effectiveType))) return;
  // Only a warm-up: if the bridge is away right now, the real open loads (and retries) later.
  importPane().catch(() => {});
  importConversation().catch(() => {});
}
