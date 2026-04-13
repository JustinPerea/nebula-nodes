import { useRef, useEffect, useCallback } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import type { NodeData, DynamicNodeData } from '../../types';
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
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const nodeData = selectedNode?.data as NodeData | undefined;
  const definition = nodeData ? NODE_DEFINITIONS[nodeData.definitionId] : undefined;

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
            {param.type === 'enum' && param.options ? (
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
