import fs from 'node:fs';
import path from 'node:path';
import type { TerminalView } from '@herdr-mobile/protocol';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  commandResult,
  effortConfirmed,
  menuOpen,
  messageBox,
  modelConfirmed,
  parseEffortMenu,
  parseModelMenu,
  parseSwitchQuestion,
  promptText,
  switchIsFor,
} from '../src/claude/picker.js';
import { ClaudeSettings, ClaudeSettingsError, settingsRefusal, type TerminalIo } from '../src/claude/settings.js';
import { registerClaudeRoutes } from '../src/transport/claude.js';

// Real screens of Claude Code 2.1.322 (`claude --model haiku` throwaways), read with `hc read`.
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'claude-fixtures');
const fx = (name: string) =>
  fs
    .readFileSync(path.join(DIR, `${name}.txt`), 'utf8')
    .replace(/\n$/, '')
    .split('\n');

const MAIN = ['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'];
const MORE = ['Fable 5.1', 'Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6'];
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('Claude’s /model and /effort menus, from real screens', () => {
  it('reads the collapsed model menu: labels, descriptions, the one in use, the cursor', () => {
    const m = parseModelMenu(fx('model-collapsed'));
    expect(m).not.toBeNull();
    const opts = m?.rows.filter((r) => r.kind === 'option') ?? [];
    expect(opts.map((r) => r.label)).toEqual(MAIN);
    expect(opts[0]).toEqual({
      kind: 'option',
      label: 'Default (recommended)',
      detail: 'Opus 5.5 · Best for everyday, complex tasks',
      current: false,
    });
    expect(opts.filter((r) => r.current).map((r) => r.label)).toEqual(['Sonnet 5.5']);
    expect(m?.rows[5]).toEqual({ kind: 'more', expanded: false });
    expect(m?.cursor).toBe(3);
    expect(parseModelMenu(fx('model-more-cursor'))?.cursor).toBe(5);
  });

  it('reads the expanded model menu, More models included', () => {
    const m = parseModelMenu(fx('model-expanded'));
    expect(m?.rows.filter((r) => r.kind === 'option').map((r) => r.label)).toEqual([...MAIN, ...MORE]);
    expect(m?.rows[5]).toEqual({ kind: 'more', expanded: true });
    expect(m?.cursor).toBe(5);
    expect(parseModelMenu(fx('model-expanded-cursor7'))?.cursor).toBe(7);
  });

  it('reads the effort slider: levels and the mark', () => {
    expect(parseEffortMenu(fx('effort-low'))).toEqual({ levels: LEVELS, cursor: 0 });
    expect(parseEffortMenu(fx('effort-xhigh-cursor'))).toEqual({ levels: LEVELS, cursor: 3 });
    // A model without effort support still shows the slider (no Ultracode toggle).
    expect(parseEffortMenu(fx('effort-unsupported'))).toEqual({ levels: LEVELS, cursor: 0 });
  });

  it('sees no menu at the prompt; the message box empty, with a draft, or showing the fresh-session hint', () => {
    for (const s of ['model-esc', 'fresh', 'prompt-draft', 'model-set-haiku45']) {
      expect(parseModelMenu(fx(s))).toBeNull();
      expect(parseEffortMenu(fx(s))).toBeNull();
      expect(menuOpen(fx(s))).toBe(false);
    }
    expect(menuOpen(fx('model-collapsed'))).toBe(true);
    expect(menuOpen(fx('effort-low'))).toBe(true);
    expect(promptText(fx('model-esc'))).toBe('');
    expect(promptText(fx('fresh'))).toBe('');
    expect(promptText(fx('prompt-draft'))).toBe('hello');
    expect(promptText(fx('model-collapsed'))).toBeNull();
  });

  it('reads the “Switch model?” question Claude asks in a conversation with history', () => {
    const q = parseSwitchQuestion(fx('model-switch-confirm'));
    expect(q).toEqual({
      model: 'Haiku 4.5',
      onYes: true,
      note: 'Your next response will be slower and use more tokens This conversation is cached for the current model. Switching to Haiku 4.5 means the full history gets re-read.',
    });
    expect(switchIsFor(q as NonNullable<typeof q>, { label: 'Haiku 4.5', detail: '' })).toBe(true);
    expect(switchIsFor(q as NonNullable<typeof q>, { label: 'Haiku 5.5', detail: '' })).toBe(false);
    expect(promptText(fx('model-switch-confirm'))).toBeNull();
    expect(parseModelMenu(fx('model-switch-confirm'))).toBeNull();
    expect(parseSwitchQuestion(fx('model-collapsed'))).toBeNull();
  });

  it('reads Claude’s confirmations', () => {
    const s = fx('model-set-haiku45');
    expect(commandResult(s, 'model')).toBe('Set model to Haiku 4.5 for this session only');
    expect(commandResult(fx('model-esc'), 'model')).toBe('Kept model as Sonnet 5.5');
    expect(commandResult(s, 'effort')).toBe('Cancelled');
    expect(modelConfirmed('Set model to Haiku 4.5 for this session only', { label: 'Haiku 4.5', detail: '' })).toBe(true);
    expect(modelConfirmed('Set model to Haiku 4.5 for this session only', { label: 'Haiku 5.5', detail: '' })).toBe(false);
    expect(modelConfirmed('Kept model as Sonnet 5.5', { label: 'Sonnet 5.5', detail: '' })).toBe(true);
    expect(
      modelConfirmed('Set model to Opus 5.5 for this session only', { label: 'Default (recommended)', detail: 'Opus 5.5 · Best' }),
    ).toBe(true);
    expect(modelConfirmed('Cancelled', { label: 'Haiku 4.5', detail: '' })).toBe(false);
    expect(
      effortConfirmed('Set effort level to low (this session only): Quick, straightforward implementation with minimal overhead', 'low'),
    ).toBe(true);
    expect(effortConfirmed('Set effort level to low (this session only): …', 'high')).toBe(false);
  });
});

