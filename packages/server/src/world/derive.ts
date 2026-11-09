import type { AgentAccount, CoreInfo, PaneView, SpaceView, TabView, TerminalView, World } from '@herdr-mobile/protocol';
import type { CoreTerminal } from '../core/types.js';
import { type LayoutDoc, panesOf, qualify } from './layout.js';
import { agentName, folderName } from './names.js';
import { appOf, displayStatus, rollup, seenTurnOf, wordOf } from './status.js';

export interface DeriveInput {
  core: CoreInfo;
  /** Layout docs per machine (null: this machine), in display order. */
  docs: ReadonlyArray<{ machine: string | null; doc: LayoutDoc }>;
  terminals: ReadonlyMap<string, CoreTerminal> | { get(a: string): CoreTerminal | undefined; all(): Iterable<CoreTerminal> };
  /** The bridge's own seen flag, used only when a terminal has no `herdr.seen` label. */
  seenLocally: (address: string) => boolean;
  home: string;
  /** Checkout top of a local folder (for unnamed spaces). */
  checkoutTop: (folder: string) => string;
  /** Checkout top of a folder on another machine, when known (else the folder itself is used). */
  remoteCheckoutTop?: (machine: string, folder: string) => string | null;
  /** Also list live terminals that are in no pane (diagnostics; Herdr itself doesn't show them). */
  includeUnplaced?: boolean;
  /** The desktop's avatar color for a space, when known. */
  spaceColor?: (spaceId: string) => string | null;
  /** The desktop's agents list "since" for an agent in this status, when known. */
  statusSince?: (address: string, status: TerminalView['status']) => number | null;
  /** A terminal's transcript the bridge can serve (default: the agent-resume label's path, unchecked). */
  transcriptOf?: (t: CoreTerminal) => string | null;
  /** The Claude account a terminal's `claude` runs under (local terminals only). */
  accountOf?: (address: string) => AgentAccount | null;
  /** An agent's name from its 7501 app (default: Herdr's built-in programs table). */
  agentName?: (app: string) => string;
}

const getTerminal = (src: DeriveInput['terminals'], a: string) => src.get(a);
const allTerminals = (src: DeriveInput['terminals']): Iterable<CoreTerminal> =>
  'all' in src && typeof src.all === 'function' ? src.all() : (src as ReadonlyMap<string, CoreTerminal>).values();

function machineOf(address: string): string | null {
  const i = address.lastIndexOf('/');
  return i > 0 ? address.slice(0, i) : null;
}

export function terminalLabel(t: CoreTerminal, nameOf: (app: string) => string = agentName): string {
  if (t.name) return t.name;
  const app = appOf(t);
  if (app) return nameOf(app);
  return t.foreground?.name || t.address;
}

