import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { getSettings } from '../../lib/api';
import { NEBULA_NOT_ANSWERING_COPY, failureCopy, isNoAnswer, type FailureCopy } from '../../lib/errorCopy';
import { FailureLines } from '../failure/FailureLines';
import { applySavedRunCostConfirm } from '../../lib/runCostConfirm';
import { SETTINGS_SAVED_EVENT, settingsSavedDetail } from '../../lib/settingsSignal';
import { useSettingsDraftStore, readSettingsDraft, settingsWriteInFlight, type SettingsTab } from '../../store/settingsDraftStore';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { usePanelFocus } from '../../hooks/usePanelFocus';
import { ScrollFade } from '../ScrollFade';
import { SettingsTabs } from './settings/SettingsTabs';
import { SettingsNoticeBar } from './settings/SettingsNoticeBar';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';
import '../../styles/panels.css';
import '../../styles/settings.css';

// The tabs load when the panel first opens, not with the app, which keeps the
// canvas's startup bundle inside its budget (scripts/check-build-budget.mjs).
// Opening the panel starts all three loads alongside the settings read.
const loadProvidersTab = () => import('./settings/ProvidersTab');
const loadPreferencesTab = () => import('./settings/PreferencesTab');
const loadStorageTab = () => import('./settings/StorageTab');
const ProvidersTab = lazy(() => loadProvidersTab().then((module) => ({ default: module.ProvidersTab })));
const PreferencesTab = lazy(() => loadPreferencesTab().then((module) => ({ default: module.PreferencesTab })));
const StorageTab = lazy(() => loadStorageTab().then((module) => ({ default: module.StorageTab })));

/** A tab whose code couldn't load (the app was rebuilt while this tab was
 * open, say) says so instead of taking the canvas down with it. */
export class TabLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="settings__load-error" role="alert">
          <p>This part of Settings couldn't load. Reload the tab to try again.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Settings: Providers, Preferences and Storage. Every change saves on its
 * own (lib/settingsWrites.ts); there is no panel-wide Save.
 */