// The user's real agents (scrubbed; read with an observing attach, `.solid` = faint text blanked like
// ScreenMirror.screenNow({ solid: true })): the claude-hud status line under the box, 173-181 columns, a session name in
// the box's top rule, Claude's greyed suggestion in the box, background shells and agents listed below.
describe('Claude’s message box on real agents’ screens', () => {
  it('finds the box under a named session’s rule, with status lines and a background task list below it', () => {
    for (const s of ['real-idle', 'real-named-idle', 'real-suggestion', 'real-draft-tasks']) {
      const box = messageBox(fx(s));
      expect(box, s).not.toBeNull();
      expect(fx(s)[box?.prompt ?? 0]?.startsWith('❯'), s).toBe(true);
      expect(menuOpen(fx(s)), s).toBe(false);
    }
    expect(promptText(fx('real-idle'))).toBe('');
    expect(promptText(fx('real-named-idle'))).toBe('');
  });

  it('a greyed suggestion is not a draft; a typed draft is', () => {
    expect(promptText(fx('real-suggestion'), fx('real-suggestion.solid'))).toBe('');
    // Without the faint text blanked it looks like a draft (the safe side).
    expect(promptText(fx('real-suggestion'))).toBe('give me the command to run it');
    expect(promptText(fx('real-draft-tasks'), fx('real-draft-tasks.solid'))).toBe('hello there');
  });

  it('sees the model menu open on a wide screen (it replaces the box, the status lines and the task list)', () => {
    const s = fx('real-model-menu-wide');
    expect(menuOpen(s)).toBe(true);
    expect(promptText(s)).toBeNull();
    expect(
      parseModelMenu(s)
        ?.rows.filter((r) => r.kind === 'option')
        .map((r) => r.label),
    ).toEqual(MAIN);
    // A menu drawn below a box left from an earlier paint (more than 12 rows of task list under it) is still seen.
    const tall = [...fx('real-draft-tasks').slice(0, 5), ...s.slice(3), ...Array.from({ length: 14 }, (_, i) => `  ◯ task ${i}`)];
    expect(menuOpen(tall)).toBe(true);
  });

  it('opens the menu on a real idle screen with a greyed suggestion, and closes it again', async () => {
    const { claude, settings } = setup();
    claude.real = 'real-suggestion';
    const r = await settings.read('t1', 'effort');
    expect(r.options.map((o) => o.value)).toEqual(LEVELS);
    expect(claude.typed).toEqual(['/effort']);
    expect(claude.menu).toBeNull();
  });

  it('still refuses a real typed draft under the same status lines', async () => {
    const { claude, settings } = setup();
    claude.real = 'real-draft-tasks';
    await expect(settings.read('t1', 'model')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('draft') });
    expect(claude.typed).toEqual([]);
  });
});

