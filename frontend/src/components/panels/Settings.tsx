import { useState, useEffect, useRef, useCallback } from 'react';
import { useUIStore } from '../../store/uiStore';
import { getSettings, updateSettings } from '../../lib/api';
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
  { key: 'BFL_API_KEY', label: 'Black Forest Labs', placeholder: 'bfl-...', url: 'https://api.bfl.ml/auth/profile' },
  { key: 'RUNWAY_API_KEY', label: 'Runway', placeholder: 'key_...', url: 'https://app.runwayml.com/settings/api-keys' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', placeholder: 'el_...', url: 'https://elevenlabs.io/app/settings/api-keys' },
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
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [outputPath, setOutputPath] = useState('');
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loading, setLoading] = useState(false);

  // Load settings when panel opens
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    getSettings()
      .then((data) => {
        const settings = data as {
          apiKeys?: Record<string, string>;
          routing?: Record<string, string>;
          outputPath?: string;
        };
        setApiKeys(settings.apiKeys ?? {});
        setRouting(settings.routing ?? {});
        setOutputPath(settings.outputPath ?? '');
        setRevealedKeys(new Set());
        setSaveStatus('idle');
      })
      .catch((err) => {
        console.error('Failed to load settings:', err);
      })
      .finally(() => setLoading(false));
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

  if (!visible) return null;

  const resolvedX = position.x < 0 ? window.innerWidth + position.x : position.x;

  return (
    <div className="panel" style={{ left: resolvedX, top: position.y, width: 320 }}>
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
        <button className="panel__close" onClick={() => togglePanel('settings')}>
          &times;
        </button>
      </div>

      <div className="panel__body">
        {loading ? (
          <div style={{ color: '#666', textAlign: 'center', padding: 16 }}>Loading...</div>
        ) : (
          <>
            {/* API Keys Section */}
            <div className="settings__section-label">API Keys</div>
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

            {/* Routing Section */}
            {ROUTING_OPTIONS.length > 0 && (
              <>
                <div className="settings__section-label" style={{ marginTop: 16 }}>
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

            {/* Output Path Section */}
            <div className="settings__section-label" style={{ marginTop: 16 }}>
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

            {/* Save Button */}
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
          </>
        )}
      </div>
    </div>
  );
}