export function Settings() {
  const visible = useUIStore((s) => s.panels.settings.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setupTarget = useUIStore((s) => s.settingsProviderTarget);
  const saved = useSettingsDraftStore((s) => s.saved);
  const tab = useSettingsDraftStore((s) => s.tab);
  // Offline is read-only (GM, round 15 of PR #114): the panel still opens
  // and shows the values it last loaded, with every field disabled.
  const offline = useBackendOffline();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(() => (saved ? 'ready' : 'loading'));
  // What the first load's failure says (GM, error-copy round 2): the heading
  // and the short reason, since "Try again" sits beside it.
  const [loadFailure, setLoadFailure] = useState<FailureCopy | null>(null);
  const [retryLoad, setRetryLoad] = useState(0);
  const loadRequest = useRef(0);

  // Read settings fresh on every open, unless a write is still landing (its
  // own confirmation is newer than anything a GET started now could return).
  useEffect(() => {
    if (!visible) return;
    // A failed load shows in the tab (TabLoadBoundary); nothing to do here.
    for (const load of [loadProvidersTab, loadPreferencesTab, loadStorageTab]) load().catch(() => {});
    const request = ++loadRequest.current;
    let cancelled = false;
    if (settingsWriteInFlight()) {
      queueMicrotask(() => { if (!cancelled) setLoadState(useSettingsDraftStore.getState().saved ? 'ready' : 'loading'); });
      return () => { cancelled = true; };
    }
    if (!useSettingsDraftStore.getState().saved) queueMicrotask(() => { if (!cancelled) setLoadState('loading'); });
    const initialCache = useUIStore.getState().settingsCache;
    getSettings().then((data) => {
      if (cancelled || request !== loadRequest.current || settingsWriteInFlight()) return;
      const cache = useUIStore.getState().settingsCache;
      // A newer app-wide refresh landed meanwhile; read again rather than overwrite it.
      if (cache.apiKeys !== initialCache.apiKeys || cache.kreaConnectionMode !== initialCache.kreaConnectionMode) {
        setRetryLoad((value) => value + 1);
        return;
      }
      applySavedRunCostConfirm(data);
      const loaded = readSettingsDraft(data);
      useSettingsDraftStore.setState({ saved: loaded });
      const sameKeys = Object.keys(cache.apiKeys).length === Object.keys(loaded.apiKeys).length
        && Object.entries(loaded.apiKeys).every(([key, value]) => cache.apiKeys[key] === value);
      if (!cache.loaded || !sameKeys || cache.kreaConnectionMode !== loaded.kreaConnectionMode) {
        useUIStore.getState().setSettingsCache(loaded.apiKeys, loaded.kreaConnectionMode);
      }
      setLoadState('ready');
    }).catch((error: unknown) => {
      if (cancelled || request !== loadRequest.current) return;
      // Keep showing what we last confirmed; only a first load with nothing to show is an error.
      // GM, round 16 of PR #114: with no answer, the unified line in full
      // ("…, then try again."), beside Try again.
      setLoadFailure(isNoAnswer(error)
        ? { heading: "Couldn't load your API keys.", reason: NEBULA_NOT_ANSWERING_COPY }
        : failureCopy(error, { heading: "Couldn't load your API keys.", short: true }));
      setLoadState(useSettingsDraftStore.getState().saved ? 'ready' : 'error');
    });
    return () => { cancelled = true; };
  }, [visible, retryLoad]);

  // A change made elsewhere (a second window, the CLI, the desktop app)
  // reaches an open panel in place (GM, PR #203 r19 item 6; review 9, keys
  // LOW-3): it reads the settings again, as an open does. Drafts live apart
  // (keyDrafts) and are never touched; a row the person is in stays where it
  // stands until they leave it (ProvidersTab).
  useEffect(() => {
    if (!visible) return;
    const heard = (event: Event) => {
      const detail = settingsSavedDetail(event);
      if (detail?.source === 'remote' || detail?.source === 'reconnect') setRetryLoad((value) => value + 1);
    };
    window.addEventListener(SETTINGS_SAVED_EVENT, heard);
    return () => window.removeEventListener(SETTINGS_SAVED_EVENT, heard);
  }, [visible]);

  // A setup link from a node or the library always lands on Providers.
  useEffect(() => {
    if (visible && setupTarget && useSettingsDraftStore.getState().tab !== 'providers') {
      useSettingsDraftStore.setState({ tab: 'providers' });
    }
  }, [setupTarget, visible]);

  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);
  const panelRef = useRef<HTMLDivElement>(null);
  usePanelFocus(visible && shouldRender, panelRef, () => useUIStore.getState().setLeftDock(null), {
    initialFocus: '[role="tab"][aria-selected="true"]',
  });
  if (!shouldRender) return null;

  const setTab = (next: SettingsTab) => useSettingsDraftStore.setState({ tab: next });
  const ready = loadState === 'ready' && saved !== null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Settings"
      aria-busy={!ready}
      className={`panel panel--settings workspace-dock-panel${exiting ? ' panel--exiting' : ''}`}
    >
      <div className="panel__header">
        <span className="panel__title">Settings</span>
        <button
          type="button"
          className="panel__header-action panel__close"
          onClick={() => togglePanel('settings')}
          aria-label="Close settings panel"
          title="Close"
        >
          <X className="panel__close-icon" size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        </button>
      </div>
      <SettingsTabs tab={tab} onChange={setTab} />
      <ScrollFade className="panel__body settings__body">
        {loadState === 'error' && !saved ? (
          <div className="settings__load-error" role="alert">
            <p>{loadFailure && <FailureLines failure={loadFailure} />}</p>
            <button type="button" className="settings__button" onClick={() => setRetryLoad((value) => value + 1)}>Try again</button>
          </div>
        ) : !ready ? (
          <div className="settings__loading" role="status">Loading settings…</div>
        ) : (
          <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="settings__tabpanel" key={tab}>
            {/* A disabled fieldset disables every control in the tab at once,
                from React state: reconnect simply re-renders it. Providers
                has its own, below its search, which stays usable (GM, r16). */}
            <fieldset className="settings__fieldset" disabled={offline && tab !== 'providers'}
              {...offlineMark(offline && tab !== 'providers')}>
              <TabLoadBoundary>
                <Suspense fallback={<div className="settings__loading" role="status">Loading settings…</div>}>
                  {tab === 'providers' && <ProvidersTab saved={saved} />}
                  {tab === 'preferences' && <PreferencesTab />}
                  {tab === 'storage' && <StorageTab saved={saved} />}
                </Suspense>
              </TabLoadBoundary>
            </fieldset>
          </div>
        )}
      </ScrollFade>
      <SettingsNoticeBar />
    </div>
  );
}
