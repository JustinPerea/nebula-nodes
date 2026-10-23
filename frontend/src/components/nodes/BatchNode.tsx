import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { batchAuthoringError, batchSizeCap, parseBatchItems } from '../../lib/batch';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { useUIStore } from '../../store/uiStore';
import { useSlavaNodeEntranceClass } from '../../hooks/useSlavaNodeEntrance';
import { NodeError } from './NodeError';
import '../../styles/batch-node.css';

function BatchNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as NodeData;
  const selectNode = useUIStore((state) => state.selectNode);
  // Booleans, so another node's selection doesn't re-render this card.
  const selectedInUi = useUIStore((state) => state.selectedNodeId === id);
  const setInspectorVisible = useUIStore((state) => state.setInspectorVisible);
  const entranceClass = useSlavaNodeEntranceClass();
  const items = parseBatchItems(nodeData.params);
  const cap = batchSizeCap(nodeData.params);
  const authoringError = batchAuthoringError(nodeData.params);
  const name = typeof nodeData.params.display_name === 'string' && nodeData.params.display_name.trim()
    ? nodeData.params.display_name : 'Batch';
  const isSelected = selected || selectedInUi;
  // The run stopped at the cap check (error copy round 3e): its error says
  // the cap with the field's label, so the card's own warning, which says
  // the same, steps aside while both would show (GM: one fact once). The
  // agents' text names the check word for word (backend engine._batch_items).
  const stoppedOnCap = nodeData.state === 'error' && /exceeding its batch_size_cap of \d+/.test(nodeData.error ?? '');
  const inspectorExpanded = useUIStore((state) => isSelected && state.panels.inspector.visible);

  return (
    <div className={`batch-node${isSelected ? ' batch-node--selected' : ''}${entranceClass}`}
      onClick={() => selectNode(id)}>
      <div className="batch-node__header">
        <strong className="batch-node__name">{name}</strong>
        <span className="batch-node__count">{items.length} item{items.length === 1 ? '' : 's'}</span>
        <button type="button" className="batch-node__edit nodrag" aria-label="Edit Batch items"
          data-node-inspector-anchor={id} aria-haspopup="dialog"
          aria-expanded={inspectorExpanded}
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
      {items.length > cap && !stoppedOnCap && <p className="batch-node__warning" role="alert">
        {items.length} items exceed the cap of {cap}. Reduce items or raise the cap in settings (maximum 25).
      </p>}
      {/* The run error reads like every node card's (error copy round 3c-2):
          the person's line, the classifier's, or GM's general line over a
          closed Details. Agents read nodeData.error itself, unchanged. */}
      {nodeData.state === 'error' && nodeData.error && <div role="alert">
        <NodeError className="batch-node__warning" raw={nodeData.error} category={nodeData.errorCategory}
          friendly={nodeData.errorFriendly} person={nodeData.errorPerson}
          providerText={nodeData.errorProviderText} />
      </div>}
      <div className="batch-node__output">
        <span>Items</span>
        <Handle type="source" position={Position.Right} id="set" aria-label="Batch items output"
          className="model-node__handle" style={{ backgroundColor: PORT_COLORS.Text }} />
      </div>
    </div>
  );
}

export const BatchNode = memo(BatchNodeComponent);
