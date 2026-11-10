import type { AgentStatus, SpaceView, TerminalView, World } from '@herdr-mobile/protocol';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ApproveBar } from '../components/ApproveBar';
import { ConnectionDot, HerdrMark } from '../components/Chrome';
import { Icon } from '../components/Icon';
import { ProgramIcon } from '../components/ProgramIcon';
import { PromptProbe } from '../components/PromptProbe';
import { AlertsButton, FilesButton, Screen, SettingsButton } from '../components/Screen';
import { SpaceTile } from '../components/SpaceTile';
import { StatusGlyph } from '../components/Status';
import { unreadId } from '../components/UnreadMenu';
import { useDrafts, useLive, useNow, useServices, useWorld } from '../hooks/app';
import { duration, plural } from '../lib/format';
import {
  attentionCounts,
  inbox,
  pinnedAgents,
  program,
  type SectionId,
  shownStatus,
  spaceCounts,
  spaceTerminals,
  subAgents,
  terminalName,
} from '../lib/model';
import { navigate } from '../lib/router';
import { runSteps } from '../terminal/answer';
import type { Prompt } from '../terminal/prompt';

/** One agent in a list: icon, name (and where, for pinned ones), sub-agents, a draft, age, status. */
export interface LineData {
  t: TerminalView;
  name: string;
  /** Shown after the name, dim (a pinned agent's space). */
  place: string | null;
  subs: number;
  subTop: AgentStatus | null;
  draft: boolean;
}

function lineData(world: World, t: TerminalView, drafts: ReadonlySet<string>, place: string | null = null): LineData {
  const s = subAgents(world, t);
  return { t, name: terminalName(t, world), place, subs: s.count, subTop: s.top, draft: drafts.has(t.id) };
}

const sameLine = (a: LineData, b: LineData) =>
  a.t === b.t && a.name === b.name && a.place === b.place && a.subs === b.subs && a.subTop === b.subTop && a.draft === b.draft;
const sameLines = (a: readonly LineData[], b: readonly LineData[]) =>
  a.length === b.length && a.every((x, i) => sameLine(x, b[i] as LineData));

export const AgentLine = memo(function AgentLine({ line, now }: { line: LineData; now: number }) {
  const { t } = line;
  const status = shownStatus(t);
  return (
    <button type="button" className="agent-line" onClick={() => navigate({ name: 'agent', terminalId: t.id })} data-press={unreadId(t)}>
      <ProgramIcon program={program(t)} size={15} />
      <span className="agent-line-name">
        <span className="truncate">{line.name}</span>
        {line.place && <span className="agent-line-place truncate">· {line.place}</span>}
      </span>
      {line.draft && (
        <span className="draft-mark" title="Unsent draft" role="img" aria-label="Unsent draft">
          <Icon name="pencil" size={12} />
        </span>
      )}
      {line.subs > 0 && (
        <span
          className={`sub-chip${line.subTop && line.subTop !== 'idle' ? ` t-${line.subTop}` : ''}`}
          title={plural(line.subs, 'sub-agent')}
        >
          +{line.subs}
        </span>
      )}
      {t.statusMs ? <span className="age">{duration(now - t.statusMs)}</span> : null}
      <StatusGlyph status={status} compact />
    </button>
  );
});

/** Herdr's answers right in the list (Moshi's "Needs you" Allow/Deny): read off the agent's screen, one tap each. */
function InlineAnswer({ t }: { t: TerminalView }) {
  const { terminals, toasts } = useServices();
  const live = useLive();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [read, setRead] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(id);
  }, []);
  const got = useCallback((p: Prompt | null) => {
    setPrompt(p);
    setRead(true);
  }, []);
  return (
    <div className="inline-answer">
      <PromptProbe terminalId={t.id} onPrompt={got} />
      <ApproveBar
        inline
        offline={!live}
        prompt={prompt}
        reading={!read && !timedOut}
        onOpen={() => navigate({ name: 'agent', terminalId: t.id, view: 'conversation' })}
        onSteps={async (steps) => {
          try {
            await runSteps(terminals, t.id, t.turn, steps);
          } catch (e) {
            toasts.show(
              { id: `err-${Date.now()}`, title: "Couldn't answer", body: (e as Error).message, level: 'error', terminalId: t.id },
              5000,
            );
          }
        }}
      />
    </div>
  );
}

