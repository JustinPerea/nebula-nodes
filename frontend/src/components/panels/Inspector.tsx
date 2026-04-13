import { useRef, useEffect, useState, useMemo } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import type { NodeData, DynamicNodeData } from '../../types';
import { fetchOpenRouterModels, type OpenRouterModel } from '../../lib/api';
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

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const nodeData = selectedNode?.data as NodeData | undefined;
  const definition = nodeData ? NODE_DEFINITIONS[nodeData.definitionId] : undefined;

  // Fetch OpenRouter models when an OpenRouter node is selected
  useEffect(() => {
    if (!nodeData || nodeData.definitionId !== 'openrouter-universal') return;
    setModelsLoading(true);
    fetchOpenRouterModels()
      .then((data) => setOpenRouterModels(data.models))
      .catch((err) => console.error('Failed to load OpenRouter models:', err))
      .finally(() => setModelsLoading(false));
  }, [nodeData?.definitionId]);

  // Filter models by search query — cap at 50 to avoid huge dropdowns
  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return openRouterModels.slice(0, 50);
    const lower = modelSearch.toLowerCase();
    return openRouterModels
      .filter((m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower))
      .slice(0, 50);
  }, [openRouterModels, modelSearch]);

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
      className="panel"
      style={{ left: resolvedX, top: position.y, width: 260 }}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: CATEGORY_COLORS[definition?.category ?? 'universal'],
              flexShrink: 0,
            }}
          />
          <span style={{ color: '#eee', fontWeight: 500, fontSize: 13 }}>
            {nodeData.label}
          </span>
        </div>

        {(definition?.params ?? []).map((param) => (
          <div key={param.key} className="inspector__section">
            <div className="inspector__label">{param.label}</div>
            {/* OpenRouter: replace the 'model' param with a searchable dropdown */}
            {nodeData.definitionId === 'openrouter-universal' && param.key === 'model' ? (
              <div>
                <input
                  className="inspector__field"
                  type="text"
                  placeholder={modelsLoading ? 'Loading models...' : 'Search models...'}
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
                      {m.name} ({m.id})
                    </option>
                  ))}
                </select>
                {nodeData.params.model && (
                  <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
                    Selected: {String(nodeData.params.model)}
                  </div>
                )}
              </div>
            ) : param.type === 'enum' && param.options ? (
              <select
                className="inspector__field"
                value={String(nodeData.params[param.key] ?? param.default ?? '')}
                onChange={(e) => onParamChange(param.key, e.target.value)}
              >
                {param.options.map((opt) => (
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
