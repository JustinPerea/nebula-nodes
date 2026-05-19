import { memo, useCallback, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Download, Repeat2, Sparkles } from 'lucide-react';
import type { NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useSlavaNodeEntranceClass } from '../../hooks/useSlavaNodeEntrance';
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
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const inspectorVisible = useUIStore((s) => s.panels.inspector.visible);
  const setInspectorVisible = useUIStore((s) => s.setInspectorVisible);
  const isSlavaSkin = useUIStore((s) => s.skin === 'slava-restraint');
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const entranceClass = useSlavaNodeEntranceClass();
  const [videoLoop, setVideoLoop] = useState<boolean>(true);
  const isTextInput = nodeData.definitionId === 'text-input';
  const isStickyNote = nodeData.definitionId === 'sticky-note';
  let inlineTextParamKey: 'value' | 'content' | null = null;
  if (isTextInput) {
    inlineTextParamKey = 'value';
  } else if (isSlavaSkin && isStickyNote) {
    inlineTextParamKey = 'content';
  }
  const isInlineTextNode = inlineTextParamKey !== null;

  const handleInlineTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (!inlineTextParamKey) return;
      e.stopPropagation();
      updateNodeData(id, {
        params: { ...nodeData.params, [inlineTextParamKey]: e.target.value },
      });
    },
    [id, inlineTextParamKey, nodeData.params, updateNodeData]
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

  const handleInspectorButtonClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      const shouldOpen = selectedNodeId !== id || !inspectorVisible;
      selectNode(id);
      setInspectorVisible(shouldOpen);
    },
    [id, inspectorVisible, selectNode, selectedNodeId, setInspectorVisible],
  );

  if (!definition) return <div className="model-node model-node--error">Unknown node type</div>;

  const categoryColor = CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;
  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const videoOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Video' && o.value);
  const meshOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Mesh' && o.value);
  const audioOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Audio' && o.value);
  const svgOutput = Object.values(nodeData.outputs).find((o) => o.type === 'SVG' && o.value);

  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const previewText = displayText ? displayText.replace(/\\n/g, '\n') : null;
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;
  const isTextSurface = isInlineTextNode || Boolean(displayText && !isInlineTextNode);
  const isImageInput = nodeData.definitionId === 'image-input';
  const imageInputPreview = isImageInput && nodeData.params._previewUrl ? String(nodeData.params._previewUrl) : null;
  const finalImageOutput = nodeData.state === 'complete' && imageOutput && typeof imageOutput.value === 'string'
    ? imageOutput.value
    : null;
  // Quiver Arrow progressive preview: stream.draft fires StreamPartialSvgEvent
  // with raw SVG markup; we render it as an inline-SVG data URI while executing,
  // then the final outputs.svg.value (served via /api/outputs/...) takes over.
  const streamingSvgPreview = nodeData.streamingSvg && nodeData.state === 'executing'
    ? `data:image/svg+xml;utf8,${encodeURIComponent(nodeData.streamingSvg.svg)}`
    : null;
  const finalSvgOutput = nodeData.state === 'complete' && svgOutput && typeof svgOutput.value === 'string'
    ? svgOutput.value
    : null;
  const isImageSurface = Boolean(imageInputPreview || finalImageOutput || streamingSvgPreview || finalSvgOutput);
  const imageClassName = isSlavaSkin ? 'model-node__preview-image' : 'model-node__preview-image nodrag';
  const downloadableOutput =
    finalImageOutput
      ? { url: finalImageOutput, fallbackExt: 'png', title: 'Download image' }
      : finalSvgOutput
        ? { url: finalSvgOutput, fallbackExt: 'svg', title: 'Download SVG' }
        : nodeData.state === 'complete' && videoOutput && typeof videoOutput.value === 'string'
          ? { url: videoOutput.value, fallbackExt: 'mp4', title: 'Download video' }
          : nodeData.state === 'complete' && meshOutput && typeof meshOutput.value === 'string'
            ? { url: meshOutput.value, fallbackExt: 'glb', title: 'Download mesh' }
            : nodeData.state === 'complete' && audioOutput && typeof audioOutput.value === 'string'
              ? { url: audioOutput.value, fallbackExt: 'mp3', title: 'Download audio' }
              : null;
  const inlineTextParam = inlineTextParamKey
    ? definition.params.find((param) => param.key === inlineTextParamKey)
    : null;
  const inlineTextValue = inlineTextParamKey ? String(nodeData.params[inlineTextParamKey] ?? '') : '';
  const inlineTextPlaceholder = inlineTextParam?.placeholder ?? 'Enter text...';
  const isNodeSelected = selected || selectedNodeId === id;

  return (
    <div
      className={`model-node ${stateClass}${isImageSurface ? ' model-node--image-surface' : ''}${isTextSurface ? ' model-node--text-surface' : ''}${isInlineTextNode ? ' model-node--inline-text' : ''}${isTextInput ? ' model-node--text-input' : ''}${isImageInput ? ' model-node--image-input' : ''}${isStickyNote ? ' model-node--sticky-note' : ''} ${isNodeSelected ? 'model-node--selected' : ''}${entranceClass}`}
      onClick={() => selectNode(id)}
      style={{ ['--node-category-color' as string]: categoryColor }}
    >
      {/* Type label — floats above the card; small and quiet (Slava Restraint
       * style). Default + Hermes skins hide it via display:none in their CSS. */}
      <div className="model-node__type-label">{definition.category}</div>

      {/* Settings bar — floats above the card when selected; renders model
       * name + an "Edit" affordance that opens the node panel settings. */}
      {isNodeSelected && (
        <div className="model-node__settings-bar">
          <span className="model-node__settings-model">{definition.displayName}</span>
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

      {/* Card — the visible content surface. Default + Hermes skins style
       * .model-node directly (this wrapper inherits transparency); Slava
       * Restraint skin moves the dark-glass surface here so the type label
       * and settings bar can float above the card cleanly. */}
      <div className="model-node__card">
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
        {isSlavaSkin && downloadableOutput && (
          <button
            type="button"
            className="model-node__header-action model-node__header-action--download nodrag"
            title={downloadableOutput.title}
            aria-label={downloadableOutput.title}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              downloadOutput(
                downloadableOutput.url,
                filenameFor(nodeData.label, id, downloadableOutput.url, downloadableOutput.fallbackExt),
              );
            }}
          >
            <Download
              className="model-node__download-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        )}
        {isSlavaSkin && isTextInput && (
          <button
            type="button"
            className="model-node__header-action model-node__header-action--enhance nodrag"
            title="Enhance prompt"
            aria-label="Enhance prompt"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleEnhance();
            }}
          >
            <Sparkles
              className="model-node__enhance-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        )}
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

      {/* Inline textarea for text-input and Slava sticky-note nodes */}
      {isInlineTextNode && (
        <div className="model-node__inline-textarea">
          <textarea
            className="model-node__textarea nodrag nowheel"
            value={inlineTextValue}
            onChange={handleInlineTextChange}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={inlineTextPlaceholder}
            rows={4}
            spellCheck
          />
          {isTextInput && (
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
          )}
        </div>
      )}

      {imageInputPreview && (
        <div className="model-node__preview">
          <img
            src={imageInputPreview}
            alt="Image input"
            className={imageClassName}
            loading="lazy"
            draggable={!isSlavaSkin}
            onDragStart={isSlavaSkin ? undefined : startImageDrag(imageInputPreview)}
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

      {finalImageOutput && !imageInputPreview && (
        <div className="model-node__preview">
          <img
            src={finalImageOutput}
            alt="Generated output"
            className={imageClassName}
            loading="lazy"
            draggable={!isSlavaSkin}
            onDragStart={isSlavaSkin ? undefined : startImageDrag(finalImageOutput)}
          />
          <button
            type="button"
            className="model-node__download nodrag"
            title="Download image"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              downloadOutput(finalImageOutput, filenameFor(nodeData.label, id, finalImageOutput, 'png'));
            }}
          >
            <Download
              className="model-node__download-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        </div>
      )}

      {streamingSvgPreview && (
        <div className="model-node__preview">
          <img
            src={streamingSvgPreview}
            alt="Streaming SVG preview"
            className={`${imageClassName} model-node__preview-image--streaming`}
            loading="lazy"
            draggable={false}
          />
        </div>
      )}

      {finalSvgOutput && !streamingSvgPreview && (
        <div className="model-node__preview">
          <img
            src={finalSvgOutput}
            alt="Generated SVG"
            className={imageClassName}
            loading="lazy"
            draggable={!isSlavaSkin}
            onDragStart={isSlavaSkin ? undefined : startImageDrag(finalSvgOutput)}
          />
          <button
            type="button"
            className="model-node__download nodrag"
            title="Download SVG"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              downloadOutput(finalSvgOutput, filenameFor(nodeData.label, id, finalSvgOutput, 'svg'));
            }}
          >
            <Download
              className="model-node__download-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        </div>
      )}

      {previewText && !isInlineTextNode && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {previewText.length > 300 ? `${previewText.slice(0, 300)}...` : previewText}
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
            <Download
              className="model-node__download-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
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
            <Download
              className="model-node__download-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        </div>
      )}

      {nodeData.state === 'complete' && audioOutput && typeof audioOutput.value === 'string' && (
        <div className="model-node__preview">
          <audio
            src={audioOutput.value}
            controls
            className="model-node__preview-audio nodrag nowheel"
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
            <Download
              className="model-node__download-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        </div>
      )}

      {nodeData.state === 'complete' && !imageOutput && !textOutput && !videoOutput && !meshOutput && !audioOutput && !svgOutput && Object.keys(nodeData.outputs).length > 0 && (
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
    </div>
  );
}

export const ModelNode = memo(ModelNodeComponent);
