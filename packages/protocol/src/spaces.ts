/**
 * Making a space from the app (REST: GET /api/new-space, GET /api/folders, POST /api/spaces).
 * The bridge starts the space's first terminal with Herdr's labels and the desktop adopts it
 * (herdr-app AGENTS.md: "An id Herdr doesn't know becomes a new space"), the way `space.new` does.
 */

/** What can run in the new space's first terminal: the shell, or an agent from Herdr's + menu, or a core template. */
export type NewSpaceStart = { kind: 'shell' } | { kind: 'agent'; key: string } | { kind: 'template'; name: string };

export interface StartChoice {
  kind: 'agent' | 'template';
  /** Agents: the programs.json key ("claude"); templates: the template's name. */
  key: string;
  name: string;
  /** Found by the shell agents start in (Herdr's `knownAgents()` check). Templates: always true. */
  installed: boolean;
  description?: string;
}

export interface FolderChoice {
  /** Absolute path. */
  path: string;
  /** For people: `~/x/y`. */
  display: string;
  /** Where it comes from: an open space's folder, or one of Herdr's recently closed spaces. */
  from: 'space' | 'recent';
  /** That space's name. */
  label: string;
}

export interface NewSpaceOptions {
  home: string;
  /** Herdr desktop is open (it makes the space; without it nothing would show). */
  appOpen: boolean;
  folders: FolderChoice[];
  starts: StartChoice[];
}

export interface FolderCompletion {
  /** Matching sub-folders, as typed paths ending in `/` (`~/code/herdr/`). */
  entries: string[];
}

export interface NewSpaceRequest {
  /** Absolute, or `~/...`, or relative to the home folder. */
  folder: string;
  /** Optional; empty: Herdr names it after its folder. */
  name?: string;
  start: NewSpaceStart;
}

export interface NewSpaceResult {
  spaceId: string;
  tabId: string;
  terminalId: string;
}

/** Error replies: `{ error, field? }` with the field to show it under. */
export interface NewSpaceError {
  error: string;
  field?: 'folder' | 'name' | 'start';
}

export const SPACE_NAME_MAX = 64;
export const FOLDER_MAX = 1024;

/*
 * A new tab in an open space (REST: GET /api/spaces/:id/sessions, POST /api/spaces/:id/tabs), the
 * way the desktop's + menu adds one: a terminal labeled with the space's id and a fresh tab id, which
 * Herdr adopts into that space.
 */

/** What the new tab runs: the shell, Claude Code (new), or `claude --resume <session>`. */
export type NewTabStart =
  | { kind: 'shell' }
  | { kind: 'claude' }
  /** `config`: the Claude config folder to resume with (`ClaudeConfigChoice.id`); absent: the session's own. */
  | { kind: 'resume'; session: string; config?: string };

export interface NewTabRequest {
  start: NewTabStart;
}

export interface NewTabResult {
  spaceId: string;
  tabId: string;
  terminalId: string;
}

/** A Claude config folder (`~/.claude`, or a CLAUDE_CONFIG_DIR like `~/.claude-work`) and its login. */
export interface ClaudeConfigChoice {
  /** The folder's name (".claude", ".claude-work"): what a resume request names. */
  id: string;
  /** For people: the login ("alice · max"), else the folder ("~/.claude-work"). */
  label: string;
  /** The default one (`claude` without CLAUDE_CONFIG_DIR). */
  isDefault: boolean;
}

export interface ResumableSession {
  /** Claude Code's session id (a UUID). */
  id: string;
  /** Its title (/rename, or Claude's own summary), if it has one. */
  title: string | null;
  /** The first thing typed into it, one line, clipped. */
  prompt: string;
  /** Last activity, ms since the epoch. */
  modifiedMs: number;
  /** Prompts and replies in it. */
  messages: number;
  /** The config folder it belongs to (`ClaudeConfigChoice.id`). */
  config: string;
  /** Running in this terminal now: open that instead of resuming it. */
  openIn: string | null;
  /** Running somewhere Herdr doesn't show (it can't be resumed twice). */
  runningElsewhere: boolean;
}

export interface SpaceSessions {
  /** Where the new tab starts (the folder of the space's first terminal, else the space's). */
  folder: string;
  /** `folder` as `~/...`. */
  display: string;
  /** Herdr desktop is open (it adopts the tab). */
  appOpen: boolean;
  /** Claude Code is installed (the + menu's check). */
  claudeInstalled: boolean;
  /** The config folders that can resume these sessions (more than one: they share transcripts). */
  configs: ClaudeConfigChoice[];
  /** Newest first. */
  sessions: ResumableSession[];
}

export const SESSIONS_MAX = 60;
