import { useRef, type KeyboardEvent } from 'react';
import type { SettingsTab } from '../../../store/settingsDraftStore';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { useUIStore } from '../../../store/uiStore';
import { useProviderReadinessStore } from '../../../store/providerReadinessStore';
import { shownConnected } from './rowHelpers';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'storage', label: 'Storage' },
];

/** Three tabs with one sliding pill; arrow keys move between them (WAI-ARIA tabs pattern). */
export function SettingsTabs({ tab, onChange }: { tab: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  const apiKeys = useSettingsDraftStore((s) => s.saved?.apiKeys);
  const held = useSettingsDraftStore((s) => s.heldRows);
  const kreaStatus = useUIStore((s) => s.settingsCache.kreaConnection?.status);
  const providers = useProviderReadinessStore((s) => s.providers);
  const checkedAt = useProviderReadinessStore((s) => s.checkedAt);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const index = TABS.findIndex((entry) => entry.id === tab);
  const count = shownConnected({ apiKeys: apiKeys ?? {}, kreaStatus, health: { providers, checkedAt } }, held);

  function onKeyDown(event: KeyboardEvent) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
      : step ? (index + step + TABS.length) % TABS.length : -1;
    if (target < 0) return;
    event.preventDefault();
    onChange(TABS[target].id);
    refs.current[TABS[target].id]?.focus();
  }

  return (
    <div className="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onKeyDown}
      style={{ '--settings-tab-index': index } as React.CSSProperties}>
      <span className="settings-tabs__pill" aria-hidden="true" />
      {TABS.map((entry) => (
        <button
          key={entry.id}
          ref={(node) => { refs.current[entry.id] = node; }}
          type="button"
          role="tab"
          id={`settings-tab-${entry.id}`}
          aria-selected={tab === entry.id}
          aria-controls={`settings-panel-${entry.id}`}
          tabIndex={tab === entry.id ? 0 : -1}
          className="settings-tabs__tab"
          onClick={() => onChange(entry.id)}
        >
          {entry.label}
          {entry.id === 'providers' && count > 0 && <span className="settings-tabs__count" aria-label={`, ${count} connected`}>{count}</span>}
        </button>
      ))}
    </div>
  );
}
