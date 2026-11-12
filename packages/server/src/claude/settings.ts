import {
  CLAUDE_SETTING_READY_WORDS,
  CLAUDE_SETTING_VALUE_MAX,
  type ClaudeSettingKind,
  type ClaudeSettingOptions,
  type ClaudeSettingResult,
  type TerminalView,
} from '@herdr-mobile/protocol';
import {
  commandResult,
  type EffortMenu,
  effortConfirmed,
  type ModelMenu,
  type ModelRow,
  menuOpen,
  modelConfirmed,
  moves,
  parseEffortMenu,
  parseModelMenu,
  parseSwitchQuestion,
  promptText,
  switchIsFor,
} from './picker.js';

/** Claude sits at its message box: no menu or question over it. */
const atPrompt = (s: readonly string[]) => !menuOpen(s) && promptText(s) !== null;

/** One terminal's screen and keyboard, held for the caller alone (no other phone input in between). */
export interface TerminalIo {
  /** The screen's rows now; with `solid`, faint (greyed) text blanked, same rows and columns. */
  screen(opts?: { solid?: boolean }): Promise<string[]>;
  /** Bytes typed as a person would. */
  type(text: string): Promise<void>;
  /** Named keys (up, down, left, right, enter, esc, s). */
  keys(names: string[]): Promise<void>;
}

export interface ClaudeSettingsOptions {
  terminal: (id: string) => TerminalView | undefined;
  /** Runs `run` with the terminal's input to itself. */
  exclusive: <T>(id: string, run: (io: TerminalIo) => Promise<T>) => Promise<T>;
  /** How long to wait for a menu to show / close / confirm. */
  waitMs?: number;
  pollMs?: number;
}

export class ClaudeSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ClaudeSettingsError';
  }
}

/** Why `t` can't have its menus opened right now; null when it can. */
export function settingsRefusal(t: TerminalView | undefined): ClaudeSettingsError | null {
  if (!t) return new ClaudeSettingsError('That agent is gone', 404);
  if (t.machine !== null || t.program !== 'claude') return new ClaudeSettingsError('Only for Claude Code on this computer', 400);
  if (t.word === 'working') return new ClaudeSettingsError('Claude is working: try again when it’s idle', 409);
  if (t.word === 'blocked') return new ClaudeSettingsError('Claude is waiting for an answer: answer it first', 409);
  if (!CLAUDE_SETTING_READY_WORDS.includes(t.word ?? '')) return new ClaudeSettingsError('Claude isn’t at its prompt right now', 409);
  return null;
}

/**
 * Why Claude's screen isn't ready for `/model` or `/effort` to be typed; null when it is: its message box is on
 * screen, empty (greyed hints and suggestions aren't typed text: `solid` is the screen with faint text blanked) and
 * no menu is open.
 */
export function screenRefusal(screen: readonly string[], solid?: readonly string[]): ClaudeSettingsError | null {
  if (menuOpen(screen)) return new ClaudeSettingsError('A Claude menu is open in the terminal: close it first', 409);
  const draft = promptText(screen, solid);
  if (draft === null) return new ClaudeSettingsError('Can’t see Claude’s message box', 409);
  if (draft !== '') return new ClaudeSettingsError('Claude’s message box has a draft: send or clear it first', 409);
  return null;
}

/**
 * A Claude Code agent's model and effort level through Claude's own `/model` and `/effort` menus: reading opens
 * the menu, reads it off the screen and closes it (Esc); choosing opens it, checks the choice is listed, moves the
 * cursor there with arrow keys, presses `s` (this session only) and waits for Claude's confirmation. Nothing the
 * client sends is ever typed: only the command names, arrows, Enter (to expand "More models"), `s` and Esc.
 */
export class ClaudeSettings {
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(private readonly opts: ClaudeSettingsOptions) {
    this.waitMs = opts.waitMs ?? 5000;
    this.pollMs = opts.pollMs ?? 80;
  }

  read(id: string, kind: ClaudeSettingKind): Promise<ClaudeSettingOptions> {
    return this.session(id, kind, async (io, menu) => {
      await this.close(io);
      if (kind === 'model') {
        const rows = (menu as ModelMenu).rows.filter((r): r is ModelRow => r.kind === 'option');
        return {
          kind,
          options: rows.map((r) => ({ value: r.label, label: r.label, ...(r.detail ? { detail: r.detail } : {}) })),
          current: rows.find((r) => r.current)?.label ?? null,
        };
      }
      const e = menu as EffortMenu;
      return { kind, options: e.levels.map((l) => ({ value: l, label: l })), current: e.levels[e.cursor] ?? null };
    });
  }

