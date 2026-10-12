import { useRef, type KeyboardEvent } from 'react';
import type { SettingsTab } from '../../../store/settingsDraftStore';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { useUIStore } from '../../../store/uiStore';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'storage', label: 'Storage' },
];

/** Three tabs with one sliding pill; arrow keys move between them (WAI-ARIA tabs pattern). */
export function SettingsTabs({ tab, onChange }: { tab: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  const connected = useSettingsDraftStore((s) => (s.saved ? Object.values(s.saved.apiKeys).filter((value) => value.trim()).length : 0));
  const kreaSignedIn = useUIStore((s) => s.settingsCache.kreaConnection?.status === 'connected');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const index = TABS.findIndex((entry) => entry.id === tab);
  const count = connected + (kreaSignedIn ? 1 : 0);

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
