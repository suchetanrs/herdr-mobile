import type { AgentStatus, SpaceView, TabView, TerminalView, World } from '@herdr-mobile/protocol';
import { clean } from './format';
import { type Program, programOf } from './programs';

/** Herdr's attention order (model.rs `priority`). */
export const RANK: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1 };

export type SectionId = AgentStatus;
/** Inbox sections, Moshi's order: what needs you, what's moving, what finished, the rest. */
export const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'blocked', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'done', label: 'Done' },
  { id: 'idle', label: 'Idle' },
];

/** Terminals in no pane (only sent in the bridge's diagnostics mode) live in this made-up space. */
export const UNPLACED = '~unplaced';

export function program(t: TerminalView): Program {
  return programOf(t.app, t.program);
}

/** "alice, pro": the Claude login a local agent runs under (the desktop's my-agents mod `account`). */
export function accountLabel(t: TerminalView): string | null {
  const a = t.account;
  if (!a) return null;
  return a.plan ? `${a.name}, ${a.plan}` : a.name;
}

/** What my-agents shows right of an agent's name: its Claude login, else (not Claude) its program in lower case. */
export function agentTag(t: TerminalView): string | null {
  const acc = accountLabel(t);
  if (acc) return acc;
  const p = program(t);
  if (p.key === 'claude') return null;
  return (p.name || t.app || '').toLowerCase() || null;
}

/** A sub-agent's status as Herdr shows it: error counts as blocked; never done (its parent's done is the news). */
export function shownStatus(t: TerminalView): AgentStatus | null {
  if (!t.parent) return t.status;
  if (t.word === 'error') return 'blocked';
  return t.status === 'done' ? 'idle' : t.status;
}

export function rollup(statuses: Iterable<AgentStatus | null>): AgentStatus | null {
  let top: AgentStatus | null = null;
  for (const s of statuses) if (s && (!top || RANK[s] > RANK[top])) top = s;
  return top;
}

const numeric = (s: string) => /^\d+$/.test(s);

/** Says something a tab number doesn't: not the program's name, not a path or user@host. */
function telling(title: string, p: Program): boolean {
  return Boolean(title) && title !== p.name && !/^[~/]|^[A-Za-z]:\\/.test(title) && !title.includes('@') && title.toLowerCase() !== p.key;
}

/** The terminal that speaks for a tab: its first agent, else its first terminal. */
export function leadOf(tab: TabView, world: World): TerminalView | undefined {
  const ts = tab.panes.map((p) => (p.terminalId ? world.terminals[p.terminalId] : undefined)).filter((t): t is TerminalView => Boolean(t));
  return ts.find((t) => program(t).agent) ?? ts[0];
}

/** A tab's label (agents mod `title`): an unnamed tab reads as its lead's live title when that tells more. */
export function tabLabel(tab: TabView, world: World): string {
  const lead = leadOf(tab, world);
  if (!lead) return tab.name;
  const p = program(lead);
  const live = clean(lead.title);
  return (tab.name === p.name || !tab.named) && telling(live, p) ? live : tab.name;
}

/** What a row calls a terminal under its space's header. */
export function terminalName(t: TerminalView, world: World): string {
  if (t.name) return t.name;
  const p = program(t);
  const tab = t.tabId ? world.tabs[t.tabId] : undefined;
  if (t.parent || !tab) {
    const live = clean(t.title);
    return telling(live, p) ? live : p.name;
  }
  if (leadOf(tab, world)?.id !== t.id) {
    const live = clean(t.title);
    return telling(live, p) ? live : p.name;
  }
  const label = tabLabel(tab, world);
  return numeric(label) ? p.name || label : label;
}

/** "Space / Tab" for a terminal. */
export function placeOf(t: TerminalView, world: World): string {
  const space = t.spaceId ? world.spaces[t.spaceId] : undefined;
  const tab = t.tabId ? world.tabs[t.tabId] : undefined;
  if (!space) return t.machine ? `${t.machine} · not in a space` : 'Not in a space';
  return tab ? `${space.name} / ${tabLabel(tab, world)}` : space.name;
}

export interface TreeRow {
  t: TerminalView;
  /** 0 for pane terminals, 1+ for sub-agents. */
  depth: number;
  /** Tree lines in front of a sub-agent: "├", "└", "│" or "". */
  lines: string[];
}

/** `id` and its live sub-agents, depth first, with tree lines (agents mod `tree`). */
export function withSubAgents(world: World, t: TerminalView): TreeRow[] {
  const out: TreeRow[] = [{ t, depth: 0, lines: [] }];
  const walk = (id: string, lead: string[], depth: number) => {
    const kids = (world.terminals[id]?.children ?? []).map((c) => world.terminals[c]).filter((k): k is TerminalView => Boolean(k));
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      out.push({ t: k, depth, lines: [...lead, last ? '└' : '├'] });
      if (depth < 8) walk(k.id, [...lead, last ? '' : '│'], depth + 1);
    });
  };
  walk(t.id, [], 1);
  return out;
}