/** Builds the client-facing world from the core's terminals and layout docs. Pure. */
export function deriveWorld(input: DeriveInput): World {
  const { terminals } = input;
  const world: World = { core: input.core, spaceOrder: [], spaces: {}, tabs: {}, terminals: {} };

  // Live sub-agents by parent, sorted (herdr-app `world()` children; hc.rs lists live terminals only).
  const children = new Map<string, string[]>();
  for (const t of allTerminals(terminals)) {
    if (t.parent && t.state === 'live') {
      const list = children.get(t.parent) ?? [];
      list.push(t.address);
      children.set(t.parent, list);
    }
  }
  for (const list of children.values()) list.sort();

  const status = (t: CoreTerminal) => displayStatus(wordOf(t), t.turn ?? 0, seenTurnOf(t), input.seenLocally(t.address));
  // A sub-agent without a pane shows its raw word, error as blocked, and is never done: it reports to its
  // parent, and the parent's done is the news (agents mod `kidStatus`).
  const kidStatus = (t: CoreTerminal): TerminalView['status'] => {
    const w = wordOf(t);
    if (w === 'error') return 'blocked';
    if (w === 'done') return 'idle';
    return w === 'working' || w === 'blocked' || w === 'idle' ? w : null;
  };

  // Terminals with a pane of their own take that place, even when they are someone's sub-agent.
  const paned = new Set<string>();
  for (const { machine, doc } of input.docs)
    for (const s of doc.spaces ?? [])
      for (const tab of s.tabs ?? []) for (const p of panesOf(tab.root)) if (p.terminal !== null) paned.add(qualify(p.terminal, machine));

  const view = (t: CoreTerminal, place: { spaceId: string | null; tabId: string | null; paneId: string | null }): TerminalView => {
    const transcript = input.transcriptOf ? input.transcriptOf(t) : parseTranscript(t.labels?.['agent-resume']);
    const shown = t.parent && place.paneId === null && place.spaceId !== null ? kidStatus(t) : status(t);
    const v: TerminalView = {
      id: t.address,
      machine: machineOf(t.address),
      spaceId: place.spaceId,
      tabId: place.tabId,
      paneId: place.paneId,
      parent: t.parent || null,
      children: children.get(t.address) ?? [],
      name: t.name || null,
      label: terminalLabel(t, input.agentName),
      app: appOf(t),
      program: t.foreground?.name || null,
      title: t.title ?? '',
      status: shown,
      word: wordOf(t),
      turn: t.turn ?? 0,
      seenTurn: seenTurnOf(t),
      pinned: Boolean(t.labels?.['herdr.pinned']),
      cwd: t.foreground?.cwd || t.cwd || null,
      cols: t.cols ?? 0,
      rows: t.rows ?? 0,
      statusMs: input.statusSince?.(t.address, shown) ?? t.status_ms ?? null,
      transcript,
    };
    if (input.accountOf) v.account = input.accountOf(t.address);
    return v;
  };

  const addWithChildren = (t: CoreTerminal, place: { spaceId: string; tabId: string; paneId: string | null }, depth = 0) => {
    if (world.terminals[t.address] || depth > 32) return;
    world.terminals[t.address] = view(t, place);
    for (const c of children.get(t.address) ?? []) {
      if (paned.has(c)) continue;
      const ct = getTerminal(terminals, c);
      if (ct) addWithChildren(ct, { spaceId: place.spaceId, tabId: place.tabId, paneId: null }, depth + 1);
    }
  };

  let spaceIndex = 0;
  for (const { machine, doc } of input.docs) {
    for (const s of doc.spaces ?? []) {
      const spaceId = qualify(s.id, machine);
      if (world.spaces[spaceId]) continue;
      const tabIds: string[] = [];
      const spaceStatuses: Array<TerminalView['status']> = [];
      let firstCwd: string | null = null;
      let closedTabs = false;
      (s.tabs ?? []).forEach((tab) => {
        const tabId = qualify(tab.id, machine);
        if (world.tabs[tabId]) return;
        const panes: PaneView[] = [];
        let closedPanes = false;
        const tabStatuses: Array<TerminalView['status']> = [];
        for (const p of panesOf(tab.root)) {
          const paneId = qualify(p.id, machine);
          if (p.terminal === null) {
            panes.push({ id: paneId, terminalId: null });
            continue;
          }
          const address = qualify(p.terminal, machine);
          const t = getTerminal(terminals, address);
          // A pane whose terminal is gone or has ended is closed, as the desktop does.
          if (!t || paneClosed(t)) {
            closedPanes = true;
            continue;
          }
          panes.push({ id: paneId, terminalId: address });
          firstCwd ??= t.foreground?.cwd || t.cwd || null;
          addWithChildren(t, { spaceId, tabId, paneId });
          tabStatuses.push(world.terminals[address]?.status ?? null);
        }
        // Closing a tab's last pane closes the tab (model.rs `remove_pane`).
        if (closedPanes && panes.length === 0) {
          closedTabs = true;
          return;
        }
        // Numbered among the tabs still shown (model.rs `tab_name`: position in the space's tabs).
        const index = tabIds.length + 1;
        const tabView: TabView = {
          id: tabId,
          spaceId,
          index,
          name: tab.name || String(index),
          named: Boolean(tab.name),
          status: rollup(tabStatuses),
          panes,
        };
        world.tabs[tabId] = tabView;
        tabIds.push(tabId);
        spaceStatuses.push(...tabStatuses);
      });
      // ...and its space's last tab closes the space (model.rs `remove_tab`).
      if (closedTabs && tabIds.length === 0) continue;
      const folder = s.folder ?? '';
      const autoFolder = s.name
        ? folder
        : firstCwd
          ? machine
            ? (input.remoteCheckoutTop?.(machine, firstCwd) ?? firstCwd)
            : input.checkoutTop(firstCwd)
          : folder;
      const space: SpaceView = {
        id: spaceId,
        machine,
        index: ++spaceIndex,
        name: s.name || folderName(autoFolder, input.home),
        named: Boolean(s.name),
        folder,
        status: rollup(spaceStatuses),
        tabIds,
      };
      if (input.spaceColor) space.color = input.spaceColor(spaceId);
      world.spaces[spaceId] = space;
      world.spaceOrder.push(spaceId);
    }
  }
  if (input.includeUnplaced) {
    for (const t of allTerminals(terminals)) {
      if (t.state === 'live' && !world.terminals[t.address])
        world.terminals[t.address] = view(t, { spaceId: null, tabId: null, paneId: null });
    }
  }
  return world;
}

/**
 * The desktop only keeps live terminals; a pane whose terminal exited or was
 * killed is removed (window.rs `check_closed`). Other endings keep the pane.
 */
function paneClosed(t: CoreTerminal): boolean {
  return t.state === 'finished' && (t.reason === 'exited' || t.reason === 'killed');
}

function parseTranscript(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { transcript?: unknown };
    return typeof v.transcript === 'string' ? v.transcript : null;
  } catch {
    return null;
  }
}
