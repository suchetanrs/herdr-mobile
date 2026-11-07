/**
 * The world as a client sees it: Herdr's spaces -> tabs -> panes -> terminals,
 * with the desktop's status rule already applied. Normalized: entities are keyed
 * by id and refer to each other by id, so a patch can replace one entity at a time.
 *
 * Ids are machine-qualified the way Herdr does it: a terminal on this machine is
 * `t7`, one on an added machine `rohan/t7` (the same for space, tab and pane ids
 * that come from another machine's layout).
 */

/** What Herdr shows for an agent (docs/labels.md). `null`: not an agent (plain shell, server). */
export type AgentStatus = 'working' | 'blocked' | 'done' | 'idle';

/** Herdr's attention priority: blocked > done > working > idle > nothing (model.rs `priority`). */
export const STATUS_PRIORITY: Readonly<Record<AgentStatus, number>> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
};

export interface SpaceView {
  id: string;
  /** The added machine this space runs on (`hc machine ls` name); null: this machine. */
  machine: string | null;
  /** 1-based position in the space list. */
  index: number;
  /** As the desktop shows it: its name, else its first terminal's checkout or folder. */
  name: string;
  /** Someone named it (otherwise `name` is Herdr's automatic name). */
  named: boolean;
  folder: string;
  /**
   * The avatar color the desktop gave it (`space.colors` in herdr-app's shared
   * settings): a palette name like "ansi6" or a "#rrggbb"; null/absent: unknown.
   */
  color?: string | null;
  /** Most urgent status among the pane terminals of all its tabs. */
  status: AgentStatus | null;
  tabIds: string[];
}

export interface TabView {
  id: string;
  spaceId: string;
  /** 1-based position in its space. */
  index: number;
  /** Its name, else its position ("1", "2", ...). */
  name: string;
  named: boolean;
  /** Most urgent status among its pane terminals (sub-agents don't count, as in Herdr). */
  status: AgentStatus | null;
  /** Panes in tree order. */
  panes: PaneView[];
}

export interface PaneView {
  id: string;
  /** The terminal it shows; null for a mod pane. */
  terminalId: string | null;
}

export interface TerminalView {
  /** Address, machine-qualified (`t7`, `rohan/t7`). */
  id: string;
  machine: string | null;
  /** Where it is shown; for a sub-agent, where its top agent is. Null when not placed. */
  spaceId: string | null;
  tabId: string | null;
  /** Its own pane; null for sub-agents and unplaced terminals. */
  paneId: string | null;
  /** The terminal that started it (sub-agents), else null. */
  parent: string | null;
  /** Sub-agents started from it, sorted. */
  children: string[];
  /** The name given with `hc run --name`, if any. */
  name: string | null;
  /** Name for people: `name`, else the agent's name ("Claude Code"), else the program, else the address. */
  label: string;
  /** The 7501 reporting app ("claude-code"), if it ever reported. */
  app: string | null;
  /** The foreground program's name ("claude", "bash"). */
  program: string | null;
  title: string;
  /** Display status (labels.md rule); null: not an agent. */
  status: AgentStatus | null;
  /** The raw 7501 word (idle, working, done, blocked, error, ...). */
  word: string | null;
  /** Core's turn counter. */
  turn: number;
  /** `herdr.seen` label, if any client shares it. */
  seenTurn: number | null;
  pinned: boolean;
  cwd: string | null;
  cols: number;
  rows: number;
  /** When the status was last reported, ms since the epoch. */
  statusMs: number | null;
  /** Claude Code transcript path from the `agent-resume` label, if any. */
  transcript: string | null;
  /**
   * The Claude login a `claude` running in it uses (the desktop's my-agents mod `accounts.py`):
   * this machine only; absent or null when unknown, not Claude, or on another machine.
   */
  account?: AgentAccount | null;
}

/** Which Claude account an agent runs under, e.g. {name: "alice", plan: "pro"}. Nothing else is sent. */
export interface AgentAccount {
  /** The account email's local part ("alice" of alice@example.com), "?" when it has none. */
  name: string;
  /** The plan, lower case ("pro", "max"); "" when unknown. */
  plan: string;
}

export interface CoreInfo {
  connected: boolean;
  /** herdr-core version, e.g. "0.1.18". */
  version: string | null;
  /** The core's machine name, e.g. "devbox". */
  name: string | null;
}

export interface World {
  core: CoreInfo;
  spaceOrder: string[];
  spaces: Record<string, SpaceView>;
  tabs: Record<string, TabView>;
  terminals: Record<string, TerminalView>;
}

export function emptyWorld(): World {
  return {
    core: { connected: false, version: null, name: null },
    spaceOrder: [],
    spaces: {},
    tabs: {},
    terminals: {},
  };
}
