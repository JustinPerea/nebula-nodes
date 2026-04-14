import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { MeshPreview } from './MeshPreview';
import '../../styles/nodes.css';

function ModelNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const selectNode = useUIStore((s) => s.selectNode);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      e.stopPropagation();
      updateNodeData(id, {
        params: { ...nodeData.params, value: e.target.value },
      });
    },
    [id, nodeData.params, updateNodeData]
  );

  if (!definition) return <div className="model-node model-node--error">Unknown node type</div>;

  const categoryColor = CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;
  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const videoOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Video' && o.value);
  const meshOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Mesh' && o.value);

  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;
  const isTextInput = nodeData.definitionId === 'text-input';

  return (
    <div className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`} onClick={() => selectNode(id)}>
      <div className="model-node__header">
        <span className="model-node__category-dot" style={{ backgroundColor: categoryColor }} />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && <span className="model-node__badge model-node__badge--warning" title="API Key Missing">&#x26A0;</span>}
      </div>

      {definition.inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {definition.inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle type="target" position={Position.Left} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
              <span className="model-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Inline textarea for text-input nodes */}
      {isTextInput && (
        <div className="model-node__inline-textarea">
          <textarea
            className="model-node__textarea nodrag nowheel"
            value={String(nodeData.params.value ?? '')}
            onChange={handleTextChange}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Enter text or prompt..."
            rows={4}
            spellCheck={false}
          />
        </div>
      )}

      {nodeData.state === 'executing' && nodeData.progress !== undefined && (
        <div className="model-node__progress">
          <div className="model-node__progress-bar" style={{ width: `${Math.round(nodeData.progress * 100)}%` }} />
        </div>
      )}

      {nodeData.state === 'complete' && imageOutput && typeof imageOutput.value === 'string' && (
        <div className="model-node__preview">
          <img src={imageOutput.value} alt="Generated output" className="model-node__preview-image" loading="lazy" />
        </div>
      )}

      {displayText && !isTextInput && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {displayText.length > 300 ? `${displayText.slice(0, 300)}...` : displayText}
          </div>
        </div>
      )}

      {nodeData.state === 'complete' && videoOutput && (
        <div className="model-node__preview">
          <div className="model-node__preview-placeholder">Video ready</div>
        </div>
      )}

      {nodeData.state === 'complete' && meshOutput && typeof meshOutput.value === 'string' && (
        <div className="model-node__preview">
          <MeshPreview src={meshOutput.value} />
        </div>
      )}

      {nodeData.state === 'complete' && !imageOutput && !textOutput && !videoOutput && !meshOutput && Object.keys(nodeData.outputs).length > 0 && (
        <div className="model-node__preview">
          <div className="model-node__preview-placeholder">Output ready</div>
        </div>
      )}

      {nodeData.state === 'error' && nodeData.error && (
        <div className="model-node__error">{nodeData.error}</div>
      )}

      {definition.outputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--output">
          {definition.outputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row model-node__port-row--output">
              <span className="model-node__port-label">{port.label}</span>
              <Handle type="source" position={Position.Right} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const ModelNode = memo(ModelNodeComponent);