/** At most this many blocked agents get their answers inline (each streams its terminal unseen to read them). */
const INLINE_ANSWERS = 3;

const SpaceCard = memo(
  function SpaceCard({
    space,
    section,
    meta,
    lines,
    answers,
    now,
  }: {
    space: SpaceView;
    section: SectionId;
    meta: string;
    lines: readonly LineData[];
    /** Agents (ids) answered right here. */
    answers: readonly string[];
    now: number;
  }) {
    return (
      <div className={`space-card sec-${section}`}>
        <button type="button" className="space-row" onClick={() => navigate({ name: 'space', spaceId: space.id })}>
          <SpaceTile space={space} size={34} />
          <span className="space-row-text">
            <span className="space-row-name">
              <span className="truncate">{space.name}</span>
              {space.machine && <span className="machine-tag">{space.machine}</span>}
            </span>
            <span className="space-row-meta">{meta}</span>
          </span>
          <span className="space-row-end">
            <StatusGlyph status={space.status} />
            <Icon name="chevron-right" size={16} className="chev" />
          </span>
        </button>
        {lines.length > 0 && (
          <div className="space-agents">
            {lines.map((l) => (
              <div key={l.t.id}>
                <AgentLine line={l} now={now} />
                {answers.includes(l.t.id) && <InlineAnswer t={l.t} />}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
  (a, b) =>
    a.space === b.space &&
    a.section === b.section &&
    a.meta === b.meta &&
    a.now === b.now &&
    sameLines(a.lines, b.lines) &&
    a.answers.join() === b.answers.join(),
);

/** An idle space: one compact row (Herdr's sidebar shows no mark for them either). */
const SpaceLine = memo(function SpaceLine({ space, meta }: { space: SpaceView; meta: string }) {
  return (
    <button type="button" className="space-line" onClick={() => navigate({ name: 'space', spaceId: space.id })}>
      <SpaceTile space={space} size={26} />
      <span className="space-line-name truncate">{space.name}</span>
      {space.machine && <span className="machine-tag">{space.machine}</span>}
      <span className="space-line-meta">{meta}</span>
      <Icon name="chevron-right" size={15} className="chev" />
    </button>
  );
});

function spaceMeta(world: World, space: SpaceView, section: SectionId, short = false): string {
  const c = spaceCounts(world, space.id);
  if (short) return c.agents ? plural(c.agents, 'agent') : c.terminals ? plural(c.terminals, 'terminal') : 'Empty';
  const parts = [c.agents ? plural(c.agents, 'agent') : 'No agents', c.tabs ? plural(c.tabs, 'tab') : plural(c.terminals, 'terminal')];
  if (c.working && section !== 'working') parts.push(`${c.working} working`);
  if (c.blocked && section !== 'blocked') parts.push(`${c.blocked} need${c.blocked === 1 ? 's' : ''} you`);
  return parts.join(' · ');
}

/** Screen 1: every space, filed by what it needs (Needs you / Working / Done / Idle), pinned agents first. */
export function SpacesScreen({ embedded = false }: { embedded?: boolean }) {
  const world = useWorld();
  const now = useNow();
  const drafts = useDrafts();
  const groups = useMemo(() => inbox(world), [world]);
  const pinned = useMemo(() => {
    return pinnedAgents(world).map((t) => {
      const space = t.spaceId ? world.spaces[t.spaceId] : undefined;
      return lineData(world, t, drafts, space?.name ?? null);
    });
  }, [world, drafts]);
  const counts = useMemo(() => attentionCounts(world), [world]);
  const multiMachine = groups.length > 1;
  // The first few blocked agents (pinned first, as listed) answer right here.
  const answers = useMemo(() => {
    const out: string[] = [];
    for (const g of groups)
      for (const sec of g.sections)
        if (sec.id === 'blocked')
          for (const s of sec.spaces)
            for (const t of spaceTerminals(world, s.id))
              if (shownStatus(t) === 'blocked' && !t.parent && out.length < INLINE_ANSWERS) out.push(t.id);
    return out;
  }, [groups, world]);

  const body = (
    <div className="scroll">
      <div className="summary">
        <span>
          {plural(counts.agents, 'agent')}
          {counts.blocked > 0 && (
            <span className="t-blocked">
              {' '}
              · {counts.blocked} {counts.blocked === 1 ? 'needs' : 'need'} you
            </span>
          )}
          {counts.done > 0 && <span className="t-done"> · {counts.done} done</span>}
        </span>
        <span className="summary-machine">
          <Icon name="monitor" size={13} />
          {world.core.name ?? 'This computer'}
        </span>
      </div>
      {groups.length === 0 && (
        <div className="state-card">
          <Icon name={world.core.connected ? 'layers' : 'monitor'} size={22} />
          <h3>{world.core.connected ? 'No spaces yet' : 'Waiting for Herdr…'}</h3>
          <p>
            {world.core.connected
              ? 'Make one here or in Herdr on the desktop; it shows up at once.'
              : 'Spaces show up as soon as Herdr runs.'}
          </p>
          {world.core.connected && (
            <button type="button" className="btn btn-small" onClick={() => navigate({ name: 'new' })}>
              <Icon name="plus" size={14} />
              New space
            </button>
          )}
        </div>
      )}
      {pinned.length > 0 && (
        <section className="inbox-section">
          <h2 className="section-head">
            <Icon name="pin" size={12} />
            Pinned
            <span className="section-count">{pinned.length}</span>
          </h2>
          <div className="list-card">
            {pinned.map((l) => (
              <AgentLine key={l.t.id} line={l} now={now} />
            ))}
          </div>
        </section>
      )}
      {groups.map((g) => (
        <div key={g.machine ?? 'local'} className="machine-group">
          {multiMachine && (
            <div className="machine-head">
              <Icon name={g.machine ? 'server' : 'monitor'} size={13} />
              <span>{g.machine ?? 'This computer'}</span>
            </div>
          )}
          {g.sections.map((sec) => (
            <section key={sec.id} className="inbox-section">
              <h2 className={`section-head t-${sec.id === 'idle' ? 'dim' : sec.id}`}>
                {sec.label}
                <span className="section-count">{sec.spaces.length}</span>
              </h2>
              {sec.id === 'idle' ? (
                <div className="list-card">
                  {sec.spaces.map((s) => (
                    <SpaceLine key={s.id} space={s} meta={spaceMeta(world, s, sec.id, true)} />
                  ))}
                </div>
              ) : (
                sec.spaces.map((s) => (
                  <SpaceCard
                    key={s.id}
                    space={s}
                    section={sec.id}
                    meta={spaceMeta(world, s, sec.id)}
                    lines={spaceTerminals(world, s.id)
                      .filter((t) => !t.parent && shownStatus(t) === sec.id)
                      .slice(0, 4)
                      .map((t) => lineData(world, t, drafts))}
                    answers={answers}
                    now={now}
                  />
                ))
              )}
            </section>
          ))}
        </div>
      ))}
    </div>
  );
  if (embedded) return <div className="main-page">{body}</div>;
  return (
    <Screen
      bar={
        <header className="topbar">
          <HerdrMark size={22} />
          <span className="topbar-title">Herdr</span>
          <ConnectionDot withLabel />
          <span className="spacer" />
          <FilesButton />
          <button type="button" className="icon-btn" onClick={() => navigate({ name: 'new' })} aria-label="New space">
            <Icon name="plus" size={19} />
          </button>
          <SettingsButton />
          <AlertsButton />
        </header>
      }
    >
      {body}
    </Screen>
  );
}
