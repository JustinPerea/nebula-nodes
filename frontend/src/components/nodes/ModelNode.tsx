import { memo, useCallback, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { MeshPreview } from './MeshPreview';
import '../../styles/nodes.css';

// Trigger a browser download for a URL produced by the backend. We fetch the
// blob ourselves so the `download` attribute is honoured even across the
// localhost:5173 → localhost:8000 origin boundary (which is technically cross-
// origin and would otherwise open the asset inline).
async function downloadOutput(url: string, filename: string): Promise<void> {
  try {
    const absolute = url.startsWith('http') ? url : `http://localhost:8000${url}`;
    const res = await fetch(absolute);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (err) {
    console.error('Download failed:', err);
  }
}

function filenameFor(nodeLabel: string, nodeId: string, url: string, fallbackExt: string): string {
  const urlPath = url.split('?')[0];
  const urlExt = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1] ?? fallbackExt;
  const shortId = /^n\d+$/.test(nodeId) ? nodeId : nodeId.slice(0, 6);
  const slug = nodeLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'output';
  return `${slug}-${shortId}.${urlExt}`;
}

function ModelNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const selectNode = useUIStore((s) => s.selectNode);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const [videoLoop, setVideoLoop] = useState<boolean>(true);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      e.stopPropagation();
      updateNodeData(id, {
        params: { ...nodeData.params, value: e.target.value },
      });
    },
    [id, nodeData.params, updateNodeData]
  );

  const startImageDrag = useCallback(
    (url: string) => (e: React.DragEvent<HTMLImageElement>) => {
      const token = `@${id}`;
      e.dataTransfer.setData(
        'application/nebula-image-ref',
        JSON.stringify({ nodeId: id, url }),
      );
      e.dataTransfer.setData('application/nebula-node-ref', token);
      e.dataTransfer.setData('text/plain', token);
      e.dataTransfer.effectAllowed = 'copy';
    },
    [id],
  );

  // "Enhance" button on text-input: composes a chat message that asks Claude to
  // rewrite the prompt for whatever downstream node(s) this one feeds into, then
  // hands the message to the chat panel via a custom event. No direct chat
  // coupling from the node — keeps responsibilities clean.
  const handleEnhance = useCallback(() => {
    const { nodes, edges } = useGraphStore.getState();
    const prompt = String(nodeData.params?.value ?? '').trim();
    const isCliNode = /^n\d+$/.test(id);

    const targets = edges
      .filter((e) => e.source === id)
      .map((e) => {
        const target = nodes.find((n) => n.id === e.target);
        if (!target) return null;
        const td = target.data as unknown as NodeData;
        const def = NODE_DEFINITIONS[td.definitionId];
        const targetName = def?.displayName ?? td.definitionId;
        return /^n\d+$/.test(target.id) ? `@${target.id} (${targetName})` : targetName;
      })
      .filter((v): v is string => !!v);

    const nodeRef = isCliNode ? `@${id}` : `(text-input node, id ${id.slice(0, 8)})`;
    const targetsLine = targets.length
      ? `It feeds into: ${targets.join(', ')}.`
      : `It isn't connected to a downstream node yet — suggest a prompt that would work well for a generative image/video model.`;
    const applyLine = isCliNode
      ? `When you have a better prompt, apply it with: nebula set ${id} value="<your new prompt>"`
      : `When you have a better prompt, return it in a code block so I can paste it in.`;
    const currentLine = prompt
      ? `Current prompt: ${JSON.stringify(prompt)}`
      : `The prompt is currently empty — suggest one from scratch based on the downstream model.`;

    const message = `Enhance the prompt in ${nodeRef}. ${targetsLine} ${currentLine} Use your skills for the target model(s) to craft something stronger. ${applyLine}`;

    // Pass the source node id so ChatPanel can render an "Apply to this node"
    // button next to any code block in Claude's reply.
    window.dispatchEvent(new CustomEvent('nebula:chat-send', { detail: { message, sourceNodeId: id } }));
  }, [id, nodeData.params]);

  if (!definition) return <div className="model-node model-node--error">Unknown node type</div>;

  const categoryColor = CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;
  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const videoOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Video' && o.value);
  const meshOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Mesh' && o.value);
  const audioOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Audio' && o.value);

  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;
  const isTextInput = nodeData.definitionId === 'text-input';
  const isImageInput = nodeData.definitionId === 'image-input';
  const imageInputPreview = isImageInput && nodeData.params._previewUrl ? String(nodeData.params._previewUrl) : null;

  return (
    <div className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`} onClick={() => selectNode(id)}>
      <div className="model-node__header">
        <span className="model-node__category-dot" style={{ backgroundColor: categoryColor }} />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && <span className="model-node__badge model-node__badge--warning" title="API Key Missing">&#x26A0;</span>}
        <span
          className="model-node__id-chip nodrag"
          title="Drag into the chat panel to reference this node"
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            const token = /^n\d+$/.test(id) ? `@${id}` : `@${id.slice(0, 8)} (${nodeData.label})`;
            e.dataTransfer.setData('application/nebula-node-ref', token);
            e.dataTransfer.setData('text/plain', token);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/^n\d+$/.test(id) ? id : id.slice(0, 4)}
        </span>
      </div>

      {definition.inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {definition.inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle type="target" position={Position.Left} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
              <span className="model-node__port-label">
                {port.label}{port.multiple ? ' +' : ''}
              </span>
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
            spellCheck
          />
          <button
            type="button"
            className="model-node__enhance nodrag"
            onClick={(e) => {
              e.stopPropagation();
              handleEnhance();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title="Ask Claude to rewrite this prompt for the node it's connected to"
          >
            Enhance
          </button>
        </div>
      )}

      {imageInputPreview && (
        <div className="model-node__preview">
          <img
            src={imageInputPreview}
            alt="Image input"
            className="model-node__preview-image nodrag"
            loading="lazy"
            draggable
            onDragStart={startImageDrag(imageInputPreview)}
          />
        </div>
      )}

      {nodeData.state === 'executing' && (
        <div className="model-node__loading">
          <div className="model-node__loading-spinner" />
          <span className="model-node__loading-text">
            {nodeData.progress !== undefined ? `${Math.round(nodeData.progress * 100)}%` : 'Starting...'}
          </span>
          {nodeData.progress !== undefined && (
            <div className="model-node__progress">
              <div className="model-node__progress-bar" style={{ width: `${Math.round(nodeData.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {nodeData.state === 'complete' && imageOutput && typeof imageOutput.value === 'string' && !imageInputPreview && (
        <div className="model-node__preview">
          <img
            src={imageOutput.value as string}
            alt="Generated output"
            className="model-node__preview-image nodrag"
            loading="lazy"
            draggable
            onDragStart={startImageDrag(imageOutput.value as string)}
          />
          <button
            type="button"
            className="model-node__download nodrag"
            title="Download image"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              downloadOutput(imageOutput.value as string, filenameFor(nodeData.label, id, imageOutput.value as string, 'png'));
            }}
          >
            &#x2913;
          </button>
        </div>
      )}

      {displayText && !isTextInput && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {displayText.length > 300 ? `${displayText.slice(0, 300)}...` : displayText}
          </div>
        </div>
      )}

      {nodeData.state === 'complete' && videoOutput && typeof videoOutput.value === 'string' && (
        <div className="model-node__preview">
          <video
            src={videoOutput.value}
            controls
            loop={videoLoop}
            className="model-node__preview-video nodrag nowheel"
            style={{ width: '100%', borderRadius: 4, display: 'block' }}
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
            &#x21BB;
          </button>
          <button
            type="button"
            className="model-node__download nodrag"
            title="Download video"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              downloadOutput(videoOutput.value as string, filenameFor(nodeData.label, id, videoOutput.value as string, 'mp4'));
            }}
          >
            &#x2913;
          </button>
        </div>
      )}

      {nodeData.state === 'complete' && meshOutput && typeof meshOutput.value === 'string' && (
        <div className="model-node__preview">
          <MeshPreview src={meshOutput.value} />
          <button
            type="button"
            className="model-node__download nodrag"
            title="Download mesh"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              downloadOutput(meshOutput.value as string, filenameFor(nodeData.label, id, meshOutput.value as string, 'glb'));
            }}
          >
            &#x2913;
          </button>
        </div>
      )}

      {nodeData.state === 'complete' && audioOutput && typeof audioOutput.value === 'string' && (
        <div className="model-node__preview">
          <audio
            src={audioOutput.value}
            controls
            className="model-node__preview-audio nodrag nowheel"
            style={{ width: '100%', borderRadius: 4 }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="model-node__download nodrag"
            title="Download audio"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              downloadOutput(audioOutput.value as string, filenameFor(nodeData.label, id, audioOutput.value as string, 'mp3'));
            }}
          >
            &#x2913;
          </button>
        </div>
      )}

      {nodeData.state === 'complete' && !imageOutput && !textOutput && !videoOutput && !meshOutput && !audioOutput && Object.keys(nodeData.outputs).length > 0 && (
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
