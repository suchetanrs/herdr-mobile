import type { AgentStatus } from '@herdr-mobile/protocol';
import { Icon } from './Icon';

const LABEL: Record<AgentStatus, string> = { blocked: 'Needs you', working: 'Working', done: 'Done', idle: 'Idle' };

/**
 * Herdr's status marks (agents mod `status`): a spinning ring while working,
 * a "Needs you" pill (or "!" where a header already says it) when blocked,
 * a filled dot when done and unseen, a ring when idle.
 */
export function StatusGlyph({ status, compact = false }: { status: AgentStatus | null; compact?: boolean }) {
  if (!status) return null;
  const label = LABEL[status];
  if (status === 'working')
    return (
      <span className="st st-working" title={label} role="img" aria-label={label}>
        <Icon name="spinner" size={12} spin />
      </span>
    );
  if (status === 'blocked')
    return compact ? (
      <span className="st st-bang" title={label} role="img" aria-label={label}>
        !
      </span>
    ) : (
      <span className="st st-pill">{label}</span>
    );
  return <span className={`st st-${status}`} title={label} role="img" aria-label={label} />;
}

export function statusLabel(status: AgentStatus | null): string {
  return status ? LABEL[status] : 'No agent';
}