export function unplaced(world: World): TerminalView[] {
  return Object.values(world.terminals)
    .filter((t) => !t.spaceId && !t.parent)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** A made-up space for terminals in no pane (diagnostics), or null when there are none. */
export function unplacedSpace(world: World): SpaceView | null {
  const ts = unplaced(world);
  if (!ts.length) return null;
  return {
    id: UNPLACED,
    machine: null,
    index: Object.keys(world.spaces).length + 1,
    name: 'Not in a space',
    named: true,
    folder: '',
    status: rollup(ts.map(shownStatus)),
    tabIds: [],
  };
}

export function spaceOf(world: World, id: string): SpaceView | null {
  return id === UNPLACED ? unplacedSpace(world) : (world.spaces[id] ?? null);
}

export interface TabGroup {
  tab: TabView | null;
  label: string;
  rows: TreeRow[];
}

/** A space's tabs, each with its terminals (and their sub-agents) in pane order. */
export function spaceTabs(world: World, spaceId: string): TabGroup[] {
  if (spaceId === UNPLACED) {
    const rows = unplaced(world).flatMap((t) => withSubAgents(world, t));
    return rows.length ? [{ tab: null, label: 'Terminals', rows }] : [];
  }
  const space = world.spaces[spaceId];
  if (!space) return [];
  return space.tabIds
    .map((id) => world.tabs[id])
    .filter((tab): tab is TabView => Boolean(tab))
    .map((tab) => ({
      tab,
      label: tabLabel(tab, world),
      rows: tab.panes
        .map((p) => (p.terminalId ? world.terminals[p.terminalId] : undefined))
        .filter((t): t is TerminalView => Boolean(t))
        .flatMap((t) => withSubAgents(world, t)),
    }));
}

/** Every terminal of a space in display order (swipe order on the agent screen). */
export function spaceTerminals(world: World, spaceId: string): TerminalView[] {
  return spaceTabs(world, spaceId).flatMap((g) => g.rows.map((r) => r.t));
}

export interface SpaceCounts {
  agents: number;
  terminals: number;
  tabs: number;
  blocked: number;
  working: number;
  done: number;
  idle: number;
}

export function spaceCounts(world: World, spaceId: string): SpaceCounts {
  const c: SpaceCounts = { agents: 0, terminals: 0, tabs: 0, blocked: 0, working: 0, done: 0, idle: 0 };
  const groups = spaceTabs(world, spaceId);
  c.tabs = groups.filter((g) => g.tab).length;
  for (const g of groups)
    for (const r of g.rows) {
      c.terminals++;
      const s = shownStatus(r.t);
      if (!s) continue;
      c.agents++;
      c[s]++;
    }
  return c;
}

/** The agents of a space that want a look, most urgent first: blocked, then unseen done. */
export function spaceAttention(world: World, spaceId: string): TerminalView[] {
  return spaceTerminals(world, spaceId)
    .filter((t) => {
      const s = shownStatus(t);
      return s === 'blocked' || s === 'done';
    })
    .sort((a, b) => RANK[shownStatus(b) ?? 'idle'] - RANK[shownStatus(a) ?? 'idle']);
}

/** The space's status as the inbox files it: its rollup, or idle when it runs no agent. */
export function sectionOf(space: SpaceView): SectionId {
  return space.status ?? 'idle';
}

export interface MachineGroup {
  machine: string | null;
  sections: Array<{ id: SectionId; label: string; spaces: SpaceView[] }>;
}

/** All spaces (plus the unplaced one), per machine when there's more than this one, in inbox sections. */
export function inbox(world: World): MachineGroup[] {
  const all = world.spaceOrder.map((id) => world.spaces[id]).filter((s): s is SpaceView => Boolean(s));
  const extra = unplacedSpace(world);
  if (extra) all.push(extra);
  const machines = [...new Set(all.map((s) => s.machine))].sort((a, b) =>
    a === b ? 0 : a === null ? -1 : b === null ? 1 : a.localeCompare(b),
  );
  return machines.map((machine) => {
    const mine = all.filter((s) => s.machine === machine);
    return {
      machine,
      sections: SECTIONS.map((sec) => ({ ...sec, spaces: mine.filter((s) => sectionOf(s) === sec.id) })).filter(
        (sec) => sec.spaces.length > 0,
      ),
    };
  });
}

/** Agents wanting attention across the world (title badge, status bar). */
export function attentionCounts(world: World): { blocked: number; done: number; agents: number } {
  let blocked = 0;
  let done = 0;
  let agents = 0;
  for (const t of Object.values(world.terminals)) {
    const s = shownStatus(t);
    if (!s) continue;
    agents++;
    if (s === 'blocked') blocked++;
    else if (s === 'done') done++;
  }
  return { blocked, done, agents };
}

/** The space a terminal is shown in (the made-up one for unplaced terminals). */
export function spaceIdOf(t: TerminalView): string {
  return t.spaceId ?? UNPLACED;
}

/** Pinned agents (Herdr's "Pinned" group, labels.md `herdr.pinned`), in space order. */
export function pinnedAgents(world: World): TerminalView[] {
  return [...world.spaceOrder, UNPLACED]
    .flatMap((id) => spaceTerminals(world, id))
    .filter((t) => t.pinned && !t.parent && shownStatus(t) !== null);
}

/** An agent's live sub-agents: how many, and the most urgent of their states (Herdr's folded count). */
export function subAgents(world: World, t: TerminalView): { count: number; top: AgentStatus | null } {
  const rows = withSubAgents(world, t).slice(1);
  return { count: rows.length, top: rollup(rows.map((r) => shownStatus(r.t))) };
}
