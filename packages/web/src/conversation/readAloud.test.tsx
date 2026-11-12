// @vitest-environment jsdom
import type { ConversationServerMessage, ConvItem, ToolItem, World } from '@herdr-mobile/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServicesContext } from '../hooks/app';
import type { Services } from '../lib/app';
import { copyText } from '../lib/copy';
import { speech, splitSentences } from '../lib/speech';
import { FakeSynth, FakeUtterance } from '../test/fakeSpeech';
import { FakeWs } from '../test/fakeWs';
import { sampleWorld } from '../test/fixtures';
import { renderWith } from '../test/render';
import { ConversationView } from './ConversationView';
import { Markdown } from './Markdown';
import { sentenceRange, textMap } from './ReadAloud';
import { markdownToSpeech } from './speechText';

const REPLY = [
  '## Plan',
  '',
  'First, read the [docs](https://example.com/docs) and run `npm test` now. **Then** fix it!',
  '',
  '- one item',
  '- two *items*',
  '',
  '```bash',
  'echo SECRET',
  '```',
  '',
  '> Quoted line',
  '',
  '| Name | Size |',
  '| --- | --- |',
  '| a.txt | 3 |',
  '',
  'See https://example.com/x for more.',
].join('\n');

describe('markdownToSpeech', () => {
  it('drops code, symbols and URLs; reads links as their text; headings and list items as sentences', () => {
    const text = markdownToSpeech(REPLY);
    expect(text).not.toMatch(/SECRET|npm test|[`*#|>[\]]|https?:/);
    expect(splitSentences(text, 'en')).toEqual([
      'Plan.',
      'First, read the docs and run now.',
      'Then fix it!',
      'one item.',
      'two items.',
      'Quoted line.',
      'Name, Size.',
      'a.txt, 3.',
      'See link for more.',
    ]);
  });

  it('a reply of only code has nothing to say', () => {
    expect(splitSentences(markdownToSpeech('```\nls -la\n```'), 'en')).toEqual([]);
  });
});

describe('sentence highlight', () => {
  afterEach(cleanup);
  it('finds each sentence in the rendered reply, in order, outside code', () => {
    const { container } = render(<Markdown text={REPLY} />);
    const sentences = splitSentences(markdownToSpeech(REPLY), 'en');
    const map = textMap([container.querySelector('.md') as Element]);
    expect(map.text).not.toContain('secret');
    const shown = sentences.map((_, i) => sentenceRange(map, sentences, i)?.toString() ?? null);
    expect(shown[0]).toBe('Plan');
    expect(shown[1]).toBe('First, read the docs and run npm test now.');
    expect(shown[2]).toBe('Then fix it!');
    expect(shown[4]).toBe('two items');
    // "link" isn't in the page: found by its first and last letters.
    expect(shown[8]).toBe('See https://example.com/x for more.');
  });
});

const user = (id: string, text: string): ConvItem => ({ kind: 'user', id, ts: 0, text, source: 'prompt', images: 0 });
const reply = (id: string, text: string): ConvItem => ({ kind: 'assistant', id, ts: 0, text });
const bash = (id: string): ToolItem => ({
  kind: 'tool',
  id,
  ts: 0,
  name: 'Bash',
  input: { type: 'bash', summary: 'ls', command: 'ls' },
  result: { isError: false, text: 'a' },
});

function live(world: World) {
  FakeWs.all = [];
  const r = renderWith(<div />, world);
  r.services.conn.start();
  const ws = FakeWs.last();
  ws.open();
  ws.receive({ t: 'welcome', v: 1, serverId: 'srv', heartbeatMs: 15000 });
  ws.receive({ t: 'snapshot', seq: 1, world, alerts: [] });
  const send = (m: ConversationServerMessage) => act(() => ws.receive(m));
  return { ...r, ws, send };
}

function view(items: ConvItem[]) {
  const world = sampleWorld();
  const t1 = world.terminals.t1;
  if (!t1) throw new Error('fixture');
  const { services, ws, send } = live(world);
  const r = render(<ConversationView t={{ ...t1, status: 'idle', word: 'idle' }} onStop={() => {}} onShowTerminal={() => {}} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ServicesContext.Provider value={services as Services}>{children}</ServicesContext.Provider>
    ),
  });
  const open = ws
    .json()
    .filter((m) => m.t === 'conv.open')
    .at(-1) as { req: number };
  send({
    t: 'conv.opened',
    req: open.req,
    stream: 3,
    terminalId: 't1',
    source: { format: 'claude', session: 's', path: '/p.jsonl' },
    meta: {},
    v: 1,
    items,
    before: null,
  });
  return { ...r, services };
}

describe('read aloud in the conversation', () => {
  let synth: FakeSynth;
  beforeEach(() => {
    synth = new FakeSynth();
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  });
  afterEach(() => {
    act(() => speech.close());
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('a speaker on each message reads it, docks a player, and stops when the view goes', () => {
    const r = view([
      user('u1', 'q'),
      reply('a1', 'Hello there. Second one. Third.'),
      bash('b'),
      reply('a2', 'Done now.'),
      user('u2', 'q2'),
      reply('a3', 'Other.'),
    ]);
    const speakers = screen.getAllByRole('button', { name: 'Read the reply aloud' });
    expect(speakers).toHaveLength(3);
    fireEvent.click(speakers[0] as HTMLElement);
    expect(synth.texts).toEqual(['Hello there.']);
    expect(screen.getByRole('region', { name: 'Read aloud' })).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
    act(() => synth.finish());
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next sentence' }));
    expect(synth.last?.text).toBe('Third.');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(speech.get()).toMatchObject({ playing: false, index: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(synth.last?.text).toBe('Third.');
    fireEvent.click(screen.getByRole('button', { name: 'Reading speed 1×' }));
    expect(synth.last?.rate).toBe(1.25);
    // The screen changes: paused, still loaded at the same sentence.
    r.unmount();
    expect(speech.get()).toMatchObject({ playing: false, index: 2, key: 'a1' });
  });

  it('a turn with several messages: the buttons under each act on that message only, highlight included', async () => {
    vi.stubGlobal('isSecureContext', false);
    let copied: string | null = null;
    document.execCommand = vi.fn(() => {
      const ta = document.activeElement as HTMLTextAreaElement;
      copied = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      return true;
    });
    const { container } = view([
      user('u1', 'q'),
      reply('a', 'Got it. Option 1 first.'),
      bash('t1'),
      reply('b', 'Checked the **files**.'),
      bash('t2'),
      reply('c1', 'All done.'),
      reply('c2', 'Final *answer* here.'),
    ]);
    const speakers = screen.getAllByRole('button', { name: 'Read the reply aloud' });
    const copies = screen.getAllByRole('button', { name: 'Copy the reply' });
    // One pair per message: A, B, and C (whose two texts sit together with nothing between them).
    expect(speakers).toHaveLength(3);
    expect(copies).toHaveLength(3);
    const cases = [
      { said: ['Got it.', 'Option 1 first.'], md: 'Got it. Option 1 first.', key: 'a' },
      { said: ['Checked the files.'], md: 'Checked the **files**.', key: 'b' },
      { said: ['All done.', 'Final answer here.'], md: 'All done.\n\nFinal *answer* here.', key: 'c2' },
    ];
    for (const [i, c] of cases.entries()) {
      fireEvent.click(speakers[i] as HTMLElement);
      expect(speech.get()).toMatchObject({ key: c.key, sentences: c.said, index: 0 });
      expect(synth.last?.text).toBe(c.said[0]);
      // The highlight looks only inside this message's texts.
      const shown = Array.from(container.querySelectorAll(`[data-reply="${c.key}"] .md`), (el) => el.textContent).join(' ');
      expect(shown).toContain(c.said[0]?.replace(/\.$/, ''));
      expect(shown).not.toContain(i === 2 ? 'Got it' : 'Final');
      copied = null;
      fireEvent.click(copies[i] as HTMLElement);
      expect(copied).toBe(c.md);
    }
    await act(async () => {});
  });

  it('page hidden pauses; close removes the player', () => {
    view([user('u1', 'q'), reply('a1', 'One. Two.')]);
    fireEvent.click(screen.getByRole('button', { name: 'Read the reply aloud' }));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(speech.get().playing).toBe(false);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Close the player' }));
    expect(screen.queryByRole('region', { name: 'Read aloud' })).toBeNull();
  });

  it('no speaker without speechSynthesis', () => {
    vi.unstubAllGlobals();
    // jsdom has none.
    view([user('u1', 'q'), reply('a1', 'One.')]);
    expect(screen.getByRole('button', { name: 'Copy the reply' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Read the reply aloud' })).toBeNull();
  });
});

describe('copy over plain HTTP', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses execCommand on a selected hidden textarea, synchronously, with the exact text', async () => {
    vi.stubGlobal('isSecureContext', false);
    let copied: string | null = null;
    document.execCommand = vi.fn(() => {
      const ta = document.activeElement as HTMLTextAreaElement;
      copied = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      return true;
    });
    const p = copyText('**Bold** and `code`\n\n- item');
    // Already done before the first await (still inside the tap).
    expect(copied).toBe('**Bold** and `code`\n\n- item');
    expect(await p).toBe(true);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
