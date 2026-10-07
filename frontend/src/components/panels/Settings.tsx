import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { getSettings, updateSettings, updateCredential } from '../../lib/api';
import { KreaConnectionCard } from './KreaConnectionCard';
import { normalizeKreaMode, type KreaConnectionMode } from '../../lib/kreaConnection';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { usePanelFocus } from '../../hooks/usePanelFocus';
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

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [originalApiKeys, setOriginalApiKeys] = useState<Record<string, string>>({});
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [kreaConnectionMode, setKreaConnectionMode] = useState<KreaConnectionMode>('api-token');
  const [outputPath, setOutputPath] = useState('');
  const [exportFolder, setExportFolder] = useState('');
  const [zoomTelemetryEnabled, setZoomTelemetryEnabled] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loading, setLoading] = useState(false);

  // Load settings when panel opens
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setApiKeysOpen(false);
      setRevealedKeys(new Set());
    });
    getSettings()
      .then((data) => {
        if (cancelled) return;
        const settings = data as {
          apiKeys?: Record<string, string>;
          routing?: Record<string, string>;
          outputPath?: string;
          exportFolder?: string;
          zoomTelemetryEnabled?: boolean;
          kreaConnectionMode?: KreaConnectionMode;
        };
        setApiKeys(settings.apiKeys ?? {});
        setOriginalApiKeys(settings.apiKeys ?? {});
        setRouting(settings.routing ?? {});
        setKreaConnectionMode(normalizeKreaMode(settings.kreaConnectionMode));
        setOutputPath(settings.outputPath ?? '');
        setExportFolder(settings.exportFolder ?? '');
        setZoomTelemetryEnabled(settings.zoomTelemetryEnabled === true);
        setSaveStatus('idle');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load settings:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const handleSave = useCallback(async () => {
    setSaveStatus('saving');
    try {
      if (isDesktopMode) {
        // Desktop mode: route API key updates through the Keychain
        // credential IPC (nebulaDesktop.credentials.set/clear) and
        // POST /api/credentials/update. Non-secret settings still
        // use PUT /api/settings. VAL-UX-003, VAL-KEY-004, VAL-KEY-006

        const credentialBridge = window.nebulaDesktop!.credentials!;

        // Process each API key field
        for (const field of API_KEY_FIELDS) {
          const currentValue = (apiKeys[field.key] ?? '').trim();
          const originalValue = (originalApiKeys[field.key] ?? '').trim();
          const wasConfigured = originalValue.startsWith('***');

          if (currentValue && !currentValue.startsWith('***')) {
            // User entered a new plaintext key → encrypt to Keychain
            const setResult = await credentialBridge.set(field.key, currentValue);
            if (!setResult.ok) {
              throw new Error(`Failed to store ${field.label} key: ${setResult.error ?? 'unknown'}`);
            }
            // Update backend in-memory store
            await updateCredential(field.key, currentValue);
          } else if (!currentValue && wasConfigured) {
            // User cleared a previously-configured key → remove from Keychain
            const clearResult = await credentialBridge.clear(field.key);
            if (!clearResult.ok) {
              throw new Error(`Failed to clear ${field.label} key: ${clearResult.error ?? 'unknown'}`);
            }
            // Remove from backend in-memory store
            await updateCredential(field.key, '');
          }
          // If currentValue starts with '***' → unchanged masked value, skip
          // If !currentValue && !wasConfigured → wasn't configured, still isn't, skip
        }

        // Non-secret settings still go through PUT /api/settings
        // (apiKeys is omitted — backend ignores them in desktop mode anyway)
        await updateSettings({
          routing,
          outputPath: outputPath || null,
          exportFolder: exportFolder || null,
          zoomTelemetryEnabled,
          kreaConnectionMode,
        });
      } else {
        // Browser mode: all settings including apiKeys go through PUT /api/settings
        await updateSettings({
          apiKeys,
          routing,
          outputPath: outputPath || null,
          exportFolder: exportFolder || null,
          zoomTelemetryEnabled,
          kreaConnectionMode,
        });
      }

      setSaveStatus('saved');
      useUIStore.getState().setKreaConnectionMode(kreaConnectionMode);
      window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [apiKeys, originalApiKeys, routing, outputPath, exportFolder, zoomTelemetryEnabled, kreaConnectionMode, isDesktopMode]);

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
  usePanelFocus(visible && shouldRender, panelRef, () => useUIStore.getState().setLeftDock(null));
  if (!shouldRender) return null;

  const configuredApiKeyCount = API_KEY_FIELDS.reduce(
    (count, field) => count + (apiKeys[field.key]?.trim() ? 1 : 0),
    0,
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Settings"
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
        {loading ? (
          <div className="settings__loading">Loading...</div>
        ) : (
          <>
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
            <KreaConnectionCard mode={kreaConnectionMode} onModeChange={setKreaConnectionMode} />

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
                  <div key={field.key} className="settings__key-row">
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
                          setApiKeys((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        placeholder={field.placeholder}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        className="settings__reveal-button"
                        onClick={() => toggleReveal(field.key)}
                        title={revealedKeys.has(field.key) ? 'Hide' : 'Show'}
                        type="button"
                      >
                        {revealedKeys.has(field.key) ? '\u{1F441}' : '\u25CF'}
                      </button>
                    </div>
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
                        setRouting((prev) => ({ ...prev, [opt.provider]: e.target.value }))
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
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="Default: ./output — absolute path; applies after backend restart"
              />
            </div>
            <div className="inspector__section">
              <div className="inspector__label">Default Save Folder</div>
              <input
                className="inspector__field"
                type="text"
                value={exportFolder}
                onChange={(e) => setExportFolder(e.target.value)}
                placeholder="Default: ~/Downloads"
              />
            </div>
            <label className="settings__toggle-row">
              <input
                className="settings__toggle-input"
                type="checkbox"
                checked={zoomTelemetryEnabled}
                onChange={(event) => setZoomTelemetryEnabled(event.target.checked)}
              />
              <span className="settings__toggle-copy">
                <span className="settings__toggle-title">Demo zoom telemetry</span>
                <span className="settings__toggle-description">
                  Record canvas bounds for demo-video editing. Off by default; saved beneath the configured output path.
                </span>
              </span>
            </label>

          </>
        )}
      </div>

      {!loading && (
        <div className="settings__footer">
          <button
            className="settings__save-button"
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
          >
            {saveStatus === 'saving'
              ? 'Saving...'
              : saveStatus === 'saved'
                ? 'Saved'
                : saveStatus === 'error'
                  ? 'Error — Retry'
                  : 'Save Settings'}
          </button>
        </div>
      )}
    </div>
  );
}
