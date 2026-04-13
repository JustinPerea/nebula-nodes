import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData, DynamicNodeData, PortDataType } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import '../../styles/nodes.css';

function isDynamicData(data: NodeData): data is DynamicNodeData {
  return 'isDynamic' in data && (data as DynamicNodeData).isDynamic === true;
}

function DynamicNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const selectNode = useUIStore((s) => s.selectNode);

  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const categoryColor = CATEGORY_COLORS[definition?.category ?? 'universal'] ?? '#E65100';
  const stateClass = `model-node--${nodeData.state}`;

  // For dynamic nodes, read ports from data; for fallback, use definition
  const dynData = isDynamicData(nodeData) ? nodeData : null;
  const inputPorts = dynData?.dynamicInputPorts ?? definition?.inputPorts ?? [];
  const outputPorts = dynData?.dynamicOutputPorts ?? definition?.outputPorts ?? [];

  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;

  // Model badge: show selected model compactly
  const modelBadge = dynData?.modelId || (nodeData.params.model as string) || (nodeData.params.model_id as string) || (nodeData.params.endpoint_id as string) || null;

  return (
    <div className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`} onClick={() => selectNode(id)}>
      <div className="model-node__header">
        <span className="model-node__category-dot" style={{ backgroundColor: categoryColor }} />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && <span className="model-node__badge model-node__badge--warning" title="API Key Missing">&#x26A0;</span>}
      </div>

      {/* Model badge */}
      {modelBadge && (
        <div className="dynamic-node__model-badge">
          {modelBadge.length > 35 ? `...${modelBadge.slice(-32)}` : modelBadge}
        </div>
      )}

      {inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType as PortDataType] ?? PORT_COLORS.Any }}
              />
              <span className="model-node__port-label">{port.label}</span>
            </div>
          ))}
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

      {displayText && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {displayText.length > 300 ? `${displayText.slice(0, 300)}...` : displayText}
          </div>
        </div>
      )}

      {nodeData.state === 'error' && nodeData.error && (
        <div className="model-node__error">{nodeData.error}</div>
      )}

      {outputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--output">
          {outputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row model-node__port-row--output">
              <span className="model-node__port-label">{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType as PortDataType] ?? PORT_COLORS.Any }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const DynamicNode = memo(DynamicNodeComponent);
