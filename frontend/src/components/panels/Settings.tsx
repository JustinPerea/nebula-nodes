import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { getSettings, updateSettings, updateCredential, deleteSettingsApiKey } from '../../lib/api';
import { v4 as uuidv4 } from 'uuid';
import { useSettingsDraftStore, readSettingsDraft, settingsDraftIsDirty, type SettingsDraft, type SettingsMutation } from '../../store/settingsDraftStore';
import { KreaConnectionCard } from './KreaConnectionCard';
import type { KreaConnectionMode } from '../../lib/kreaConnection';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { usePanelFocus } from '../../hooks/usePanelFocus';
import { keyReadiness, providerCheckIsCurrent } from '../../lib/providerReadiness';
import { useProviderReadinessStore } from '../../store/providerReadinessStore';
import '../../styles/panels.css';

interface ApiKeyField {
  key: string;
  label: string;
  placeholder: string;
  url: string;
}

const API_KEY_FIELDS: ApiKeyField[] = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-...', url: 'https://platform.openai.com/api-keys' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...', url: 'https://console.anthropic.com/settings/keys' },
  { key: 'GOOGLE_API_KEY', label: 'Google (Gemini)', placeholder: 'AIza...', url: 'https://aistudio.google.com/apikey' },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', placeholder: 'sk-or-...', url: 'https://openrouter.ai/keys' },
  { key: 'REPLICATE_API_TOKEN', label: 'Replicate', placeholder: 'r8_...', url: 'https://replicate.com/account/api-tokens' },
  { key: 'FAL_KEY', label: 'fal.ai', placeholder: 'fal_...', url: 'https://fal.ai/dashboard/keys' },
  { key: 'MESHY_API_KEY', label: 'Meshy', placeholder: 'msy_...', url: 'https://app.meshy.ai/settings/api' },
  { key: 'RUNWAY_API_KEY', label: 'Runway', placeholder: 'key_...', url: 'https://app.runwayml.com/settings/api-keys' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', placeholder: 'el_...', url: 'https://elevenlabs.io/app/settings/api-keys' },
  { key: 'MINIMAX_API_KEY', label: 'MiniMax', placeholder: 'eyJ...', url: 'https://www.minimaxi.com/platform' },
  { key: 'XAI_API_KEY', label: 'xAI (Grok)', placeholder: 'xai-...', url: 'https://console.x.ai' },
  { key: 'HIGGSFIELD_API_KEY', label: 'Higgsfield', placeholder: 'hf_...', url: 'https://app.higgsfield.ai/settings' },
  { key: 'QUIVER_API_KEY', label: 'QuiverAI (Arrow)', placeholder: 'qvr-...', url: 'https://app.quiver.ai/settings/api-keys' },
  { key: 'KREA_API_TOKEN', label: 'Krea', placeholder: 'krea_...', url: 'https://www.krea.ai/api-keys' },
  { key: 'KREA_USAGE_KEY', label: 'Krea usage (workspace service key, enterprise)', placeholder: 'Service key', url: 'https://www.krea.ai/api-keys' },
  { key: 'IDEOGRAM_API_KEY', label: 'Ideogram', placeholder: 'ideogram_...', url: 'https://developer.ideogram.ai' },
  { key: 'WORLDLABS_API_KEY', label: 'World Labs', placeholder: 'wlt_...', url: 'https://platform.worldlabs.ai' },
];