  choose(id: string, kind: ClaudeSettingKind, value: unknown): Promise<ClaudeSettingResult> {
    if (typeof value !== 'string' || value === '' || value.length > CLAUDE_SETTING_VALUE_MAX) {
      return Promise.reject(new ClaudeSettingsError('Pick one of the listed options', 400));
    }
    return this.session(id, kind, async (io, menu) => {
      let confirmed: (message: string) => boolean;
      let row: ModelRow | null = null;
      if (kind === 'model') {
        const m = menu as ModelMenu;
        const at = m.rows.findIndex((r) => r.kind === 'option' && r.label === value);
        if (at < 0) {
          await this.close(io);
          throw new ClaudeSettingsError('That model isn’t in this session’s list any more', 400);
        }
        const picked = m.rows[at] as ModelRow;
        row = picked;
        await this.moveTo(io, parseModelMenu, m.cursor, at, 'up', 'down');
        confirmed = (msg) => modelConfirmed(msg, picked);
      } else {
        const e = menu as EffortMenu;
        const at = e.levels.indexOf(value);
        if (at < 0) {
          await this.close(io);
          throw new ClaudeSettingsError('That effort level isn’t offered for this model', 400);
        }
        await this.moveTo(io, parseEffortMenu, e.cursor, at, 'left', 'right');
        confirmed = (msg) => effortConfirmed(msg, value);
      }
      await io.keys(['s']);
      let note: string | undefined;
      if (row) {
        // In a conversation with history Claude asks first: the new model re-reads it (slower, more tokens).
        const next = await this.until(io, (s) => (atPrompt(s) ? 'closed' : parseSwitchQuestion(s)));
        if (next && next !== 'closed') {
          if (!switchIsFor(next, row) || !next.onYes) throw new ClaudeSettingsError('Claude asked about switching to another model', 502);
          note = next.note;
          await io.keys(['enter']);
        }
      }
      const said = await this.until(io, (s) => (atPrompt(s) ? commandResult(s, kind) : null), confirmed);
      if (said === null || !confirmed(said)) {
        throw new ClaudeSettingsError(said ? `Claude said: ${said}` : 'Claude didn’t confirm the change', 502);
      }
      return { kind, value, message: said, ...(note ? { note } : {}) };
    });
  }

  /** Checks the agent, opens the menu (expanding "More models"), runs `run`; never leaves a menu open on failure. */
  private session<T>(id: string, kind: ClaudeSettingKind, run: (io: TerminalIo, menu: ModelMenu | EffortMenu) => Promise<T>): Promise<T> {
    const early = settingsRefusal(this.opts.terminal(id));
    if (early) return Promise.reject(early);
    return this.opts.exclusive(id, async (io) => {
      // Checked again inside the lock, right before typing.
      const refusal = settingsRefusal(this.opts.terminal(id));
      if (refusal) throw refusal;
      const screenRefused = screenRefusal(await io.screen(), await io.screen({ solid: true }));
      if (screenRefused) throw screenRefused;
      const parse: (s: readonly string[]) => ModelMenu | EffortMenu | null = kind === 'model' ? parseModelMenu : parseEffortMenu;
      await io.type(`/${kind}`);
      await this.sleep(150);
      await io.keys(['enter']);
      let menu: ModelMenu | EffortMenu | null = await this.until(io, parse);
      try {
        if (!menu) throw new ClaudeSettingsError(`Claude didn’t open its /${kind} menu: try again`, 502);
        if (kind === 'model') {
          const m = menu as ModelMenu;
          const more = m.rows.findIndex((r) => r.kind === 'more' && !r.expanded);
          if (more >= 0) {
            await this.moveTo(io, parseModelMenu, m.cursor, more, 'up', 'down');
            await io.keys(['enter']);
            menu = await this.until(io, (s) => {
              const x = parseModelMenu(s);
              return x?.rows.some((r) => r.kind === 'more' && r.expanded) ? x : null;
            });
            if (!menu) throw new ClaudeSettingsError('Couldn’t open “More models”', 502);
          }
        }
        return await run(io, menu);
      } catch (err) {
        await this.leave(io).catch(() => {});
        throw err;
      }
    });
  }

  /** Arrow keys to row `to`, then waits until the screen shows the cursor there. */
  private async moveTo(
    io: TerminalIo,
    parser: (s: readonly string[]) => { cursor: number } | null,
    from: number,
    to: number,
    back: string,
    forward: string,
  ): Promise<void> {
    if (from < 0) throw new ClaudeSettingsError('Can’t see where the menu’s cursor is', 502);
    const keys = moves(from, to, back, forward);
    if (keys.length > 0) await io.keys(keys);
    const there = await this.until(io, (s) => (parser(s)?.cursor === to ? true : null));
    if (!there) throw new ClaudeSettingsError('The menu’s cursor didn’t get there', 502);
  }

  /** Esc until Claude's message box is back (a menu, or its question over a menu, may be open). */
  private async leave(io: TerminalIo): Promise<void> {
    for (let i = 0; i < 3 && !atPrompt(await io.screen()); i++) {
      await io.keys(['esc']);
      await this.until(io, (s) => (atPrompt(s) ? true : null));
    }
  }

  /** Esc, then waits for the menu to go. */
  private async close(io: TerminalIo): Promise<void> {
    await io.keys(['esc']);
    await this.until(io, (s) => (menuOpen(s) ? null : true));
  }

  /** Polls the screen until `pick` gives something (and `done` accepts it); the last value seen, or null on timeout. */
  private async until<T>(io: TerminalIo, pick: (s: string[]) => T | null, done: (v: T) => boolean = () => true): Promise<T | null> {
    const end = Date.now() + this.waitMs;
    let last: T | null = null;
    for (;;) {
      const v = pick(await io.screen());
      if (v !== null) {
        last = v;
        if (done(v)) return v;
      }
      if (Date.now() > end) return last;
      await this.sleep(this.pollMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