/**
 * Claude at its prompt, drawn from the real screens: the menus are the fixtures' menu blocks with the cursor (❯)
 * or the slider mark (▲) moved, the transcript gets `❯ /cmd` + `⎿ result` like Claude prints them.
 */
class FakeClaude implements TerminalIo {
  typed: string[] = [];
  keysSent: string[] = [];
  draft = '';
  menu: 'model' | 'effort' | null = null;
  expanded = false;
  cursor = 0;
  model = 'Sonnet 5.5';
  effort = 2;
  history: string[] = [];
  /** Claude ignores `s` (to test a missing confirmation). */
  deaf = false;
  /** The conversation has history: a model switch asks "Switch model?" first. */
  talked = false;
  asking: string | null = null;
  /** At the prompt with nothing typed, show this real screen (and its `.solid` twin when asked) instead. */
  real: string | null = null;
  private readonly head = fx('fresh').slice(0, 3);
  private readonly box = fx('model-esc').slice(-6);

  private modelBlock(): string[] {
    const src = fx(this.expanded ? 'model-expanded' : 'model-collapsed');
    const start = src.findIndex((l) => l.startsWith('▔'));
    let row = -1;
    return src.slice(start).map((l) => {
      const plain = l.replace(/^(\s*)❯ /u, '$1  ').replace(/ ✔( *)/u, '  $1');
      if (!/^\s+(\d+\.|[▸▾])\s/u.test(plain)) return plain;
      row++;
      let out = row === this.cursor ? `   ❯ ${plain.slice(5)}` : plain;
      const label = /^\s*(?:❯\s+)?\d+\.\s+(.+?)\s{2,}/u.exec(out)?.[1];
      if (label === this.model) out = out.replace(`${label}  `, `${label} ✔`);
      return out;
    });
  }

  private effortBlock(): string[] {
    const src = fx('effort-low');
    const start = src.findIndex((l) => /^\s*Effort\s*$/.test(l)) - 1;
    const block = src.slice(start);
    const at = block.findIndex((l) => l.includes('▲'));
    const levels = block[at + 1] as string;
    const word = [...levels.matchAll(/[a-z]+/g)][this.cursor] as RegExpMatchArray;
    const col = (word.index ?? 0) + Math.floor((word[0].length - 1) / 2);
    const slider = (block[at] as string).replace('▲', '─');
    block[at] = `${slider.slice(0, col)}▲${slider.slice(col + 1)}`;
    return block;
  }

  async screen(opts: { solid?: boolean } = {}): Promise<string[]> {
    if (this.real && !this.menu && !this.asking && this.draft === '') return fx(opts.solid ? `${this.real}.solid` : this.real);
    if (this.asking) {
      const q = fx('model-switch-confirm');
      const at = q.findIndex((l) => /Switch model\?/.test(l)) - 1;
      return [...this.head, ...this.history, ...q.slice(at).map((l) => l.replaceAll('Haiku 4.5', this.asking as string))];
    }
    const box = [...this.box];
    box[1] = `❯ ${this.draft}`.trimEnd();
    if (this.menu === 'model') return [...this.head, ...this.history, ...this.modelBlock()];
    if (this.menu === 'effort') return [...this.head, ...this.history, ...this.effortBlock()];
    return [...this.head, ...this.history, ...box];
  }

  async type(text: string): Promise<void> {
    this.typed.push(text);
    this.draft += text;
  }