interface RoutingOption {
  provider: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

// Empty for now: the only entry ("FLUX Routing" fal vs BFL Direct) was UI scaffolding —
// no handler ever read the routing setting and BFL direct was never implemented.
// The section hides itself while this is empty; re-add entries when a real route exists.
const ROUTING_OPTIONS: RoutingOption[] = [];

export function Settings() {
  const visible = useUIStore((s) => s.panels.settings.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const agentLogEnabled = useUIStore((s) => s.agentLogEnabled);
  const setAgentLogEnabled = useUIStore((s) => s.setAgentLogEnabled);
  const canvasPerfMode = useUIStore((s) => s.canvasPerfMode);
  const setCanvasPerfMode = useUIStore((s) => s.setCanvasPerfMode);
  const canvasLowDetail = useUIStore((s) => s.canvasLowDetail);
  const setCanvasLowDetail = useUIStore((s) => s.setCanvasLowDetail);
  const notificationPrefs = useUIStore((s) => s.notificationPrefs);
  const setNotificationPrefs = useUIStore((s) => s.setNotificationPrefs);
  const startOnboarding = useUIStore((s) => s.startOnboarding);
  const setupTarget = useUIStore((s) => s.settingsProviderTarget);
  const credentialCache = useUIStore((s) => s.settingsCache);
  const providerHealth = useProviderReadinessStore();

  // Desktop mode: the Electron preload bridge exposes a credentials
  // namespace when running inside the desktop shell. In browser/dev mode
  // this is absent and all key updates go through PUT /api/settings.
  const isDesktopMode = typeof window !== 'undefined'
    && !!window.nebulaDesktop?.credentials;

  // Plaintext key warning: providers with plaintext keys detected in
  // App Support settings.json on launch (VAL-UX-005). Empty in browser mode.
  const plaintextKeyWarning = typeof window !== 'undefined'
    ? (window.nebulaDesktop?.plaintextKeyWarning ?? [])
    : [];

  const { draft, baseline, mutation, pendingRefresh, saveStatus, error, removedProvider } = useSettingsDraftStore();
  const apiKeys = draft?.apiKeys ?? {};
  const originalApiKeys = baseline?.apiKeys ?? {};
  const routing = draft?.routing ?? {};
  const kreaConnectionMode = draft?.kreaConnectionMode ?? 'api-token';
  const outputPath = draft?.outputPath ?? '';
  const exportFolder = draft?.exportFolder ?? '';
  const zoomTelemetryEnabled = draft?.zoomTelemetryEnabled ?? false;
  const dirty = settingsDraftIsDirty(draft, baseline);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [retryLoad, setRetryLoad] = useState(0);
  const loadRequest = useRef(0);
  const loadReady = useRef(false);
  const focusedTarget = useRef<typeof setupTarget>(null);

  // Editing is unavailable during the initial load. A dismissed dirty draft
  // remains volatile and is reused; a clean reopen gets a fresh baseline.
  useEffect(() => {
    if (!visible) return;
    const request = ++loadRequest.current;
    const current = useSettingsDraftStore.getState();
    let cancelled = false;
    const retained = settingsDraftIsDirty(current.draft, current.baseline)
      || current.mutation !== null || current.pendingRefresh !== null || current.error !== null;
    loadReady.current = retained;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoadState(retained ? 'ready' : 'loading');
      setRevealedKeys(new Set());
      if (!retained) setApiKeysOpen(false);
    });
    if (!retained) {
      const initialDraft = current.draft;
      const initialCache = useUIStore.getState().settingsCache;
      getSettings().then((data) => {
        if (cancelled || request !== loadRequest.current
          || useSettingsDraftStore.getState().draft !== initialDraft) return;
        const cache = useUIStore.getState().settingsCache;
        if (cache.apiKeys !== initialCache.apiKeys || cache.kreaConnectionMode !== initialCache.kreaConnectionMode) {
          setRetryLoad((value) => value + 1);
          return;
        }
        const loaded = readSettingsDraft(data);
        useSettingsDraftStore.setState({ draft: loaded, baseline: loaded,
          saveStatus: 'idle', error: null, removedProvider: null });
        const sameKeys = Object.keys(cache.apiKeys).length === Object.keys(loaded.apiKeys).length
          && Object.entries(loaded.apiKeys).every(([key, value]) => cache.apiKeys[key] === value);
        if (!cache.loaded || !sameKeys || cache.kreaConnectionMode !== loaded.kreaConnectionMode) {
          useUIStore.getState().setSettingsCache(loaded.apiKeys, loaded.kreaConnectionMode);
        }
        loadReady.current = true;
        setLoadState('ready');
      }).catch(() => {
        if (!cancelled && request === loadRequest.current) setLoadState('error');
      });
    }
    return () => { cancelled = true; loadReady.current = false; };
  }, [visible, retryLoad]);

