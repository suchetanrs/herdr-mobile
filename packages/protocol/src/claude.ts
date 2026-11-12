/**
 * A Claude Code agent's model and effort level, read from and set through Claude's own `/model` and `/effort`
 * menus in its terminal (`GET` / `POST /api/agents/:id/claude/:kind`). Changes are for that session only.
 */
export type ClaudeSettingKind = 'model' | 'effort';

export const CLAUDE_SETTING_KINDS: readonly ClaudeSettingKind[] = ['model', 'effort'];

export interface ClaudeSettingOption {
  /** What to send back to choose it: the label as Claude shows it ("Haiku 5.5", "high"). */
  value: string;
  label: string;
  /** Claude's one-line description, if it shows one. */
  detail?: string;
}

/** `GET /api/agents/:id/claude/:kind`. */
export interface ClaudeSettingOptions {
  kind: ClaudeSettingKind;
  options: ClaudeSettingOption[];
  /** The value in use, null when Claude doesn't mark one. */
  current: string | null;
}

/** `POST /api/agents/:id/claude/:kind` body: one of the listed values. */
export interface ClaudeSettingChoice {
  value: string;
}

/** The change took: `message` is Claude's own confirmation ("Set model to Haiku 4.5 for this session only"). */
export interface ClaudeSettingResult {
  kind: ClaudeSettingKind;
  value: string;
  message: string;
  /** What Claude said when it asked to confirm (a model switch mid-conversation re-reads the history). */
  note?: string;
}

export interface ClaudeSettingError {
  error: string;
}

/** Longest value the bridge accepts (labels are short). */
export const CLAUDE_SETTING_VALUE_MAX = 64;

/** Raw 7501 words in which Claude sits at its prompt, so its menus can be opened. */
export const CLAUDE_SETTING_READY_WORDS: readonly string[] = ['idle', 'done'];
