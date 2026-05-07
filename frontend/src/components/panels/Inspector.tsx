import { useRef, useEffect, useState, useMemo } from 'react';
import { Copy, Info, Play, RefreshCw, Star, Trash2, Upload, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import { PORT_COLORS } from '../../lib/portCompatibility';
import type { NodeData, DynamicNodeData, DynamicParamDefinition, ParamDefinition } from '../../types';
import { fetchOpenRouterModels, fetchNousModels, getSettings, updateSettings, type OpenRouterModel } from '../../lib/api';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import '../../styles/panels.css';

type InspectorParamDefinition = ParamDefinition | DynamicParamDefinition;

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
  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);

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
    getSettings().then((settings: { favorites?: Record<string, string[]> }) => {
      setFavorites(settings.favorites ?? {});
    }).catch(() => setFavorites({}));
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedNodeData = selectedNode?.data as NodeData | undefined;
  const lastSelectionRef = useRef<{ node: NonNullable<typeof selectedNode>; data: NodeData } | null>(null);
  if (selectedNode && selectedNodeData) {
    lastSelectionRef.current = { node: selectedNode, data: selectedNodeData };
  }
  const renderNode = selectedNode ?? (exiting ? lastSelectionRef.current?.node : undefined);
  const nodeData = selectedNodeData ?? (exiting ? lastSelectionRef.current?.data : undefined);
  const definition = nodeData ? NODE_DEFINITIONS[nodeData.definitionId] : undefined;

  // Resolve params: dual-param nodes use sharedParams + (falParams or directParams)
  const settingsCache = useUIStore((s) => s.settingsCache);
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
  }, [definition, settingsCache.loaded, settingsCache.apiKeys]);

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
  }, [resolvedParams, nodeData]);

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
    let cancelled = false;
    setModelsLoading(true);
    setModelLoadError(null);
    const loader = universalProvider === 'openrouter' ? fetchOpenRouterModels : fetchNousModels;
    loader()
      .then((data) => {
        if (!cancelled) setOpenRouterModels(data.models);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setModelLoadError(msg);
        setOpenRouterModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
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

  if (!shouldRender || !renderNode || !nodeData) return null;
  // For dynamic nodes, definition may be a shell — that's fine
  if (!definition && !(nodeData as unknown as DynamicNodeData)?.isDynamic) return null;

  const resolvedX = position.x < 0 ? window.innerWidth + position.x : position.x;
  const activeNode = renderNode;
  const activeNodeData = nodeData;

  function onParamChange(key: string, value: unknown) {
    updateNodeData(activeNode.id, {
      params: { ...activeNodeData.params, [key]: value },
    });
  }

  const requiredKeys = definition
    ? Array.isArray(definition.envKeyName)
      ? definition.envKeyName
      : [definition.envKeyName]
    : [];
  const missingApiKeys = activeNodeData.keyStatus === 'missing'
    ? requiredKeys.filter(Boolean)
    : [];

  function getVisibleOptions(param: InspectorParamDefinition) {
    return (param.options ?? []).filter((opt) => {
      if (!('visibleWhen' in opt) || !opt.visibleWhen) return true;
      return Object.entries(opt.visibleWhen).every(([key, allowedValues]) => {
        const currentValue = activeNodeData.params[key];
        if (currentValue === undefined || currentValue === null) return true;
        return allowedValues.includes(currentValue as string | number | boolean);
      });
    });
  }

  function renderUniversalModelControl() {
    if (!universalProvider) return null;

    const selectedModel = String(activeNodeData.params.model ?? '');
    const favoriteIds = favorites[universalProvider] ?? [];
    const isFavorite = selectedModel !== '' && favoriteIds.includes(selectedModel);

    return (
      <div className="inspector__control-stack">
        <input
          className="inspector__field"
          type="text"
          placeholder={
            modelsLoading
              ? 'Loading models...'
              : modelLoadError
                ? 'Could not load models'
                : 'Search models...'
          }
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
        />
        <select
          className="inspector__field"
          value={selectedModel}
          onChange={(e) => {
            const selected = openRouterModels.find((m) => m.id === e.target.value);
            if (selected) {
              configureOpenRouterModel(activeNode.id, selected.id, selected);
            }
          }}
        >
          <option value="">Select a model</option>
          {filteredModels.map((model) => (
            <option key={model.id} value={model.id}>
              {favoriteIds.includes(model.id) ? '* ' : ''}{model.name} ({model.id})
            </option>
          ))}
        </select>
        {modelLoadError && universalProvider === 'nous' && (
          <div className="inspector__model-error">
            {modelLoadError}
          </div>
        )}
        {selectedModel !== '' && (
          <div className="inspector__model-selection">
            <span className="inspector__model-selection-text">Selected: {selectedModel}</span>
            <button
              type="button"
              className={
                isFavorite
                  ? 'inspector__favorite-button inspector__favorite-button--active'
                  : 'inspector__favorite-button'
              }
              title={isFavorite ? 'Remove favorite' : 'Add favorite'}
              aria-label={isFavorite ? 'Remove model from favorites' : 'Add model to favorites'}
              aria-pressed={isFavorite}
              onClick={() => {
                const updated = isFavorite
                  ? favoriteIds.filter((modelId: string) => modelId !== selectedModel)
                  : [...favoriteIds, selectedModel];
                const newFavorites = { ...favorites, [universalProvider]: updated };
                setFavorites(newFavorites);
                updateSettings({ favorites: newFavorites }).catch(() => undefined);
              }}
            >
              <Star
                className="inspector__favorite-icon"
                size={14}
                strokeWidth={1.75}
                fill={isFavorite ? 'currentColor' : 'none'}
                aria-hidden="true"
                focusable="false"
              />
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderParamControl(param: InspectorParamDefinition) {
    const value = activeNodeData.params[param.key] ?? param.default ?? '';

    if (universalProvider && param.key === 'model') {
      return renderUniversalModelControl();
    }

    if (param.type === 'enum' && param.options) {
      return (
        <select
          className="inspector__field"
          value={String(value)}
          onChange={(e) => onParamChange(param.key, e.target.value)}
        >
          {getVisibleOptions(param).map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    if (param.type === 'textarea') {
      return (
        <textarea
          className="inspector__field"
          rows={3}
          value={String(value)}
          onChange={(e) => onParamChange(param.key, e.target.value)}
          placeholder={param.placeholder}
        />
      );
    }

    if (param.type === 'integer' || param.type === 'float') {
      return (
        <input
          className="inspector__field"
          type="number"
          value={String(value)}
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
      );
    }

    if (param.type === 'file') {
      return (
        <div className="inspector__control-stack">
          <label className="inspector__file-button">
            <Upload
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>Choose File</span>
            <input
              type="file"
              accept="image/*"
              className="inspector__file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const formData = new FormData();
                formData.append('file', file);
                fetch('http://localhost:8000/api/uploads', { method: 'POST', body: formData })
                  .then((r) => r.json())
                  .then((data: { filePath: string; url: string }) => {
                    updateNodeData(activeNode.id, {
                      params: { ...activeNodeData.params, [param.key]: data.filePath, _previewUrl: data.url },
                    });
                  })
                  .catch((err) => console.error('Upload failed:', err));
              }}
            />
          </label>
          {typeof activeNodeData.params._previewUrl === 'string' && (
            <img
              src={String(activeNodeData.params._previewUrl)}
              alt="Preview"
              className="inspector__file-preview"
            />
          )}
        </div>
      );
    }

    if (param.type === 'boolean') {
      return (
        <label className="inspector__checkbox-row">
          <input
            type="checkbox"
            checked={Boolean(activeNodeData.params[param.key] ?? param.default)}
            onChange={(e) => onParamChange(param.key, e.target.checked)}
          />
          <span className="inspector__checkbox-copy">{param.label}</span>
        </label>
      );
    }

    return (
      <input
        className="inspector__field"
        type="text"
        value={String(value)}
        onChange={(e) => onParamChange(param.key, e.target.value)}
        placeholder={param.placeholder}
      />
    );
  }

  function renderParamSection(param: InspectorParamDefinition, source: 'definition' | 'dynamic') {
    const showLabel = param.type !== 'boolean';
    return (
      <div
        key={`${source}-${param.key}`}
        className="inspector__section inspector__section--param"
        data-inspector-param={param.key}
        data-inspector-kind={param.type}
        data-inspector-source={source}
      >
        {showLabel && <div className="inspector__label">{param.label}</div>}
        {renderParamControl(param)}
        {activeNodeData.definitionId === 'replicate-universal' && param.key === 'model_id' && (
          <button
            type="button"
            className="inspector__action-button inspector__action-button--full inspector__action-button--stacked"
            disabled={schemaLoading || !activeNodeData.params.model_id}
            onClick={async () => {
              const modelId = String(activeNodeData.params.model_id ?? '');
              if (!modelId.includes('/')) return;
              const [owner, name] = modelId.split('/', 2);
              setSchemaLoading(true);
              try {
                await fetchReplicateSchemaAndConfigure(activeNode.id, owner, name);
              } finally {
                setSchemaLoading(false);
              }
            }}
          >
            <RefreshCw
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>{schemaLoading ? 'Fetching...' : (activeNodeData.params._schema_fetched ? 'Refresh Schema' : 'Fetch Schema')}</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`panel panel--inspector${exiting ? ' panel--exiting' : ''}`}
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
        <button
          type="button"
          className="panel__header-action panel__close"
          onClick={() => togglePanel('inspector')}
          aria-label="Close inspector panel"
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

      <div className="panel__body" key={renderNode.id}>
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
              type="button"
              className="inspector__info-button"
              onClick={() => setShowInfo(!showInfo)}
              title="Node info — inputs, outputs, and settings"
              aria-label={showInfo ? 'Hide node info' : 'Show node info'}
              aria-expanded={showInfo}
            >
              {showInfo ? (
                <X
                  className="inspector__info-icon"
                  size={13}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  focusable="false"
                />
              ) : (
                <Info
                  className="inspector__info-icon"
                  size={13}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  focusable="false"
                />
              )}
            </button>
          )}
        </div>

        {missingApiKeys.length > 0 && (
          <div className="inspector__notice inspector__notice--warning" role="status">
            Missing API key: {missingApiKeys.join(', ')}
          </div>
        )}

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

        {visibleParams.map((param) => renderParamSection(param, 'definition'))}

        {/* Dynamic params for dynamic nodes */}
        {(() => {
          const dynData = nodeData as unknown as DynamicNodeData;
          const hasDynamicParams = dynData?.isDynamic && dynData.dynamicParams?.length > 0;
          if (!hasDynamicParams) return null;
          return dynData.dynamicParams.map((param) => renderParamSection(param, 'dynamic'));
        })()}

        <div className="inspector__section inspector__section--separated">
          <div className="inspector__label">State</div>
          <div className="inspector__state-value">{nodeData.state}</div>
        </div>

        {/* Actions */}
        <div className="inspector__section inspector__actions">
          <button
            type="button"
            className="inspector__action-button"
            onClick={() => executeNode(renderNode.id)}
            title="Run this node and its dependencies"
          >
            <Play
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>Run</span>
          </button>
          <button
            type="button"
            className="inspector__action-button"
            onClick={() => duplicateNode(renderNode.id)}
            title="Duplicate this node"
          >
            <Copy
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>Duplicate</span>
          </button>
          <button
            type="button"
            className="inspector__action-button inspector__action-button--danger"
            onClick={() => deleteNode(renderNode.id)}
            title="Delete this node"
          >
            <Trash2
              className="inspector__action-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            <span>Delete</span>
          </button>
        </div>
      </div>
    </div>
  );
}
