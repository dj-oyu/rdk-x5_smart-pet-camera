import type { MobileTab } from './Sidebar';

interface Props {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

export function MobileTabBar({ activeTab, onTabChange }: Props) {
  return (
    <nav class="mobile-tab-bar">
      <button
        class={`mobile-tab ${activeTab === 'live' ? 'active' : ''}`}
        onClick={() => onTabChange('live')}
      >
        <span class="mobile-tab-icon tab-icon-live" />
        <span>Live</span>
      </button>
      <button
        class={`mobile-tab ${activeTab === 'tracking' ? 'active' : ''}`}
        onClick={() => onTabChange('tracking')}
      >
        <span class="mobile-tab-icon tab-icon-tracking" />
        <span>Tracking</span>
      </button>
      <button
        class={`mobile-tab ${activeTab === 'album' ? 'active' : ''}`}
        onClick={() => onTabChange('album')}
      >
        <span class="mobile-tab-icon tab-icon-album" />
        <span>Album</span>
      </button>
    </nav>
  );
}