  async keys(names: string[]): Promise<void> {
    for (const k of names) {
      this.keysSent.push(k);
      const n = this.expanded ? MAIN.length + 1 + MORE.length : MAIN.length + 1;
      if (this.asking) {
        if (k === 'enter') {
          this.model = this.asking;
          this.history.push('❯ /model', `  ⎿  Set model to ${this.model} for this session only`);
          this.menu = null;
        }
        this.asking = null;
      } else if (this.menu === null) {
        if (k === 'enter' && (this.draft === '/model' || this.draft === '/effort')) {
          this.menu = this.draft === '/model' ? 'model' : 'effort';
          this.cursor = this.menu === 'model' ? this.modelRow(this.model) : this.effort;
          // Assumed (checked live by scripts/check-model-effort.mjs): a session on a "More models" model opens expanded.
          this.expanded = this.menu === 'model' && !MAIN.includes(this.model);
          this.draft = '';
        }
      } else if (k === 'esc') {
        this.history.push(`❯ /${this.menu}`, this.menu === 'model' ? `  ⎿  Kept model as ${this.model}` : '  ⎿  Cancelled');
        this.menu = null;
      } else if (this.menu === 'model') {
        if (k === 'down') this.cursor = Math.min(n - 1, this.cursor + 1);
        if (k === 'up') this.cursor = Math.max(0, this.cursor - 1);
        if (k === 'enter' && this.cursor === MAIN.length) this.expanded = !this.expanded;
        if (k === 'enter' && this.cursor !== MAIN.length) throw new Error('Enter on a model would change the default');
        if (k === 's' && !this.deaf && this.talked && this.labelAt(this.cursor) !== this.model) {
          this.asking = this.labelAt(this.cursor);
        } else if (k === 's' && !this.deaf) {
          this.model = this.labelAt(this.cursor);
          this.history.push('❯ /model', `  ⎿  Set model to ${this.model} for this session only`);
          this.menu = null;
        }
      } else {
        if (k === 'left') this.cursor = Math.max(0, this.cursor - 1);
        if (k === 'right') this.cursor = Math.min(LEVELS.length - 1, this.cursor + 1);
        if (k === 'enter') throw new Error('Enter on a level would change the default');
        if (k === 's' && !this.deaf) {
          this.effort = this.cursor;
          this.history.push('❯ /effort', `  ⎿  Set effort level to ${LEVELS[this.cursor]} (this session only): Some words`);
          this.menu = null;
        }
      }
    }
  }

  private modelRow(label: string): number {
    const i = MAIN.indexOf(label);
    return i >= 0 ? i : MAIN.length + 1 + MORE.indexOf(label);
  }

  private labelAt(row: number): string {
    return row < MAIN.length ? (MAIN[row] as string) : (MORE[row - MAIN.length - 1] as string);
  }
}

const agent = (over: Partial<TerminalView> = {}): TerminalView =>
  ({ id: 't1', machine: null, program: 'claude', word: 'idle', status: 'idle', ...over }) as TerminalView;

function setup(over: Partial<TerminalView> = {}) {
  const claude = new FakeClaude();
  const t = { current: agent(over) };
  let locks = 0;
  const settings = new ClaudeSettings({
    terminal: (id) => (id === 't1' ? t.current : undefined),
    exclusive: async (_id, run) => {
      locks++;
      return run(claude);
    },
    waitMs: 200,
    pollMs: 1,
  });
  return { claude, settings, t, locks: () => locks };
}

