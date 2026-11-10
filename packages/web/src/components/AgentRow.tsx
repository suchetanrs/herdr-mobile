import type { TerminalView } from '@herdr-mobile/protocol';
import { memo } from 'react';
import { duration } from '../lib/format';
import { accountLabel, program, shownStatus, type TreeRow } from '../lib/model';
import { navigate } from '../lib/router';
import { Icon } from './Icon';
import { ProgramIcon } from './ProgramIcon';
import { StatusGlyph } from './Status';
import { unreadId } from './UnreadMenu';

/** Tree lines in front of a sub-agent (agents mod `subRow`). */
export function TreeLines({ lines }: { lines: string[] }) {
  return (
    <span className="tree" aria-hidden="true">
      {lines.map((l, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature.
          key={i}
          className={`tree-seg${l ? ' tree-v' : ''}${l === '└' || l === '├' ? ' tree-elbow' : ''}${l === '├' ? ' tree-tee' : ''}`}
        />
      ))}
    </span>
  );
}

/** One terminal in a space: icon, name, what/where, age, status (sub-agents nested under their parent). */
export const AgentRow = memo(function AgentRow({
  row,
  name,
  detail,
  tabNo,
  draft = false,
  now,
  active,
  onOpen,
}: {
  row: TreeRow;
  name: string;
  /** What and where ("Claude Code · ~/code/x"); none for sub-agents. */
  detail: string;
  /** The tab's number, when this row is the whole tab. */
  tabNo?: number | undefined;
  draft?: boolean;
  now: number;
  active?: boolean;
  onOpen?: (t: TerminalView) => void;
}) {
  const t = row.t;
  const status = shownStatus(t);
  const sub = row.depth > 0;
  const account = sub ? null : accountLabel(t);
  return (
    <button
      type="button"
      className={`agent-row${sub ? ' sub' : ''}${active ? ' active' : ''}${status === null ? ' plain' : ''}`}
      onClick={() => (onOpen ? onOpen(t) : navigate({ name: 'agent', terminalId: t.id }))}
      data-press={unreadId(t)}
    >
      {sub && <TreeLines lines={row.lines} />}
      <ProgramIcon program={program(t)} size={sub ? 14 : 16} tile={!sub} />
      <span className="agent-row-text">
        <span className="agent-row-name">
          <span className="truncate">{name}</span>
          {t.pinned && !sub && <Icon name="pin" size={11} className="pin-mark" />}
        </span>
        {!sub && (detail || tabNo !== undefined) && (
          <span className="agent-row-detail">
            {tabNo !== undefined && <span className="tab-no">{tabNo}</span>}
            <span className="truncate">{detail}</span>
          </span>
        )}
      </span>
      {draft && (
        <span className="draft-mark" title="Unsent draft" role="img" aria-label="Unsent draft">
          <Icon name="pencil" size={12} />
        </span>
      )}
      {account && (
        <span className="account" title={`Claude account: ${account}`}>
          {account}
        </span>
      )}
      {t.statusMs && status ? <span className="age">{duration(now - t.statusMs)}</span> : null}
      <StatusGlyph status={status} />
      {!sub && <Icon name="chevron-right" size={16} className="chev" />}
    </button>
  );
});
