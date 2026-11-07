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