describe('ClaudeSettings (the menus driven through the typing attach)', () => {
  it('lists the models (More models expanded) with the one in use, then closes the menu', async () => {
    const { claude, settings } = setup();
    const r = await settings.read('t1', 'model');
    expect(r.options.map((o) => o.value)).toEqual([...MAIN, ...MORE]);
    expect(r.options[1]).toEqual({ value: 'Opus 5.5', label: 'Opus 5.5', detail: 'For complex work and everyday tasks' });
    expect(r.current).toBe('Sonnet 5.5');
    expect(claude.typed).toEqual(['/model']);
    // Sonnet 5.5 (row 3) -> More models (row 5): down, down, Enter to expand; Esc.
    expect(claude.keysSent).toEqual(['enter', 'down', 'down', 'enter', 'esc']);
    expect(claude.menu).toBeNull();
  });

  it('lists the effort levels with the one in use', async () => {
    const { claude, settings } = setup();
    expect(await settings.read('t1', 'effort')).toEqual({
      kind: 'effort',
      options: LEVELS.map((l) => ({ value: l, label: l })),
      current: 'high',
    });
    expect(claude.typed).toEqual(['/effort']);
    expect(claude.keysSent).toEqual(['enter', 'esc']);
  });

  it('switches the model with arrows and `s` (this session only), never Enter on a model, and checks the confirmation', async () => {
    const { claude, settings } = setup();
    const r = await settings.choose('t1', 'model', 'Haiku 4.5');
    expect(r).toEqual({ kind: 'model', value: 'Haiku 4.5', message: 'Set model to Haiku 4.5 for this session only' });
    expect(claude.model).toBe('Haiku 4.5');
    // Opens on Sonnet 5.5 (row 3): 2 down to More models, Enter expands, 2 down to Haiku 4.5 (row 7), s.
    expect(claude.keysSent).toEqual(['enter', 'down', 'down', 'enter', 'down', 'down', 's']);
    expect(claude.typed).toEqual(['/model']);
    const back = await settings.choose('t1', 'model', 'Sonnet 5.5');
    expect(back.message).toBe('Set model to Sonnet 5.5 for this session only');
    // Opens expanded on Haiku 4.5 (row 7): 4 up to Sonnet 5.5.
    expect(claude.keysSent.slice(7)).toEqual(['enter', 'up', 'up', 'up', 'up', 's']);
  });

  it('in a conversation with history, answers Claude’s “Switch model?” with Yes and passes its note on', async () => {
    const { claude, settings } = setup();
    claude.talked = true;
    const r = await settings.choose('t1', 'model', 'Opus 5.5');
    expect(r.message).toBe('Set model to Opus 5.5 for this session only');
    expect(r.note).toContain('the full history gets re-read');
    expect(claude.keysSent).toEqual(['enter', 'down', 'down', 'enter', 'up', 'up', 'up', 'up', 's', 'enter']);
    expect(claude.model).toBe('Opus 5.5');
    expect(await claude.screen()).toContain('❯');
  });

  it('sets the effort level with arrows and `s`', async () => {
    const { claude, settings } = setup();
    const r = await settings.choose('t1', 'effort', 'low');
    expect(r.message).toBe('Set effort level to low (this session only): Some words');
    expect(claude.keysSent).toEqual(['enter', 'left', 'left', 's']);
    await settings.choose('t1', 'effort', 'max');
    expect(claude.keysSent.slice(4)).toEqual(['enter', 'right', 'right', 'right', 'right', 's']);
    expect(claude.effort).toBe(4);
  });

  it('refuses values that aren’t listed (nothing but the menu keys is typed) and closes the menu', async () => {
    const { claude, settings } = setup();
    await expect(settings.choose('t1', 'model', 'gpt-5; rm -rf ~')).rejects.toMatchObject({ status: 400 });
    expect(claude.menu).toBeNull();
    await expect(settings.choose('t1', 'effort', 'ultra')).rejects.toMatchObject({ status: 400 });
    expect(claude.typed).toEqual(['/model', '/effort']);
    expect(claude.keysSent.at(-1)).toBe('esc');
    for (const v of [undefined, 3, '', 'x'.repeat(65), { value: 'low' }]) {
      await expect(settings.choose('t1', 'effort', v)).rejects.toMatchObject({ status: 400 });
    }
    expect(claude.typed).toHaveLength(2);
  });

  it('refuses a busy, blocked, remote or non-Claude agent without typing anything', async () => {
    for (const [over, status, text] of [
      [{ word: 'working', status: 'working' }, 409, 'working'],
      [{ word: 'blocked', status: 'blocked' }, 409, 'waiting for an answer'],
      [{ word: null, status: null }, 409, 'prompt'],
      [{ machine: 'vps' }, 400, 'this computer'],
      [{ program: 'bash' }, 400, 'Claude Code'],
    ] as const) {
      const { claude, settings, locks } = setup(over as Partial<TerminalView>);
      await expect(settings.read('t1', 'model')).rejects.toMatchObject({ status, message: expect.stringContaining(text) });
      await expect(settings.choose('t1', 'effort', 'low')).rejects.toMatchObject({ status });
      expect(claude.typed).toEqual([]);
      expect(locks()).toBe(0);
    }
    expect(settingsRefusal(undefined)?.status).toBe(404);
    expect(settingsRefusal(agent({ word: 'done' }))).toBeNull();
  });

  it('re-checks inside the lock: an agent that started working while waiting is refused', async () => {
    const { claude, settings, t } = setup();
    const s = settings as unknown as { opts: { exclusive: (id: string, run: (io: TerminalIo) => Promise<unknown>) => Promise<unknown> } };
    const inner = s.opts.exclusive;
    s.opts.exclusive = (id, run) => {
      t.current = agent({ word: 'working', status: 'working' });
      return inner(id, run);
    };
    await expect(settings.read('t1', 'model')).rejects.toMatchObject({ status: 409 });
    expect(claude.typed).toEqual([]);
  });

  it('won’t type over a draft or an open menu', async () => {
    const { claude, settings } = setup();
    claude.draft = 'half a thought';
    await expect(settings.read('t1', 'model')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('draft') });
    claude.draft = '';
    claude.menu = 'effort';
    await expect(settings.read('t1', 'model')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('menu') });
    expect(claude.typed).toEqual([]);
  });

  it('reports a change Claude didn’t confirm, and leaves no menu open', async () => {
    const { claude, settings } = setup();
    claude.deaf = true;
    await expect(settings.choose('t1', 'effort', 'low')).rejects.toMatchObject({ status: 502 });
    expect(claude.menu).toBeNull();
    expect(claude.effort).toBe(2);
  });
});

