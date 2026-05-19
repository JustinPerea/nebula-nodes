import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { getSettings, updateSettings } from '../../lib/api';
import { SkinPicker } from '../SkinPicker';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import '../../styles/panels.css';
import '../../styles/skin-picker.css';

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
  { key: 'BFL_API_KEY', label: 'Black Forest Labs', placeholder: 'bfl-...', url: 'https://api.bfl.ml/auth/profile' },
  { key: 'RUNWAY_API_KEY', label: 'Runway', placeholder: 'key_...', url: 'https://app.runwayml.com/settings/api-keys' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', placeholder: 'el_...', url: 'https://elevenlabs.io/app/settings/api-keys' },
  { key: 'MINIMAX_API_KEY', label: 'MiniMax', placeholder: 'eyJ...', url: 'https://www.minimaxi.com/platform' },
  { key: 'XAI_API_KEY', label: 'xAI (Grok)', placeholder: 'xai-...', url: 'https://console.x.ai' },
  { key: 'HIGGSFIELD_API_KEY', label: 'Higgsfield', placeholder: 'hf_...', url: 'https://app.higgsfield.ai/settings' },
  { key: 'QUIVER_API_KEY', label: 'QuiverAI (Arrow)', placeholder: 'qvr-...', url: 'https://app.quiver.ai/settings/api' },
];

interface RoutingOption {
  provider: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

const ROUTING_OPTIONS: RoutingOption[] = [
  {
    provider: 'flux',
    label: 'FLUX Routing',
    options: [
      { value: 'fal', label: 'fal.ai (default)' },
      { value: 'bfl', label: 'BFL Direct' },
    ],
  },
];

export function Settings() {
  const visible = useUIStore((s) => s.panels.settings.visible);
  const position = useUIStore((s) => s.panels.settings.position);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);
  const agentLogEnabled = useUIStore((s) => s.agentLogEnabled);
  const setAgentLogEnabled = useUIStore((s) => s.setAgentLogEnabled);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [outputPath, setOutputPath] = useState('');
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
        };
        setApiKeys(settings.apiKeys ?? {});
        setRouting(settings.routing ?? {});
        setOutputPath(settings.outputPath ?? '');
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

  // Dragging logic (same pattern as Inspector)
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('settings', {
        x: dragRef.current.panelX + dx,
        y: dragRef.current.panelY + dy,
      });
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setPanelPosition]);

  const handleSave = useCallback(async () => {
    setSaveStatus('saving');
    try {
      await updateSettings({ apiKeys, routing, outputPath: outputPath || null });
      setSaveStatus('saved');
      window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [apiKeys, routing, outputPath]);

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
  if (!shouldRender) return null;

  const resolvedX = position.x < 0 ? window.innerWidth + position.x : position.x;
  const resolvedTop = position.y;
  const settingsMaxHeight = `calc(100vh - ${Math.max(16, resolvedTop) + 16}px)`;
  const configuredApiKeyCount = API_KEY_FIELDS.reduce(
    (count, field) => count + (apiKeys[field.key]?.trim() ? 1 : 0),
    0,
  );

  return (
    <div
      className={`panel panel--settings${exiting ? ' panel--exiting' : ''}`}
      style={{ left: resolvedX, top: resolvedTop, maxHeight: settingsMaxHeight }}
    >
      <div
        className="panel__header"
        onMouseDown={(e) => {
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            panelX: resolvedX,
            panelY: position.y,
          };
        }}
      >
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
            {/* API Keys Section */}
            <button
              className="settings__section-toggle"
              type="button"
              aria-expanded={apiKeysOpen}
              onClick={() => setApiKeysOpen((open) => !open)}
            >
              <span className="settings__section-toggle-title">API Keys</span>
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

            {/* Skin Section */}
            <div className="settings__section-label settings__section-label--stacked">
              Skin
            </div>
            <SkinPicker />

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
                placeholder="Default: ./output"
              />
            </div>

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
