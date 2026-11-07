import type { TabView } from '@herdr-mobile/protocol';
import { useTapGuard } from '../hooks/gestures';
import type { TabGroup } from '../lib/model';
import { TabPill } from './SpaceScreen';

export { SpacesScreen } from './SpacesScreen';

/** Herdr's tab bar: one pill per tab of the space. */
export function TabPillRow({ groups, activeTab, onPick }: { groups: TabGroup[]; activeTab: string | null; onPick: (g: TabGroup) => void }) {
  const guard = useTapGuard<HTMLElement>();
  return (
    <nav ref={guard} className="tab-row" aria-label="Tabs">
      {groups
        .filter((g) => g.tab)
        .map((g) => (
          <TabPill key={g.tab?.id} tab={g.tab as TabView} label={g.label} active={g.tab?.id === activeTab} onClick={() => onPick(g)} />
        ))}
    </nav>
  );
}
