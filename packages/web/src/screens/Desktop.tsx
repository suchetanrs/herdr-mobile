import type { TerminalView, World } from '@herdr-mobile/protocol';
import { useMemo } from 'react';
import { TreeLines } from '../components/AgentRow';
import { ConnectionDot, HerdrMark, ReconnectBanner } from '../components/Chrome';
import { Icon } from '../components/Icon';
import { ProgramIcon } from '../components/ProgramIcon';
import { AlertsButton } from '../components/Screen';
import { SpaceTile } from '../components/SpaceTile';
import { StatusGlyph } from '../components/Status';
import { useNow, useWorld } from '../hooks/app';
import { duration } from '../lib/format';
import {
  agentTag,
  attentionCounts,
  inbox,
  leadOf,
  pinnedAgents,
  program,
  shownStatus,
  spaceIdOf,
  spaceOf,
  spaceTabs,
  terminalName,
  UNPLACED,
  unplacedSpace,
  withSubAgents,
} from '../lib/model';
import { navigate, type Route } from '../lib/router';
import { AgentScreen } from './AgentScreen';
import { AlertsScreen } from './AlertsScreen';
import { SpacesScreen, TabPillRow } from './DesktopParts';
import { NewSpaceScreen } from './NewSpaceScreen';
import { SettingsScreen } from './SettingsScreen';
import { SpaceScreen } from './SpaceScreen';

