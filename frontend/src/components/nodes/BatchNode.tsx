import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { batchAuthoringError, batchSizeCap, parseBatchItems } from '../../lib/batch';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { useUIStore } from '../../store/uiStore';
import { useSlavaNodeEntranceClass } from '../../hooks/useSlavaNodeEntrance';
import '../../styles/batch-node.css';

function BatchNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as NodeData;
  const selectNode = useUIStore((state) => state.selectNode);
  const selectedNodeId = useUIStore((state) => state.selectedNodeId);
  const inspectorVisible = useUIStore((state) => state.panels.inspector.visible);
  const setInspectorVisible = useUIStore((state) => state.setInspectorVisible);
  const entranceClass = useSlavaNodeEntranceClass();
  const items = parseBatchItems(nodeData.params);
  const cap = batchSizeCap(nodeData.params);
  const authoringError = batchAuthoringError(nodeData.params);
  const name = typeof nodeData.params.display_name === 'string' && nodeData.params.display_name.trim()
    ? nodeData.params.display_name : 'Batch';
  const isSelected = selected || selectedNodeId === id;

  return (
    <div className={`batch-node${isSelected ? ' batch-node--selected' : ''}${entranceClass}`}
      onClick={() => selectNode(id)}>
      <div className="batch-node__header">
        <strong className="batch-node__name">{name}</strong>
        <span className="batch-node__count">{items.length} item{items.length === 1 ? '' : 's'}</span>
        <button type="button" className="batch-node__edit nodrag" aria-label="Edit Batch items"
          data-node-inspector-anchor={id} aria-haspopup="dialog"
          aria-expanded={isSelected && inspectorVisible}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation(); selectNode(id); setInspectorVisible(true);
          }}>…</button>
      </div>
      <div className="batch-node__list">
        {!items.length && <span className="batch-node__empty">Add items in settings</span>}
        {items.slice(0, 8).map((item, index) => <div className="batch-node__item" key={index} title={item}>
          <span className="batch-node__item-index">{index + 1}.</span><span>{item}</span>
        </div>)}
        {items.length > 8 && <span className="batch-node__overflow">+ {items.length - 8} more</span>}
      </div>
      <p className="batch-node__guidance">Cap {cap} · Run explicitly. Editing does not generate.</p>
      {authoringError && <p className="batch-node__warning" role="alert">{authoringError}</p>}
      {items.length > cap && <p className="batch-node__warning" role="alert">
        {items.length} items exceed the cap of {cap}. Reduce items or raise the cap in settings (maximum 25).
      </p>}
      {nodeData.state === 'error' && nodeData.error && <p className="batch-node__warning" role="alert">{nodeData.error}</p>}
      <div className="batch-node__output">
        <span>Items</span>
        <Handle type="source" position={Position.Right} id="set" aria-label="Batch items output"
          className="model-node__handle" style={{ backgroundColor: PORT_COLORS.Text }} />
      </div>
    </div>
  );
}

export const BatchNode = memo(BatchNodeComponent);
