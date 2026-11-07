import type { TabView, TerminalView, World } from '@herdr-mobile/protocol';
import { useMemo, useRef, useState } from 'react';
import { AddButton, AddToSpace } from '../components/AddToSpace';
import { AgentRow } from '../components/AgentRow';
import { Icon } from '../components/Icon';
import { ProgramIcon } from '../components/ProgramIcon';
import { AlertsButton, BackButton, Screen } from '../components/Screen';
import { SpaceTile } from '../components/SpaceTile';
import { StatusGlyph } from '../components/Status';
import { useDrafts, useNow, useWorld } from '../hooks/app';
import { useTapGuard } from '../hooks/gestures';
import { folder, plural } from '../lib/format';
import { leadOf, program, spaceCounts, spaceOf, spaceTabs, type TabGroup, terminalName } from '../lib/model';
import { back } from '../lib/router';

/** Herdr's tab pill: program icon, the tab's name, a spinner while working, a dot when it wants you. */
export function TabPill({ tab, label, active, onClick }: { tab: TabView; label: string; active?: boolean; onClick?: () => void }) {
  const world = useWorld();
  const lead = leadOf(tab, world);
  const p = lead ? program(lead) : null;
  return (
    <button type="button" className={`tab-pill${active ? ' active' : ''}`} onClick={onClick} title={label}>
      {p && <ProgramIcon program={p} size={14} />}
      <span className="tab-pill-name">{label}</span>
      {tab.status === 'working' && <Icon name="spinner" size={12} spin className="t-working" />}
      {(tab.status === 'blocked' || tab.status === 'done') && <span className={`tab-dot bg-${tab.status}`} />}
    </button>
  );
}

/** "Claude Code · ~/code/x", plus the tab's own name when it says something the row's name doesn't. */
export function rowDetail(t: TerminalView, name: string, tabName?: string): string {
  const p = program(t);
  const parts: string[] = [];
  if (tabName && tabName !== name && !/^\d+$/.test(tabName)) parts.push(tabName);
  if (p.name !== name) parts.push(p.name);
  parts.push(folder(t.cwd));
  return parts.filter(Boolean).join(' · ');
}

/**
 * A several-terminal tab's header: like Herdr's tab pill, an unnamed tab goes by its number (its live label
 * is its lead's title, which the lead's row already shows); a named one by its name, unless the lead's row
 * says the same.
 */
function groupName(g: TabGroup, world: World): string {
  if (!g.tab) return g.label;
  const lead = g.rows[0]?.t;
  if (g.tab.named && !/^\d+$/.test(g.tab.name) && (!lead || terminalName(lead, world) !== g.tab.name)) return g.tab.name;
  return '';
}

/** More tabs than this: a strip of tab pills at the top to jump between them. */
const STRIP_FROM = 6;