  const updateDraft = useCallback((update: Partial<SettingsDraft> | ((value: SettingsDraft) => Partial<SettingsDraft>)) => {
    const state = useSettingsDraftStore.getState();
    if (!state.draft || state.mutation || state.pendingRefresh || !loadReady.current || loadState !== 'ready' || !visible) return;
    useSettingsDraftStore.setState({
      draft: { ...state.draft, ...(typeof update === 'function' ? update(state.draft) : update) },
      saveStatus: 'idle', error: null,
    });
  }, [loadState, visible]);

  // A write can finish after dismissal/unmount. Its store-owned identity lets
  // the same draft finish safely without an old load replacing reopened edits.
  const refreshMutation = useCallback(async (operation: SettingsMutation) => {
    try {
      const refreshed = readSettingsDraft(await getSettings());
      const state = useSettingsDraftStore.getState();
      if (state.mutation?.id !== operation.id) return;
      const refreshedKeys = { ...refreshed.apiKeys };
      if (operation.provider && state.draft) {
        for (const [provider, value] of Object.entries(state.draft.apiKeys)) {
          if (provider !== operation.provider && value !== state.baseline?.apiKeys[provider]) {
            refreshedKeys[provider] = value;
          }
        }
      }
      const nextDraft = operation.provider && state.draft
        ? { ...state.draft, apiKeys: refreshedKeys }
        : refreshed;
      const nextBaseline = operation.provider && state.baseline
        ? { ...state.baseline, apiKeys: refreshed.apiKeys }
        : refreshed;
      useSettingsDraftStore.setState({ draft: nextDraft, baseline: nextBaseline,
        mutation: null, pendingRefresh: null, error: null,
        removedProvider: operation.provider ?? null,
        saveStatus: operation.provider ? 'idle' : 'saved' });
      useUIStore.getState().setSettingsCache(refreshed.apiKeys, refreshed.kreaConnectionMode);
      window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
    } catch {
      if (useSettingsDraftStore.getState().mutation?.id !== operation.id) return;
      useSettingsDraftStore.setState({ mutation: null, pendingRefresh: operation,
        saveStatus: operation.provider ? 'idle' : 'saved',
        error: operation.provider
          ? 'The key was removed, but connection status could not refresh. Retry refresh.'
          : 'Settings were saved, but connection status could not refresh. Retry refresh.' });
    }
  }, []);

  const handleSave = useCallback(async () => {
    const state = useSettingsDraftStore.getState();
    if (!visible || !loadReady.current || loadState !== 'ready' || !state.draft || state.mutation || state.pendingRefresh) return;
    const submitted = state.draft;
    const operation: SettingsMutation = { id: uuidv4() };
    useProviderReadinessStore.getState().invalidate();
    useSettingsDraftStore.setState({ mutation: operation, saveStatus: 'saving', error: null });
    try {
      if (isDesktopMode) {
        const credentialBridge = window.nebulaDesktop!.credentials!;
        for (const field of API_KEY_FIELDS) {
          const currentValue = (submitted.apiKeys[field.key] ?? '').trim();
          const originalValue = (state.baseline?.apiKeys[field.key] ?? '').trim();
          const wasConfigured = originalValue.startsWith('***');
          if (currentValue && !currentValue.startsWith('***')) {
            const setResult = await credentialBridge.set(field.key, currentValue);
            if (!setResult.ok) throw new Error('Credential storage failed');
            await updateCredential(field.key, currentValue);
          } else if (!currentValue && wasConfigured) {
            const clearResult = await credentialBridge.clear(field.key);
            if (!clearResult.ok) throw new Error('Credential removal failed');
            await updateCredential(field.key, '');
          }
        }
      }
      await updateSettings({
        ...(!isDesktopMode ? { apiKeys: Object.fromEntries(Object.entries(submitted.apiKeys)
          .map(([provider, value]) => [provider, value.trim()])) } : {}),
        routing: submitted.routing,
        outputPath: submitted.outputPath || null,
        exportFolder: submitted.exportFolder || null,
        zoomTelemetryEnabled: submitted.zoomTelemetryEnabled,
        kreaConnectionMode: submitted.kreaConnectionMode,
      });
      await refreshMutation(operation);
    } catch {
      if (useSettingsDraftStore.getState().mutation?.id !== operation.id) return;
      useSettingsDraftStore.setState({ mutation: null, saveStatus: 'error',
        error: 'Settings could not be saved. Your edits are still here. Retry Save Settings.' });
    }
  }, [isDesktopMode, loadState, refreshMutation, visible]);

