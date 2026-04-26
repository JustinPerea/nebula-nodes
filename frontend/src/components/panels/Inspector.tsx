import { useRef, useEffect, useState, useMemo } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import { PORT_COLORS } from '../../lib/portCompatibility';
import type { NodeData, DynamicNodeData, ParamDefinition } from '../../types';
import { fetchOpenRouterModels, fetchNousModels, getSettings, updateSettings, type OpenRouterModel } from '../../lib/api';
import '../../styles/panels.css';

export function Inspector() {
  const visible = useUIStore((s) => s.panels.inspector.visible);
  const position = useUIStore((s) => s.panels.inspector.position);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);
  const nodes = useGraphStore((s) => s.nodes);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const executeNode = useGraphStore((s) => s.executeNode);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const deleteNode = useGraphStore((s) => s.deleteNode);
  const configureOpenRouterModel = useGraphStore((s) => s.configureOpenRouterModel);
  const fetchReplicateSchemaAndConfigure = useGraphStore((s) => s.fetchReplicateSchemaAndConfigure);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);

  // OpenRouter model selector state
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  // Replicate schema fetch state
  const [schemaLoading, setSchemaLoading] = useState(false);

  // Info panel toggle
  const [showInfo, setShowInfo] = useState(false);

  // Favorites state
  const [favorites, setFavorites] = useState<Record<string, string[]>>({});

  // Load favorites from settings
  useEffect(() => {
    getSettings().then((settings: any) => {
      setFavorites(settings.favorites ?? {});
    }).catch(() => {});
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const nodeData = selectedNode?.data as NodeData | undefined;
  const definition = nodeData ? NODE_DEFINITIONS[nodeData.definitionId] : undefined;

  // Resolve params: dual-param nodes use sharedParams + (falParams or directParams)
  const { settingsCache } = useUIStore.getState();
  const resolvedParams: ParamDefinition[] = useMemo(() => {
    if (!definition) return [];
    if (definition.sharedParams) {
      const useDirectRoute = definition.directKeyName
        && settingsCache.loaded
        && Boolean(settingsCache.apiKeys[definition.directKeyName]);
      const routeParams = useDirectRoute
        ? (definition.directParams ?? [])
        : (definition.falParams ?? []);
      return [...definition.sharedParams, ...routeParams];
    }
    return definition.params;
  }, [definition, settingsCache.loaded, settingsCache.apiKeys, definition?.directKeyName]);

  // Filter params by visibleWhen conditions
  const visibleParams = useMemo(() => {
    if (!nodeData) return resolvedParams;
    return resolvedParams.filter((param) => {
      if (!param.visibleWhen) return true;
      return Object.entries(param.visibleWhen).every(([key, allowedValues]) => {
        const currentValue = nodeData.params[key];
        // If the controlling param isn't set (e.g. model in directParams when using FAL), pass through
        if (currentValue === undefined || currentValue === null) return true;
        return allowedValues.includes(currentValue as string | number | boolean);
      });
    });
  }, [resolvedParams, nodeData?.params]);

  // Universal-model nodes (OpenRouter, Nous Portal) share the modality-driven
  // model-picker UX. Map definitionId → favorites bucket + loader so we can
  // drive both with one effect and one render branch.
  const universalProvider: 'openrouter' | 'nous' | null =
    nodeData?.definitionId === 'openrouter-universal'
      ? 'openrouter'
      : nodeData?.definitionId === 'nous-portal-universal'
        ? 'nous'
        : null;
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);

  // Fetch the right model list for the selected universal node
  useEffect(() => {
    if (!universalProvider) {
      setModelLoadError(null);
      return;
    }
    setModelsLoading(true);
    setModelLoadError(null);
    const loader = universalProvider === 'openrouter' ? fetchOpenRouterModels : fetchNousModels;
    loader()
      .then((data) => setOpenRouterModels(data.models))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setModelLoadError(msg);
        setOpenRouterModels([]);
      })
      .finally(() => setModelsLoading(false));
  }, [universalProvider]);

  // Filter models by search query — cap at 50 to avoid huge dropdowns, favorites sorted to top
  const filteredModels = useMemo(() => {
    const favIds = (universalProvider && favorites[universalProvider]) ?? [];
    let models = openRouterModels;
    if (modelSearch.trim()) {
      const lower = modelSearch.toLowerCase();
      models = models.filter((m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower));
    }
    const sorted = [...models].sort((a, b) => {
      const aFav = favIds.includes(a.id) ? 0 : 1;
      const bFav = favIds.includes(b.id) ? 0 : 1;
      return aFav - bFav;
    });
    return sorted.slice(0, 50);
  }, [openRouterModels, modelSearch, favorites, universalProvider]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('inspector', {
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

  if (!visible || !selectedNode || !nodeData) return null;
  // For dynamic nodes, definition may be a shell — that's fine
  if (!definition && !(nodeData as unknown as DynamicNodeData)?.isDynamic) return null;

  const resolvedX = position.x < 0 ? window.innerWidth + position.x : position.x;

  function onParamChange(key: string, value: unknown) {
    if (!selectedNodeId) return;
    updateNodeData(selectedNodeId, {
      params: { ...nodeData!.params, [key]: value },
    });
  }

  return (
    <div
      className="panel panel--inspector"
      style={{ left: resolvedX, top: position.y }}
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
        <span className="panel__title">Inspector</span>
        <button className="panel__close" onClick={() => togglePanel('inspector')}>
          ×
        </button>
      </div>

      <div className="panel__body">
        <div className="inspector__node-header">
          <span
            className="inspector__node-dot"
            style={{
              backgroundColor: CATEGORY_COLORS[definition?.category ?? 'universal'],
            }}
          />
          <span className="inspector__node-name">{nodeData.label}</span>
          {definition && (
            <button
              className="inspector__info-button"
              onClick={() => setShowInfo(!showInfo)}
              title="Node info — inputs, outputs, and settings"
            >
              {showInfo ? '✕' : 'i'}
            </button>
          )}
        </div>

        {showInfo && definition && (
          <div className="inspector__info-panel">
            <div className="inspector__info-section">
              <div className="inspector__info-heading">Inputs</div>
              {definition.inputPorts.length === 0 ? (
                <div className="inspector__info-row">None</div>
              ) : (
                definition.inputPorts.map((p) => (
                  <div key={p.id} className="inspector__info-row">
                    <span className="inspector__info-dot" style={{ backgroundColor: PORT_COLORS[p.dataType as keyof typeof PORT_COLORS] ?? '#9E9E9E' }} />
                    <span className="inspector__info-name">{p.label}</span>
                    <span className="inspector__info-type">{p.dataType}{p.required ? '' : ' (optional)'}{p.multiple ? ' +' : ''}</span>
                  </div>
                ))
              )}
            </div>
            <div className="inspector__info-section">
              <div className="inspector__info-heading">Outputs</div>
              {definition.outputPorts.length === 0 ? (
                <div className="inspector__info-row">None</div>
              ) : (
                definition.outputPorts.map((p) => (
                  <div key={p.id} className="inspector__info-row">
                    <span className="inspector__info-dot" style={{ backgroundColor: PORT_COLORS[p.dataType as keyof typeof PORT_COLORS] ?? '#9E9E9E' }} />
                    <span className="inspector__info-name">{p.label}</span>
                    <span className="inspector__info-type">{p.dataType}</span>
                  </div>
                ))
              )}
            </div>
            <div className="inspector__info-section">
              <div className="inspector__info-heading">Settings</div>
              {visibleParams.length === 0 ? (
                <div className="inspector__info-row">None</div>
              ) : (
                visibleParams.map((p) => (
                  <div key={p.key} className="inspector__info-row">
                    <span className="inspector__info-name">{p.label}</span>
                    <span className="inspector__info-type">
                      {p.type}{p.default !== undefined && p.default !== '' ? ` = ${p.default}` : ''}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="inspector__info-meta">
              Provider: {definition.apiProvider} &middot; {definition.executionPattern}
            </div>
          </div>
        )}

        {visibleParams.map((param) => (
          <div key={param.key} className="inspector__section">
            <div className="inspector__label">{param.label}</div>
            {/* Universal models (OpenRouter, Nous Portal): searchable dropdown
                with favorites scoped per provider. configureOpenRouterModel
                is provider-agnostic — it shapes ports from modalities. */}
            {universalProvider && param.key === 'model' ? (
              <div>
                <input
                  className="inspector__field"
                  type="text"
                  placeholder={
                    modelsLoading
                      ? 'Loading models…'
                      : modelLoadError
                        ? 'Could not load models'
                        : 'Search models…'
                  }
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                />
                <select
                  className="inspector__field"
                  style={{ marginTop: 4 }}
                  value={String(nodeData.params.model ?? '')}
                  onChange={(e) => {
                    const selected = openRouterModels.find((m) => m.id === e.target.value);
                    if (selected && selectedNodeId) {
                      configureOpenRouterModel(selectedNodeId, selected.id, selected);
                    }
                  }}
                >
                  <option value="">-- Select a model --</option>
                  {filteredModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {(favorites[universalProvider] ?? []).includes(m.id) ? '★ ' : ''}{m.name} ({m.id})
                    </option>
                  ))}
                </select>
                {modelLoadError && universalProvider === 'nous' && (
                  <div style={{ fontSize: 10, color: '#c58b3a', marginTop: 4, lineHeight: 1.4 }}>
                    {modelLoadError}
                  </div>
                )}
                {nodeData.params.model && (
                  <div style={{ fontSize: 10, color: '#666', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>Selected: {String(nodeData.params.model)}</span>
                    <button
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 14,
                        padding: 0,
                        color: (favorites[universalProvider] ?? []).includes(String(nodeData.params.model)) ? '#FFC107' : '#555',
                      }}
                      title="Toggle favorite"
                      onClick={() => {
                        const modelId = String(nodeData.params.model);
                        const current = favorites[universalProvider] ?? [];
                        const updated = current.includes(modelId)
                          ? current.filter((m: string) => m !== modelId)
                          : [...current, modelId];
                        const newFavorites = { ...favorites, [universalProvider]: updated };
                        setFavorites(newFavorites);
                        updateSettings({ favorites: newFavorites }).catch(() => {});
                      }}
                    >
                      {(favorites[universalProvider] ?? []).includes(String(nodeData.params.model)) ? '★' : '☆'}
                    </button>
                  </div>
                )}
              </div>
            ) : param.type === 'enum' && param.options ? (
              <select
                className="inspector__field"
                value={String(nodeData.params[param.key] ?? param.default ?? '')}
                onChange={(e) => onParamChange(param.key, e.target.value)}
              >
                {param.options
                  .filter((opt) => {
                    if (!opt.visibleWhen) return true;
                    return Object.entries(opt.visibleWhen).every(([k, allowed]) => {
                      const val = nodeData.params[k];
                      if (val === undefined || val === null) return true;
                      return allowed.includes(val as string | number | boolean);
                    });
                  })
                  .map((opt) => (
                  <option key={String(opt.value)} value={String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : param.type === 'textarea' ? (
              <textarea
                className="inspector__field"
                rows={3}
                value={String(nodeData.params[param.key] ?? param.default ?? '')}
                onChange={(e) => onParamChange(param.key, e.target.value)}
                placeholder={param.placeholder}
              />
            ) : param.type === 'integer' || param.type === 'float' ? (
              <input
                className="inspector__field"
                type="number"
                value={String(nodeData.params[param.key] ?? param.default ?? '')}
                onChange={(e) => onParamChange(param.key, Number(e.target.value))}
                onBlur={(e) => {
                  const raw = Number(e.target.value);
                  if (Number.isNaN(raw)) return;
                  let clamped = raw;
                  if (typeof param.min === 'number' && clamped < param.min) clamped = param.min;
                  if (typeof param.max === 'number' && clamped > param.max) clamped = param.max;
                  if (clamped !== raw) onParamChange(param.key, clamped);
                }}
                min={param.min}
                max={param.max}
                step={param.step ?? (param.type === 'float' ? 0.1 : 1)}
              />
            ) : param.type === 'file' ? (
              <div>
                <label style={{ display: 'inline-block', padding: '4px 10px', background: '#333', border: '1px solid #555', borderRadius: 4, cursor: 'pointer', color: '#ccc', fontSize: 12 }}>
                  Choose File
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const formData = new FormData();
                      formData.append('file', file);
                      fetch('http://localhost:8000/api/uploads', { method: 'POST', body: formData })
                        .then((r) => r.json())
                        .then((data: { filePath: string; url: string }) => {
                          if (!selectedNodeId) return;
                          updateNodeData(selectedNodeId, {
                            params: { ...nodeData!.params, [param.key]: data.filePath, _previewUrl: data.url },
                          });
                        })
                        .catch((err) => console.error('Upload failed:', err));
                    }}
                  />
                </label>
                {nodeData.params._previewUrl && (
                  <img
                    src={String(nodeData.params._previewUrl)}
                    alt="Preview"
                    style={{ width: '100%', borderRadius: 4, marginTop: 6, display: 'block' }}
                  />
                )}
              </div>
            ) : param.type === 'boolean' ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#aaa' }}>
                <input
                  type="checkbox"
                  checked={Boolean(nodeData.params[param.key] ?? param.default)}
                  onChange={(e) => onParamChange(param.key, e.target.checked)}
                />
                {param.label}
              </label>
            ) : (
              <input
                className="inspector__field"
                type="text"
                value={String(nodeData.params[param.key] ?? param.default ?? '')}
                onChange={(e) => onParamChange(param.key, e.target.value)}
                placeholder={param.placeholder}
              />
            )}
            {/* Replicate: show Fetch Schema button below the model_id field */}
            {nodeData.definitionId === 'replicate-universal' && param.key === 'model_id' && (
              <button
                className="inspector__action-button"
                style={{ marginTop: 4, width: '100%' }}
                disabled={schemaLoading || !nodeData.params.model_id}
                onClick={async () => {
                  const modelId = String(nodeData.params.model_id ?? '');
                  if (!modelId.includes('/')) return;
                  const [owner, name] = modelId.split('/', 2);
                  setSchemaLoading(true);
                  try {
                    await fetchReplicateSchemaAndConfigure(selectedNodeId!, owner, name);
                  } finally {
                    setSchemaLoading(false);
                  }
                }}
              >
                {schemaLoading ? 'Fetching...' : (nodeData.params._schema_fetched ? 'Refresh Schema' : 'Fetch Schema')}
              </button>
            )}
          </div>
        ))}

        {/* Dynamic params for dynamic nodes */}
        {(() => {
          const dynData = nodeData as unknown as DynamicNodeData;
          const hasDynamicParams = dynData?.isDynamic && dynData.dynamicParams?.length > 0;
          if (!hasDynamicParams) return null;
          return dynData.dynamicParams.map((param) => (
            <div key={param.key} className="inspector__section">
              <div className="inspector__label">{param.label}</div>
              {param.type === 'enum' && param.options ? (
                <select
                  className="inspector__field"
                  value={String(nodeData.params[param.key] ?? param.default ?? '')}
                  onChange={(e) => onParamChange(param.key, e.target.value)}
                >
                  {param.options.map((opt) => (
                    <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
                  ))}
                </select>
              ) : param.type === 'integer' || param.type === 'float' ? (
                <input
                  className="inspector__field"
                  type="number"
                  value={String(nodeData.params[param.key] ?? param.default ?? '')}
                  onChange={(e) => onParamChange(param.key, Number(e.target.value))}
                  onBlur={(e) => {
                    const raw = Number(e.target.value);
                    if (Number.isNaN(raw)) return;
                    let clamped = raw;
                    if (typeof param.min === 'number' && clamped < param.min) clamped = param.min;
                    if (typeof param.max === 'number' && clamped > param.max) clamped = param.max;
                    if (clamped !== raw) onParamChange(param.key, clamped);
                  }}
                  min={param.min}
                  max={param.max}
                  step={param.step ?? (param.type === 'float' ? 0.1 : 1)}
                />
              ) : param.type === 'boolean' ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#aaa' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(nodeData.params[param.key] ?? param.default)}
                    onChange={(e) => onParamChange(param.key, e.target.checked)}
                  />
                  {param.label}
                </label>
              ) : (
                <input
                  className="inspector__field"
                  type="text"
                  value={String(nodeData.params[param.key] ?? param.default ?? '')}
                  onChange={(e) => onParamChange(param.key, e.target.value)}
                  placeholder={param.placeholder}
                />
              )}
            </div>
          ));
        })()}

        <div className="inspector__section" style={{ marginTop: 16, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
          <div className="inspector__label">State</div>
          <div style={{ color: '#888', fontSize: 11 }}>{nodeData.state}</div>
        </div>

        {/* Actions */}
        <div className="inspector__section" style={{ marginTop: 12, borderTop: '1px solid #2a2a2a', paddingTop: 8, display: 'flex', gap: 6 }}>
          <button
            className="inspector__action-button"
            onClick={() => selectedNodeId && executeNode(selectedNodeId)}
            title="Run this node and its dependencies"
          >
            ▶ Run
          </button>
          <button
            className="inspector__action-button"
            onClick={() => selectedNodeId && duplicateNode(selectedNodeId)}
            title="Duplicate this node"
          >
            Duplicate
          </button>
          <button
            className="inspector__action-button inspector__action-button--danger"
            onClick={() => selectedNodeId && deleteNode(selectedNodeId)}
            title="Delete this node"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