describe('GET/POST /api/agents/:id/claude/:kind', () => {
  async function app() {
    const calls: unknown[][] = [];
    const settings = {
      read: async (id: string, kind: string) => {
        calls.push(['read', id, kind]);
        return { kind, options: [{ value: 'low', label: 'low' }], current: 'low' };
      },
      choose: async (id: string, kind: string, value: unknown) => {
        calls.push(['choose', id, kind, value]);
        if (value === 'busy') throw new ClaudeSettingsError('Claude is working: try again when it’s idle', 409);
        return { kind, value, message: 'ok' };
      },
    };
    const a = Fastify();
    registerClaudeRoutes(a, { settings: settings as unknown as ClaudeSettings });
    await a.ready();
    return { a, calls };
  }

  it('lists, chooses, refuses with the reason, 404s unknown kinds and remote ids, wants JSON', async () => {
    const { a, calls } = await app();
    const got = await a.inject({ method: 'GET', url: '/api/agents/t1m3/claude/effort' });
    expect(got.statusCode).toBe(200);
    expect(got.headers['cache-control']).toBe('no-store');
    expect(got.json().current).toBe('low');
    const post = (url: string, body: unknown, type = 'application/json') =>
      a.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': type } });
    expect((await post('/api/agents/t1m3/claude/model', { value: 'Haiku 4.5' })).json()).toEqual({
      kind: 'model',
      value: 'Haiku 4.5',
      message: 'ok',
    });
    const busy = await post('/api/agents/t1m3/claude/model', { value: 'busy' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toContain('working');
    expect((await post('/api/agents/t1m3/claude/model', { value: 'x' }, 'text/plain')).statusCode).toBe(415);
    expect((await a.inject({ method: 'GET', url: '/api/agents/t1/claude/theme' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/agents/vps%2Ft1/claude/model' })).statusCode).toBe(404);
    expect(calls).toEqual([
      ['read', 't1m3', 'effort'],
      ['choose', 't1m3', 'model', 'Haiku 4.5'],
      ['choose', 't1m3', 'model', 'busy'],
    ]);
  });

  it('rate-limits menu openings', async () => {
    const { a } = await app();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await a.inject({ method: 'GET', url: '/api/agents/t1/claude/model' })).statusCode);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});