  const handleRemoveKey = useCallback(async (provider: string) => {
    const state = useSettingsDraftStore.getState();
    if (!visible || !loadReady.current || loadState !== 'ready' || isDesktopMode || !state.draft
      || state.mutation || state.pendingRefresh || !state.baseline?.apiKeys[provider]) return;
    const operation: SettingsMutation = { id: uuidv4(), provider };
    useProviderReadinessStore.getState().invalidate();
    useSettingsDraftStore.setState({ mutation: operation, saveStatus: 'idle', error: null,
      removedProvider: null });
    try {
      await deleteSettingsApiKey(provider);
      const latest = useSettingsDraftStore.getState();
      if (latest.mutation?.id !== operation.id || !latest.draft || !latest.baseline) return;
      // The deletion is already known to have succeeded, even if GET fails.
      useSettingsDraftStore.setState({
        draft: { ...latest.draft, apiKeys: { ...latest.draft.apiKeys, [provider]: '' } },
        baseline: { ...latest.baseline, apiKeys: { ...latest.baseline.apiKeys, [provider]: '' } },
        removedProvider: provider,
      });
      const cache = useUIStore.getState().settingsCache;
      const nextKeys = { ...cache.apiKeys };
      delete nextKeys[provider];
      useUIStore.getState().setSettingsCache(nextKeys);
      await refreshMutation(operation);
    } catch {
      if (useSettingsDraftStore.getState().mutation?.id !== operation.id) return;
      useSettingsDraftStore.setState({ mutation: null,
        error: 'The key could not be removed. Retry Remove; your other edits are still here.' });
    }
  }, [isDesktopMode, loadState, refreshMutation, visible]);

  const handleRetryRefresh = useCallback(() => {
    const state = useSettingsDraftStore.getState();
    if (!visible || state.mutation || !state.pendingRefresh) return;
    const operation = state.pendingRefresh;
    useSettingsDraftStore.setState({ mutation: operation, error: null });
    void refreshMutation(operation);
  }, [refreshMutation, visible]);

  const handleDiscard = useCallback(() => {
    const state = useSettingsDraftStore.getState();
    if (!visible || state.mutation || state.pendingRefresh || !state.baseline) return;
    useSettingsDraftStore.setState({ draft: state.baseline, saveStatus: 'idle', error: null });
    setRevealedKeys(new Set());
  }, [visible]);