/** Screen 2: a space's tabs and the terminals in them; a tab of one terminal is one row, others get a header. */
export function SpaceScreen({ spaceId, embedded = false }: { spaceId: string; embedded?: boolean }) {
  const world = useWorld();
  const now = useNow();
  const drafts = useDrafts();
  const space = spaceOf(world, spaceId);
  const groups = useMemo(() => spaceTabs(world, spaceId), [world, spaceId]);
  const sections = useRef(new Map<string, HTMLElement>());
  const stripGuard = useTapGuard<HTMLElement>();
  const [adding, setAdding] = useState(false);

  if (!space) {
    return (
      <Screen
        bar={
          <header className="topbar">
            <BackButton onClick={() => back({ name: 'spaces' })} />
            <span className="topbar-title">Space</span>
          </header>
        }
      >
        <div className="scroll">
          <div className="state-card">
            <Icon name={world.core.connected ? 'ban' : 'monitor'} size={22} />
            <h3>{world.core.connected ? 'This space is gone' : 'Waiting for Herdr…'}</h3>
            <p>{world.core.connected ? 'It was closed on the desktop.' : 'Its tabs show up again when Herdr is back.'}</p>
          </div>
        </div>
      </Screen>
    );
  }
  const c = spaceCounts(world, spaceId);
  const tabs = groups.filter((g) => g.tab);
  // Runs of one-terminal tabs share a card; a tab with several terminals (or sub-agents) gets its own, under a header.
  const blocks: Array<{ single: boolean; groups: TabGroup[] }> = [];
  for (const g of groups) {
    const single = g.tab !== null && g.rows.length === 1;
    const last = blocks.at(-1);
    if (single && last?.single) last.groups.push(g);
    else blocks.push({ single, groups: [g] });
  }
  const mark = (g: TabGroup) => (el: HTMLElement | null) => {
    if (el && g.tab) sections.current.set(g.tab.id, el);
  };
  const body = (
    <div className="scroll">
      {!embedded && tabs.length >= STRIP_FROM && (
        <nav ref={stripGuard} className="tab-strip" aria-label="Tabs">
          {tabs.map((g) => (
            <TabPill
              key={g.tab?.id}
              tab={g.tab as TabView}
              label={g.label}
              onClick={() => sections.current.get(g.tab?.id ?? '')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          ))}
        </nav>
      )}
      {groups.length === 0 && (
        <div className="state-card">
          <Icon name="terminal" size={22} />
          <h3>No terminals here</h3>
          <p>{space.machine === null ? 'Open a tab with the + above, or on the desktop.' : 'Open a tab in this space on the desktop.'}</p>
        </div>
      )}
      {blocks.map((b, bi) =>
        b.single ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional.
          <div key={`s${bi}`} className="rows tab-rows">
            {b.groups.map((g) => {
              const r = g.rows[0];
              if (!r) return null;
              const name = terminalName(r.t, world);
              return (
                <div key={g.tab?.id} ref={mark(g)} className="tab-anchor">
                  <AgentRow
                    row={r}
                    name={name}
                    detail={rowDetail(r.t, name, g.label)}
                    tabNo={g.tab?.index}
                    draft={drafts.has(r.t.id)}
                    now={now}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          b.groups.map((g, i) => (
            <section key={g.tab?.id ?? `u${i}`} className="tab-group" ref={mark(g)}>
              <h2 className="group-head">
                {g.tab && <span className="group-index">{g.tab.index}</span>}
                <span className="group-name">{groupName(g, world)}</span>
                <span className="group-meta">{plural(g.rows.filter((r) => r.depth === 0).length, 'terminal')}</span>
                <span className="spacer" />
                {g.tab && <StatusGlyph status={g.tab.status} compact />}
              </h2>
              <div className="rows">
                {g.rows.map((r) => {
                  const name = terminalName(r.t, world);
                  return (
                    <AgentRow
                      key={r.t.id}
                      row={r}
                      name={name}
                      detail={r.depth ? '' : rowDetail(r.t, name)}
                      draft={drafts.has(r.t.id)}
                      now={now}
                    />
                  );
                })}
              </div>
            </section>
          ))
        ),
      )}
    </div>
  );
  if (embedded) return <div className="main-page">{body}</div>;
  return (
    <Screen
      bar={
        <header className="topbar">
          <BackButton onClick={() => back({ name: 'spaces' })} />
          <SpaceTile space={space} size={22} />
          <span className="topbar-stack">
            <span className="topbar-title">{space.name}</span>
            <span className="topbar-sub">
              {[c.agents ? plural(c.agents, 'agent') : 'No agents', plural(c.tabs || c.terminals, c.tabs ? 'tab' : 'terminal')].join(' · ')}
            </span>
          </span>
          <span className="spacer" />
          <StatusGlyph status={space.status} />
          {space.machine === null && <AddButton onClick={() => setAdding(true)} />}
          <AlertsButton />
        </header>
      }
    >
      {body}
      {adding && <AddToSpace spaceId={space.id} onClose={() => setAdding(false)} />}
    </Screen>
  );
}
