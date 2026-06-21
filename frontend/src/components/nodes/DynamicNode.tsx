import { memo, useCallback, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Repeat2 } from 'lucide-react';
import type { NodeData, DynamicNodeData, PortDataType } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import { useSlavaNodeEntranceClass } from '../../hooks/useSlavaNodeEntrance';
import { MeshPreview } from './MeshPreview';
import { NodeError } from './NodeError';
import '../../styles/nodes.css';

function isDynamicData(data: NodeData): data is DynamicNodeData {
  return 'isDynamic' in data && (data as DynamicNodeData).isDynamic === true;
}

function DynamicNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const selectNode = useUIStore((s) => s.selectNode);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const inspectorVisible = useUIStore((s) => s.panels.inspector.visible);
  const setInspectorVisible = useUIStore((s) => s.setInspectorVisible);
  const entranceClass = useSlavaNodeEntranceClass();
  const [videoLoop, setVideoLoop] = useState<boolean>(true);

  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const categoryColor = CATEGORY_COLORS[definition?.category ?? 'universal'] ?? '#E65100';
  const stateClass = `model-node--${nodeData.state}`;

  // For dynamic nodes, read ports from data; for fallback, use definition
  const dynData = isDynamicData(nodeData) ? nodeData : null;
  const inputPorts = dynData?.dynamicInputPorts ?? definition?.inputPorts ?? [];
  const outputPorts = dynData?.dynamicOutputPorts ?? definition?.outputPorts ?? [];

  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const meshOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Mesh' && o.value);
  const videoOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Video' && o.value);
  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;

  // Streaming image partial preview
  const partials = nodeData.streamingPartials;
  const latestPartial = partials && partials.length > 0 ? partials[partials.length - 1] : null;
  const finalImageSrc = imageOutput && typeof imageOutput.value === 'string' ? imageOutput.value : null;
  const previewImageSrc = finalImageSrc ?? latestPartial?.src ?? null;
  const isStreamingImage = nodeData.state === 'executing' && partials != null && partials.length > 0 && finalImageSrc == null;
  const isImageSurface = Boolean(previewImageSrc);
  const isTextSurface = Boolean(displayText);

  // Model badge: show selected model compactly
  const modelBadge = dynData?.modelId || (nodeData.params.model as string) || (nodeData.params.model_id as string) || (nodeData.params.endpoint_id as string) || null;
  const isNodeSelected = selected || selectedNodeId === id;

  const handleInspectorButtonClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      const shouldOpen = selectedNodeId !== id || !inspectorVisible;
      selectNode(id);
      setInspectorVisible(shouldOpen);
    },
    [id, inspectorVisible, selectNode, selectedNodeId, setInspectorVisible],
  );

  return (
    <div
      className={`model-node ${stateClass}${isImageSurface ? ' model-node--image-surface' : ''}${isTextSurface ? ' model-node--text-surface' : ''} ${isNodeSelected ? 'model-node--selected' : ''}${entranceClass}`}
      onClick={() => selectNode(id)}
      style={{ ['--node-category-color' as string]: categoryColor }}
    >
      {/* Type label — floats above the card; hidden in default + Hermes skins. */}
      <div className="model-node__type-label">{definition?.category ?? 'universal'}</div>

      {/* Settings bar — floats above the card when selected. */}
      {isNodeSelected && (
        <div className="model-node__settings-bar">
          <span className="model-node__settings-model">
            {definition?.displayName ?? nodeData.label}
          </span>
          <button
            type="button"
            className="model-node__settings-edit nodrag"
            data-node-inspector-anchor={id}
            aria-haspopup="dialog"
            aria-expanded={inspectorVisible && selectedNodeId === id}
            onClick={handleInspectorButtonClick}
            onMouseDown={(e) => e.stopPropagation()}
            title="Show node settings"
          >
            …
          </button>
        </div>
      )}

      {/* Card — visible content surface, only target of skin background/border. */}
      <div className="model-node__card">
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
              <span className="model-node__port-label">
                {port.label}{port.multiple ? ' +' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {(nodeData.state === 'queued' || nodeData.state === 'executing') && (
        <div className="model-node__loading">
          <div className="model-node__loading-spinner" />
          <span className="model-node__loading-text">
            {nodeData.state === 'queued'
              ? 'Queued...'
              : nodeData.progress !== undefined
                ? `${Math.round(nodeData.progress * 100)}%`
                : 'Starting...'}
          </span>
          {nodeData.state === 'executing' && nodeData.progress !== undefined && (
            <div className="model-node__progress">
              <div className="model-node__progress-bar" style={{ width: `${Math.round(nodeData.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {previewImageSrc && (
        <div className="model-node__preview">
          <img
            src={previewImageSrc}
            className={isStreamingImage ? 'model-node__preview-image--streaming' : 'model-node__preview-image'}
            alt={isStreamingImage ? 'Streaming preview' : 'Generated image'}
            loading="lazy"
          />
        </div>
      )}

      {displayText && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {displayText.length > 300 ? `${displayText.slice(0, 300)}...` : displayText}
          </div>
        </div>
      )}

      {nodeData.state === 'complete' && meshOutput && typeof meshOutput.value === 'string' && (
        <div className="model-node__preview">
          <MeshPreview src={meshOutput.value} />
        </div>
      )}

      {nodeData.state === 'complete' && videoOutput && typeof videoOutput.value === 'string' && (
        <div className="model-node__preview">
          <video
            src={videoOutput.value}
            controls
            loop={videoLoop}
            className="model-node__preview-video nodrag nowheel"
            onMouseDown={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className={`model-node__loop-toggle nodrag ${videoLoop ? 'model-node__loop-toggle--on' : ''}`}
            title={videoLoop ? 'Loop: on (click to stop looping)' : 'Loop: off (click to loop)'}
            onClick={(e) => {
              e.stopPropagation();
              setVideoLoop((v) => !v);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            aria-pressed={videoLoop}
            aria-label="Toggle video loop"
          >
            <Repeat2
              className="model-node__loop-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        </div>
      )}

      {nodeData.state === 'error' && nodeData.error && (
        <NodeError
          category={nodeData.errorCategory}
          friendly={nodeData.errorFriendly}
          raw={nodeData.error}
        />
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
    </div>
  );
}

export const DynamicNode = memo(DynamicNodeComponent);