  const toggleReveal = useCallback((key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible || loadState !== 'ready' || !setupTarget || focusedTarget.current === setupTarget || mutation || pendingRefresh) return;
    let cancelled = false;
    if (setupTarget.kind === 'api-key' && !apiKeysOpen) {
      queueMicrotask(() => { if (!cancelled) setApiKeysOpen(true); });
      return () => { cancelled = true; };
    }
    const frame = requestAnimationFrame(() => {
      if (cancelled || !panelRef.current) return;
      const element = setupTarget.kind === 'api-key'
        ? Array.from(panelRef.current.querySelectorAll<HTMLInputElement>('[data-provider-key]')).find((input) => input.dataset.providerKey === setupTarget.key)
        : panelRef.current.querySelector<HTMLElement>(setupTarget.kind === 'krea-mcp'
          ? '[data-provider-setup="krea-mcp"] button' : '[data-provider-setup="nous"]');
      if (element) {
        element.focus();
        element.scrollIntoView?.({ block: 'nearest' });
        focusedTarget.current = setupTarget;
      }
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [apiKeysOpen, loadState, mutation, pendingRefresh, setupTarget, visible]);
  usePanelFocus(visible && shouldRender, panelRef, () => useUIStore.getState().setLeftDock(null));
  if (!shouldRender) return null;

  const configuredApiKeyCount = API_KEY_FIELDS.reduce(
    (count, field) => count + (originalApiKeys[field.key]?.trim() ? 1 : 0),
    0,
  );
  const readinessCache = { ...credentialCache, apiKeys: originalApiKeys, loaded: true };
  const verifiedCount = Object.values(providerHealth.providers).filter((entry) => entry.status === 'valid'
    && entry.configured && providerCheckIsCurrent(entry, providerHealth.checkedAt)).length;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Settings"
      aria-busy={loadState === 'loading' || loadState === 'idle' || !!mutation}
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
          <X
            className="panel__close-icon"
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>

      <div className="panel__body">
        {loadState === 'idle' || loadState === 'loading' ? (
          <div className="settings__loading" role="status">Loading settings…</div>
        ) : loadState === 'error' ? (
          <div className="settings__load-error">
            <p role="alert">Settings could not load. Your saved settings have not been changed.</p>
            <button type="button" className="settings__secondary-button" onClick={() => setRetryLoad((value) => value + 1)}>Retry loading settings</button>
          </div>
        ) : (
          <fieldset className="settings__fields" disabled={!visible || !!mutation || !!pendingRefresh}>
            {/* Plaintext key warning (VAL-UX-005) */}
            {isDesktopMode && plaintextKeyWarning.length > 0 && (
              <div className="settings__plaintext-warning" role="alert">
                <strong>Plaintext credentials detected:</strong> API keys for
                {' '}{plaintextKeyWarning.join(', ')}{' '}
                were found in the settings file. Remove them and re-enter keys
                through the Settings panel to store them securely in the macOS
                Keychain.
              </div>
            )}

            <div className="settings__section-label">Connections</div>
            <section className="settings__connection-check" aria-label="Saved provider connections">
              <div className="settings__connection-check-heading">
                <strong>Saved credentials</strong>
                <button type="button" className="settings__secondary-button" disabled={providerHealth.loading || dirty}
                  onClick={() => void providerHealth.checkConnections()}>{providerHealth.loading ? 'Checking connections…' : 'Check connections'}</button>
              </div>
              <p>Checks saved API credentials and the local Nous login without generating. Model access and credits are checked separately.</p>
              {dirty && <p>Save or discard your edits before checking the saved connections.</p>}
              {providerHealth.error ? <p role="alert">{providerHealth.error}</p> : <p role="status">{providerHealth.loading ? 'Checking saved connections…'
                : providerHealth.checkedAt === null ? 'Credentials have not been checked in this session.'
                : `${verifiedCount} verified credential${verifiedCount === 1 ? '' : 's'}. Checks expire after five minutes.`}</p>}
            </section>
            {setupTarget?.kind === 'external' && <section className="settings__external-setup" aria-label="Nous Portal setup"
              data-provider-setup="nous" tabIndex={-1}>
              <strong>Nous Portal sign-in</strong>
              <p>On the computer running Nebula, run <code>hermes-daedalus model</code> and choose Nous Portal. This uses the local Hermes OAuth login; there is no Nous API-key field.</p>
              <p>Then return here and use Check connections. Sign-in and checking do not start generation.</p>
            </section>}
            <div data-provider-setup="krea-mcp"><KreaConnectionCard mode={kreaConnectionMode} onModeChange={(value: KreaConnectionMode) => updateDraft({ kreaConnectionMode: value })} /></div>

            {/* API Keys Section */}
            <button
              className="settings__section-toggle"
              type="button"
              aria-expanded={apiKeysOpen}
              onClick={() => setApiKeysOpen((open) => !open)}
            >
              <span className="settings__section-toggle-title">API Keys</span>
              {isDesktopMode && (
                <span className="settings__keychain-badge" title="API keys are encrypted and stored in the macOS Keychain">
                  Managed by macOS Keychain
                </span>
              )}
              <span className="settings__section-toggle-count">
                {configuredApiKeyCount}/{API_KEY_FIELDS.length}
              </span>
              {apiKeysOpen ? (
                <ChevronDown
                  className="settings__section-toggle-chevron"
                  size={12}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  focusable="false"
                />
              ) : (
                <ChevronRight
                  className="settings__section-toggle-chevron"
                  size={12}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  focusable="false"
                />
              )}
            </button>
            {apiKeysOpen && (
              <div className="settings__collapsible-body">
                {API_KEY_FIELDS.map((field) => (
                  <div key={field.key} className={`settings__key-row${setupTarget?.kind === 'api-key' && setupTarget.key === field.key ? ' settings__key-row--target' : ''}`}>
                    <a
                      className="inspector__label settings__key-link"
                      href={field.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Get ${field.label} API key`}
                    >{field.label}</a>
                    <div className="settings__key-input-wrapper">
                      <input
                        className="inspector__field settings__key-input"
                        type={revealedKeys.has(field.key) ? 'text' : 'password'}
                        value={apiKeys[field.key] ?? ''}
                        onChange={(e) =>
                          updateDraft((value) => ({ apiKeys: { ...value.apiKeys, [field.key]: e.target.value } }))
                        }
                        placeholder={field.placeholder}
                        aria-label={`${field.label} API key`}
                        data-provider-key={field.key}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        className="settings__reveal-button"
                        onClick={() => toggleReveal(field.key)}
                        title={revealedKeys.has(field.key) ? 'Hide' : 'Show'}
                        aria-label={`${revealedKeys.has(field.key) ? 'Hide' : 'Show'} ${field.label} API key`}
                        type="button"
                      >
                        {revealedKeys.has(field.key) ? 'Hide' : 'Show'}
                      </button>
                      {!isDesktopMode && originalApiKeys[field.key]?.trim() && (
                        <button type="button" className="settings__secondary-button settings__remove-key"
                          aria-label={`Remove ${field.label} API key`} onClick={() => void handleRemoveKey(field.key)}>
                          {mutation?.provider === field.key ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                    </div>
                    <p className="settings__key-status" title={keyReadiness(field.key, readinessCache, providerHealth).detail}>{keyReadiness(field.key, readinessCache, providerHealth).label}</p>
                    {!isDesktopMode && originalApiKeys[field.key]?.trim() && !apiKeys[field.key]?.trim() && (
                      <p className="settings__key-status">This key is still configured. Use Remove to disconnect it.</p>
                    )}
                    {removedProvider === field.key && (
                      <p className="settings__key-status" role="status">{field.label} key removed.</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Routing Section */}
            {ROUTING_OPTIONS.length > 0 && (
              <>
                <div className="settings__section-label settings__section-label--stacked">
                  Routing
                </div>
                {ROUTING_OPTIONS.map((opt) => (
                  <div key={opt.provider} className="inspector__section">
                    <div className="inspector__label">{opt.label}</div>
                    <select
                      className="inspector__field"
                      value={routing[opt.provider] ?? opt.options[0]?.value ?? ''}
                      onChange={(e) =>
                        updateDraft((value) => ({ routing: { ...value.routing, [opt.provider]: e.target.value } }))
                      }
                    >
                      {opt.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </>
            )}

            {/* Interface Section */}
            <div className="settings__section-label settings__section-label--stacked">
              Interface
            </div>
            <p className="settings__key-status">Interface preferences apply immediately.</p>
            <label className="settings__toggle-row">
              <input
                className="settings__toggle-input"
                type="checkbox"
                checked={agentLogEnabled}
                onChange={(e) => setAgentLogEnabled(e.target.checked)}
              />
              <span className="settings__toggle-copy">
                <span className="settings__toggle-title">Agent log</span>
                <span className="settings__toggle-description">
                  Show execution telemetry below the chat panel.
                </span>
              </span>
            </label>
            <label className="settings__toggle-row">
              <input
                className="settings__toggle-input"
                type="checkbox"
                checked={canvasPerfMode}
                onChange={(e) => setCanvasPerfMode(e.target.checked)}
              />
              <span className="settings__toggle-copy">
                <span className="settings__toggle-title">Performance mode</span>
                <span className="settings__toggle-description">
                  Only render on-screen nodes; show minimap. Recommended for large graphs.
                </span>
              </span>
            </label>
            <label className="settings__toggle-row">
              <input
                className="settings__toggle-input"
                type="checkbox"
                checked={canvasLowDetail}
                onChange={(e) => setCanvasLowDetail(e.target.checked)}
              />
              <span className="settings__toggle-copy">
                <span className="settings__toggle-title">Low detail when zoomed out</span>
                <span className="settings__toggle-description">
                  Hide node previews past a zoom threshold for smoother panning.
                </span>
              </span>
            </label>
            <label className="settings__toggle-row">
              <input
                className="settings__toggle-input"
                type="checkbox"
                checked={notificationPrefs.enabled}
                onChange={(e) => setNotificationPrefs({ enabled: e.target.checked })}
              />
              <span className="settings__toggle-copy">
                <span className="settings__toggle-title">Job notifications</span>
                <span className="settings__toggle-description">
                  Notify when a pipeline finishes while this tab is in the background, or after a long run.
                </span>
              </span>
            </label>
            {notificationPrefs.enabled && (
              <label className="settings__toggle-row">
                <input
                  className="settings__toggle-input"
                  type="checkbox"
                  checked={notificationPrefs.sound}
                  onChange={(e) => setNotificationPrefs({ sound: e.target.checked })}
                />
                <span className="settings__toggle-copy">
                  <span className="settings__toggle-title">Completion sound</span>
                  <span className="settings__toggle-description">
                    Play a short tone when a pipeline finishes.
                  </span>
                </span>
              </label>
            )}
            <button
              type="button"
              className="settings__onboarding-button"
              onClick={() => {
                togglePanel('settings');
                startOnboarding();
              }}
            >
              Show onboarding again
            </button>

            {/* Output Path Section */}
            <div className="settings__section-label settings__section-label--stacked">
              Output
            </div>
            <div className="inspector__section">
              <div className="inspector__label">Output Path</div>
              <input
                className="inspector__field"
                type="text"
                value={outputPath}
                onChange={(e) => updateDraft({ outputPath: e.target.value })}
                aria-label="Output Path"
                placeholder="Default: ./output — absolute path; applies after backend restart"
              />
            </div>
            <div className="inspector__section">
              <div className="inspector__label">Default Save Folder</div>
              <input
                className="inspector__field"
                type="text"
                value={exportFolder}
                onChange={(e) => updateDraft({ exportFolder: e.target.value })}
                aria-label="Default Save Folder"
                placeholder="Default: ~/Downloads"
              />
            </div>
            <label className="settings__toggle-row">
              <input
                className="settings__toggle-input"
                type="checkbox"
                checked={zoomTelemetryEnabled}
                onChange={(event) => updateDraft({ zoomTelemetryEnabled: event.target.checked })}
              />
              <span className="settings__toggle-copy">
                <span className="settings__toggle-title">Demo zoom telemetry</span>
                <span className="settings__toggle-description">
                  Record canvas bounds for demo-video editing. Off by default; saved beneath the configured output path.
                </span>
              </span>
            </label>

          </fieldset>
        )}
      </div>

      {loadState === 'ready' && (
        <div className="settings__footer">
          {error && <p className="settings__error" role="alert">{error}</p>}
          {dirty && (!pendingRefresh || pendingRefresh.provider) && <p className="settings__draft-status" role="status">Unsaved changes stay here when you close Settings. Reloading the page discards them.</p>}
          {pendingRefresh ? (
            <button type="button" className="settings__save-button" onClick={handleRetryRefresh} disabled={!!mutation}>
              {mutation ? 'Refreshing…' : 'Retry refresh'}
            </button>
          ) : <button
            className="settings__save-button"
            onClick={handleSave}
            type="button"
            disabled={!visible || !!mutation}
          >
            {saveStatus === 'saving'
              ? 'Saving...'
              : saveStatus === 'saved'
                ? 'Saved'
                : saveStatus === 'error'
                  ? 'Error — Retry'
                  : 'Save Settings'}
          </button>}
          {dirty && !pendingRefresh && <button type="button" className="settings__secondary-button settings__discard-button" onClick={handleDiscard} disabled={!visible || !!mutation}>Discard changes</button>}
        </div>
      )}
    </div>
  );
}