function SidebarSpaces({ world, activeSpace }: { world: World; activeSpace: string | null }) {
  const extra = unplacedSpace(world);
  const spaces = [...world.spaceOrder.map((id) => world.spaces[id]).filter((s) => s !== undefined), ...(extra ? [extra] : [])];
  const multi = inbox(world).length > 1;
  let lastMachine: string | null | undefined;
  return (
    <div className="sb-list">
      {spaces.map((s) => {
        const head = multi && s.machine !== lastMachine;
        lastMachine = s.machine;
        return (
          <div key={s.id}>
            {head && (
              <div className="sb-machine">
                <Icon name={s.machine ? 'server' : 'monitor'} size={13} />
                {s.machine ?? 'This computer'}
              </div>
            )}
            <button
              type="button"
              className={`sb-space${activeSpace === s.id ? ' active' : ''}`}
              onClick={() => navigate({ name: 'space', spaceId: s.id })}
            >
              <SpaceTile space={s} />
              <span className="sb-space-name">{s.name}</span>
              <span className="spacer" />
              {s.status && s.status !== 'idle' && <StatusGlyph status={s.status} compact />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SidebarAgents({ world, activeAgent }: { world: World; activeAgent: string | null }) {
  const now = useNow();
  // Herdr's "Grouped by space" agents list: agents only, sub-agents nested under their parent.
  // Pinned agents first, in their own group, naming their space (agents mod `render`).
  const groups = useMemo(() => {
    const ids = [...world.spaceOrder, UNPLACED];
    const pinned = pinnedAgents(world);
    const out: Array<{ id: string; label: string; pinned: boolean; rows: ReturnType<typeof withSubAgents> }> = [];
    if (pinned.length) out.push({ id: 'pinned', label: 'Pinned', pinned: true, rows: pinned.flatMap((t) => withSubAgents(world, t)) });
    for (const id of ids) {
      const space = spaceOf(world, id);
      const rows = spaceTabs(world, id)
        .flatMap((g) => g.rows)
        .filter((r) => r.depth === 0 && shownStatus(r.t) !== null && !r.t.pinned)
        .flatMap((r) => withSubAgents(world, r.t));
      if (space && rows.length) out.push({ id: space.id, label: space.name, pinned: false, rows });
    }
    return out;
  }, [world]);
  const row = (t: TerminalView, lines: string[], depth: number, inPinned: boolean) => {
    const space = inPinned && !depth && t.spaceId ? world.spaces[t.spaceId] : undefined;
    return (
      <button
        type="button"
        key={t.id}
        className={`sb-agent${depth ? ' sub' : ''}${activeAgent === t.id ? ' active' : ''}${shownStatus(t) === 'idle' && activeAgent !== t.id ? ' idle' : ''}`}
        onClick={() => navigate({ name: 'agent', terminalId: t.id })}
      >
        {depth > 0 && <TreeLines lines={lines} />}
        <ProgramIcon program={program(t)} size={depth ? 14 : 16} />
        <span className="sb-agent-name">
          {space ? (
            <>
              {space.name}
              <span className="sb-agent-more"> · {terminalName(t, world)}</span>
            </>
          ) : (
            terminalName(t, world)
          )}
        </span>
        {!depth && agentTag(t) && <span className="account">{agentTag(t)}</span>}
        {!depth && t.statusMs ? <span className="age">{duration(now - t.statusMs)}</span> : null}
        <StatusGlyph status={shownStatus(t)} compact={depth > 0} />
      </button>
    );
  };
  return (
    <div className="sb-agents">
      <div className="sb-label">
        <span>Agents</span>
        <Icon name="layers" size={14} />
      </div>
      <div className="sb-list">
        {groups.length === 0 && <div className="sb-empty">No agent status yet. Agents show up here when they report their status.</div>}
        {groups.map((g) => (
          <div key={g.id} className="sb-group">
            <div className="sb-group-head">{g.label}</div>
            {g.rows.map((r) => row(r.t, r.lines, r.depth, g.pinned))}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBar({ world }: { world: World }) {
  const c = attentionCounts(world);
  return (
    <footer className="statusbar">
      <span className="sbar-item">
        <Icon name="monitor" size={13} />
        {world.core.name ? `${world.core.name}` : 'This computer'}
      </span>
      <span className="sbar-item">
        <span className="sbar-dot" />
        {c.agents} agents
        {c.blocked > 0 && <span className="t-blocked">· {c.blocked} needs you</span>}
      </span>
      <span className="spacer" />
      <ConnectionDot withLabel />
    </footer>
  );
}

/**
 * The desktop layout, after Herdr's own window: sidebar (spaces, agents),
 * the space's tab bar, the pane, the status bar.
 */
export function Desktop({ route }: { route: Route }) {
  const world = useWorld();
  const agent = route.name === 'agent' ? world.terminals[route.terminalId] : undefined;
  const activeSpace = route.name === 'space' ? route.spaceId : agent ? spaceIdOf(agent) : null;
  const space = activeSpace ? spaceOf(world, activeSpace) : null;
  const tabs = activeSpace ? spaceTabs(world, activeSpace) : [];
  return (
    <div className="desktop">
      <aside className="sidebar">
        <div className="sb-head">
          <HerdrMark size={18} />
          <span className="sb-title">Herdr</span>
          <span className="spacer" />
          <ConnectionDot />
          <AlertsButton />
        </div>
        <div className="sb-label">
          <button type="button" className="sb-label-link" onClick={() => navigate({ name: 'spaces' })}>
            Spaces
          </button>
          <button
            type="button"
            className={`sb-label-btn${route.name === 'new' ? ' active' : ''}`}
            onClick={() => navigate({ name: 'new' })}
            aria-label="New space"
            title="New space"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <SidebarSpaces world={world} activeSpace={activeSpace} />
        <SidebarAgents world={world} activeAgent={agent?.id ?? null} />
        <div className="sb-foot">
          <button
            type="button"
            className={`sb-foot-btn${route.name === 'settings' ? ' active' : ''}`}
            onClick={() => navigate({ name: 'settings' })}
          >
            <Icon name="settings" size={15} />
            Settings
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="tabbar">
          {space && tabs.some((g) => g.tab) ? (
            <TabPillRow
              groups={tabs}
              activeTab={agent?.tabId ?? null}
              onPick={(g) => {
                const lead = g.tab ? leadOf(g.tab, world) : g.rows[0]?.t;
                if (lead) navigate({ name: 'agent', terminalId: lead.id });
              }}
            />
          ) : (
            <span className="tabbar-title">
              {route.name === 'alerts'
                ? 'Alerts'
                : route.name === 'settings'
                  ? 'Settings'
                  : route.name === 'new'
                    ? 'New space'
                    : space
                      ? space.name
                      : 'All spaces'}
            </span>
          )}
        </div>
        <ReconnectBanner />
        <div className="main-body">
          {route.name === 'agent' ? (
            <AgentScreen key={route.terminalId} terminalId={route.terminalId} view={route.view} embedded />
          ) : route.name === 'space' ? (
            <SpaceScreen spaceId={route.spaceId} embedded />
          ) : route.name === 'alerts' ? (
            <AlertsScreen embedded />
          ) : route.name === 'settings' ? (
            <SettingsScreen embedded />
          ) : route.name === 'new' ? (
            <NewSpaceScreen embedded />
          ) : (
            <SpacesScreen embedded />
          )}
        </div>
        <StatusBar world={world} />
      </main>
    </div>
  );
}
