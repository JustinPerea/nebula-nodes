import { memo, useCallback, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { Download, Repeat2, Sparkles, Plus, SlidersHorizontal } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { currentMediaSource } from '../../lib/canvasNextSteps';
import '../../styles/canvas-next-steps.css';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { findStructuredRepresentation } from '../../lib/representationViewerRegistry';
import { getReferenceRole } from '../../lib/referenceRoles';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import { usesKreaAccount } from '../../lib/kreaConnection';
import { routeSwitch } from '../../lib/directRoute';
import { nodeWiredCounts } from '../../lib/runScope';
import { useProviderNoteStore } from '../../store/providerNoteStore';
import { ProviderSwitcher } from './ProviderSwitcher';
import { missingKeyTitle } from '../../lib/nodeKeys';
import { useGraphStore } from '../../store/graphStore';
import { edgesInto, edgesOutOf } from '../../lib/graphIndex';
import { maskSourcePreview as wiredMaskSource, paperSourcesReady, portWired } from '../../lib/cardSelectors';
import { useCardSelection } from '../../hooks/useCardSelection';
import { useSlavaNodeEntranceClass } from '../../hooks/useSlavaNodeEntrance';
import { useBatchPreview } from '../../hooks/useBatchPreview';
import { BatchCarousel } from './BatchCarousel';
import { MeshPreview } from './DeferredViewers';
import { RepresentationViewer } from './RepresentationViewer';
import { NodeError } from './NodeError';
import { SkippedBadge } from './SkippedBadge';
import { VideoEditAction } from './VideoEditAction';
import { NodeTypeIcon } from './NodeTypeIcon';
import { useSelectionActionSlot } from '../../lib/selectionActionSlot';
import { BeforeAfterSlider } from './BeforeAfterSlider';
import { downloadWorldAsset } from '../../lib/worldDownload';
import '../../styles/nodes.css';
import { NodeLabel } from './NodeLabel';
import { NodeRunStatus } from './NodeRunStatus';
import { MoodboardAdapterRow } from './MoodboardAdapterRow';
import { OverviewImage, OverviewVideoStill } from './OverviewImage';
import { StructuredOutputs } from './StructuredValuePreview';
import { JevResultView, type JevResultInputs } from './JevResult';
import { JevCardField } from './JevCardField';
import { isJevNode, jevBrandStyle, parseJevOutputs, JEV_BOX, JEV_BRAND, JEV_DECIDE, JEV_PICK_BEST } from '../../lib/jev';
import { JEV_CARD_FIELDS, jevCardText, jevResultKey, upstreamPortValues } from '../../lib/jevView';

// Trigger a browser download for a URL produced by the backend. We fetch the
// blob ourselves so the `download` attribute is honoured even across localhost
// port boundaries, which would otherwise open the asset inline.
async function downloadOutput(url: string, filename: string): Promise<void> {
  try {
    await downloadWorldAsset(url, filename, {
      heading: "Couldn't download the output.",
      tooLargeMessage:
        'This output is too large for a safe in-browser download. Use the local Nebula output folder instead.',
    });
  } catch (err) {
    console.error('[nebula] output download', err);
    // The message is already "Couldn't download the output. <reason>".
    window.alert(err instanceof Error ? err.message : "Couldn't download the output.");
  }
}

function filenameFor(nodeLabel: string, nodeId: string, url: string, fallbackExt: string): string {
  const urlPath = url.split('?')[0];
  const urlExt = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1] ?? fallbackExt;
  const shortId = /^n\d+$/.test(nodeId) ? nodeId : nodeId.slice(0, 6);
  const slug = nodeLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'output';
  return `${slug}-${shortId}.${urlExt}`;
}

const NO_CANDIDATES: readonly string[] = Object.freeze([]);

/** Each output's label, for a card that shows several structured values. */
function portLabels(definition: { outputPorts: Array<{ id: string; label: string }>; displayOutputs?: Array<{ id: string; label: string }> }): Record<string, string> {
  return Object.fromEntries([...(definition.displayOutputs ?? []), ...definition.outputPorts].map((port) => [port.id, port.label]));
}

function ModelNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const batchPreview = useBatchPreview(id, nodeData);
  const actionSlot = useSelectionActionSlot(id);
  const previewOutputs = batchPreview.outputs;
  const previewComplete = nodeData.state === 'complete' || batchPreview.browsing;
  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  // This card subscribes only to what it draws: its own node comes in as
  // props (React Flow re-renders it when that node changes), and each value
  // it shows from elsewhere (selection, a wired source's image, its wires) is
  // its own selector returning a primitive. Subscribing to the whole `nodes`
  // or `edges` array re-rendered every card on every change anywhere: about
  // 1 s per Accept on a 100-node canvas (tests/canvasRenderScope.test.tsx).
  const selectNode = useUIStore((s) => s.selectNode);
  const { selectedInUi, inspectorOpen } = useCardSelection(id);
  const setInspectorVisible = useUIStore((s) => s.setInspectorVisible);
  const isSlavaSkin = useUIStore((s) => s.skin === 'slava-restraint');
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const entranceClass = useSlavaNodeEntranceClass();
  // A route-table node's provider chip (ProviderSwitcher): it counts the
  // edges into each port, as the preflight does. The selector returns a
  // string so other nodes' edges don't re-render this card.
  const switchable = routeSwitch(definition);
  const wiredKey = useGraphStore((s) => (switchable
    ? [...nodeWiredCounts(id, edgesInto(s.edges, id))].map(([port, count]) => `${port}=${count}`).join('&') : ''));
  const wiredCounts = useMemo(() => new Map(wiredKey ? wiredKey.split('&').map((part) => {
    const [port, count] = part.split('=');
    return [port, Number(count)] as const;
  }) : []), [wiredKey]);
  const providerNote = useProviderNoteStore((s) => s.notes[id]);
  const onProviderPick = useCallback((next: Record<string, unknown>, notes: string[]) => {
    updateNodeData(id, { params: next });
    useProviderNoteStore.getState().show(id, notes);
  }, [id, updateNodeData]);
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
      selectNode(id);
      setInspectorVisible(!inspectorOpen);
    },
    [id, inspectorOpen, selectNode, setInspectorVisible],
  );

  // Hooks must run unconditionally — keep them above the `!definition` early
  // return (React rules-of-hooks).
  // A retained mask result belongs to its own captured source. Live graph
  // inputs may already point at the last item, so show the produced artifact
  // while browsing instead of reconstructing a composite from those inputs.
  const drawsMaskSource = !batchPreview.browsing && nodeData.definitionId === 'mask-painter';
  const maskSourcePreview = useGraphStore((s) => (drawsMaskSource ? wiredMaskSource(s.nodes, s.edges, id) : null));

  // A Jev node with a readable result shows it as a verdict card in place of
  // the generic Text/Image previews. A malformed result parses to null and
  // falls back to those previews, so nothing is hidden.
  const jevResult = useMemo(
    () => (previewComplete && isJevNode(nodeData.definitionId)
      ? parseJevOutputs(nodeData.definitionId, previewOutputs) : null),
    [previewComplete, nodeData.definitionId, previewOutputs],
  );
  const jevKind = jevResult ? nodeData.definitionId : null;
  const jevCandidates = useGraphStore(useShallow((s) => (jevKind === JEV_PICK_BEST
    ? upstreamPortValues(id, 'candidates', s.nodes, s.edges) : NO_CANDIDATES)));
  const jevBoxImage = useGraphStore((s) => (jevKind === JEV_BOX
    ? upstreamPortValues(id, 'image', s.nodes, s.edges)[0] ?? null : null));
  const jevGated = useGraphStore((s) => jevKind === JEV_DECIDE && edgesOutOf(s.edges, id)
    .some((edge) => edge.sourceHandle === 'on_pass' || edge.sourceHandle === 'on_fail'));
  const jevInputs = useMemo<JevResultInputs | undefined>(() => {
    if (jevKind === JEV_PICK_BEST) return { candidates: [...jevCandidates] };
    if (jevKind === JEV_BOX) return { image: jevBoxImage };
    if (jevKind === JEV_DECIDE) return { gated: jevGated };
    return undefined;
  }, [jevKind, jevCandidates, jevBoxImage, jevGated]);
  // Jev cards carry their main setting (question / target) as an editable
  // field on the face; Box's target also has an input port, and wired text
  // wins over the typed value.
  const jevField = JEV_CARD_FIELDS[nodeData.definitionId] ?? null;
  const jevFieldPort = jevField ? definition?.inputPorts.find((port) => port.id === jevField.key) : undefined;
  const jevFieldPortId = jevFieldPort?.id ?? null;
  const jevFieldPortWired = useGraphStore((s) => jevFieldPortId !== null && portWired(s.edges, id, jevFieldPortId));
  // "Rerun with latest source" needs every Paper source it was made from to
  // have a current export.
  const paperInputs = nodeData.outputFreshness?.paperInputs;
  const latestPaperSourceReady = useGraphStore((s) => (paperInputs ? paperSourcesReady(s.nodes, paperInputs) : false));
  // Only buttons that are on screen read whether a run is going: Add next
  // step on a selected card with media, and Rerun with latest source. Other
  // cards don't re-render when a run starts or ends.
  // (An image, a mask drawn like one, or a video: the previews below.)
  const hasMediaPreview = Object.values(previewOutputs)
    .some((o) => (o.type === 'Image' || o.type === 'Mask' || o.type === 'Video') && Boolean(o.value));
  const showsRerun = Boolean(nodeData.outputFreshness?.runId && nodeData.outputFreshness.outOfDateReasons.length > 0);
  const drawsRunLock = ((selected || selectedInUi || actionSlot !== null) && hasMediaPreview) || showsRerun;
  const isExecuting = useGraphStore((s) => drawsRunLock && s.isExecuting);

  if (!definition) return <div className="model-node model-node--error">Unknown node type</div>;

  // Jev nodes wear TypeSafe's pink in place of their category colour, with or
  // without a result (styles/jev-result.css, .model-node--jev).
  const isJev = isJevNode(nodeData.definitionId);
  const categoryColor = isJev ? JEV_BRAND.accent : CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;
  // A mask is drawn like an image when there's no regular image, so a Preview
  // wired to Jev Box's mask shows it instead of an empty card.
  const imageOutput = Object.values(previewOutputs).find((o) => o.type === 'Image' && o.value)
    ?? Object.values(previewOutputs).find((o) => o.type === 'Mask' && o.value);
  const textOutput = Object.values(previewOutputs).find((o) => o.type === 'Text' && o.value);
  const videoOutput = Object.values(previewOutputs).find((o) => o.type === 'Video' && o.value);
  const meshOutput = Object.values(previewOutputs).find((o) => o.type === 'Mesh' && o.value);
  const worldOutput = Object.values(previewOutputs).find((o) => o.type === 'World' && o.value);
  const audioOutput = Object.values(previewOutputs).find((o) => o.type === 'Audio' && o.value);
  const svgOutput = Object.values(previewOutputs).find((o) => o.type === 'SVG' && o.value);
  const spatialOutput = findStructuredRepresentation(previewOutputs, { includeWorld: false });

  const outputText = textOutput && typeof textOutput.value === 'string' ? textOutput.value : null;
  const displayText = batchPreview.browsing ? outputText : nodeData.streamingText ?? outputText;
  const previewText = displayText ? displayText.replace(/\\n/g, '\n') : null;
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;
  const isImageInput = nodeData.definitionId === 'image-input';
  const isMaskPainter = nodeData.definitionId === 'mask-painter';
  const imageInputPreview = isImageInput && nodeData.params._previewUrl ? String(nodeData.params._previewUrl) : null;
  const maskOverlayData = isMaskPainter && typeof nodeData.params._maskData === 'string'
    ? nodeData.params._maskData
    : null;
  const showMaskComposite = Boolean(isMaskPainter && maskSourcePreview && maskOverlayData);
  const finalImageOutput = previewComplete && imageOutput && typeof imageOutput.value === 'string'
    ? imageOutput.value
    : null;
  // Quiver Arrow progressive preview: stream.draft fires StreamPartialSvgEvent
  // with raw SVG markup; we render it as an inline-SVG data URI while executing,
  // then the final outputs.svg.value (served via /api/outputs/...) takes over.
  const streamingSvgPreview = nodeData.streamingSvg && nodeData.state === 'executing'
    ? `data:image/svg+xml;utf8,${encodeURIComponent(nodeData.streamingSvg.svg)}`
    : null;
  const finalSvgOutput = previewComplete && svgOutput && typeof svgOutput.value === 'string'
    ? svgOutput.value
    : null;
  // Image Compare node: render a before/after wipe of its two image inputs
  // (passed through as outputs imageA/imageB) rather than just the first image.
  const isImageCompare = nodeData.definitionId === 'image-compare';
  const compareBefore =
    isImageCompare && previewComplete && typeof previewOutputs.imageA?.value === 'string'
      ? previewOutputs.imageA.value
      : null;
  const compareAfter =
    isImageCompare && previewComplete && typeof previewOutputs.imageB?.value === 'string'
      ? previewOutputs.imageB.value
      : null;
  const showCompare = Boolean(compareBefore && compareAfter);

  const showJevResult = Boolean(jevResult);
  const isImageSurface = !showJevResult && !worldOutput && Boolean(
    imageInputPreview
    || finalImageOutput
    || streamingSvgPreview
    || finalSvgOutput
    || showCompare
    || (isMaskPainter && maskSourcePreview),
  );
  const shouldRenderSpatial = previewComplete
    && !worldOutput
    && Boolean(spatialOutput)
    && !isImageSurface
    && !videoOutput
    && !meshOutput
    && !audioOutput;
  const isTextSurface = !showJevResult
    && !worldOutput
    && !shouldRenderSpatial
    && (isInlineTextNode || Boolean(displayText && !isInlineTextNode));
  // Whether any renderer above drew this run's output. When none did (a
  // Moodboard bundle, an Array, a Character, an object typed Any, a Text port
  // holding a non-string...), the run's values are drawn as structured
  // values instead of a bare "Output ready".
  const drewOutput = showJevResult
    || isImageSurface
    || isInlineTextNode
    || Boolean(displayText)
    || Boolean(worldOutput)
    || shouldRenderSpatial
    || (videoOutput !== undefined && typeof videoOutput.value === 'string')
    || (meshOutput !== undefined && typeof meshOutput.value === 'string')
    || (audioOutput !== undefined && typeof audioOutput.value === 'string');
  const structuredOutputs = previewComplete && !drewOutput ? Object.entries(previewOutputs) : [];
  const isStructuredSurface = structuredOutputs.length > 0;
  const isWorldSurface = previewComplete && Boolean(worldOutput);
  const imageClassName = isSlavaSkin ? 'model-node__preview-image' : 'model-node__preview-image nodrag';
  const downloadableOutput =
    finalImageOutput
      ? { url: finalImageOutput, fallbackExt: 'png', title: 'Download image' }
      : finalSvgOutput
        ? { url: finalSvgOutput, fallbackExt: 'svg', title: 'Download SVG' }
        : previewComplete && videoOutput && typeof videoOutput.value === 'string'
          ? { url: videoOutput.value, fallbackExt: 'mp4', title: 'Download video' }
          : previewComplete && meshOutput && typeof meshOutput.value === 'string'
            ? { url: meshOutput.value, fallbackExt: 'glb', title: 'Download mesh' }
            : previewComplete && audioOutput && typeof audioOutput.value === 'string'
              ? { url: audioOutput.value, fallbackExt: 'mp3', title: 'Download audio' }
              : null;
  const inlineTextParam = inlineTextParamKey
    ? definition.params.find((param) => param.key === inlineTextParamKey)
    : null;
  const inlineTextValue = inlineTextParamKey ? String(nodeData.params[inlineTextParamKey] ?? '') : '';
  const inlineTextPlaceholder = inlineTextParam?.placeholder ?? 'Enter text...';
  const isNodeSelected = selected || selectedInUi;
  const nextStepSource = currentMediaSource(definition, nodeData, previewOutputs);
  // The Jev result below hides its echo of the field's text.
  const jevFieldText = jevField
    ? jevCardText(nodeData.params, jevField.key, definition.params.find((p) => p.key === jevField.key)?.default)
    : null;

  const nextStepTitle = !/^n\d+$/.test(id) ? 'Wait for this result to sync with the backend'
    : nextStepSource ? 'Prepare a connected next step using this result' : 'Show the current completed result to add a next step';
  const renderNodeActions = (variant: 'pill' | 'toolbar') => {
    const inToolbar = variant === 'toolbar';
    return (
      <>
        <VideoEditAction id={id} data={nodeData} displayedOutputs={previewOutputs}
          className={inToolbar ? 'selection-toolbar__button' : 'model-node__next-step'} />
        {hasMediaPreview && <button type="button"
          className={inToolbar ? 'selection-toolbar__button nodrag' : 'model-node__next-step nodrag'}
          data-next-step-anchor={id}
          disabled={!nextStepSource || isExecuting || !/^n\d+$/.test(id)}
          title={nextStepTitle}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (!nextStepSource) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            useUIStore.getState().showConnectionPopup({
              position: { x: bounds.left, y: bounds.bottom + 8 },
              nodeId: id, handleId: nextStepSource.handleId, handleType: 'source',
              nextStep: { sourceValue: nextStepSource.value, sourceLabel: nodeData.label, sourceDefinitionId: nodeData.definitionId },
            });
          }}><Plus size={inToolbar ? 17 : 12} aria-hidden="true" /><span>{inToolbar ? 'Next step' : 'Add next step'}</span></button>}
        <button
          type="button"
          className={inToolbar ? 'selection-toolbar__button nodrag' : 'model-node__settings-edit nodrag'}
          aria-haspopup="dialog"
          aria-expanded={inspectorOpen}
          aria-label="Show node settings"
          onClick={handleInspectorButtonClick}
          onMouseDown={(e) => e.stopPropagation()}
          title="Show node settings"
        >
          {inToolbar
            ? <><SlidersHorizontal size={17} aria-hidden="true" /><span className="selection-toolbar__label--compact">Settings</span></>
            : '…'}
        </button>
      </>
    );
  };

  return (
    <div
      className={`model-node ${stateClass}${isImageSurface ? ' model-node--image-surface' : ''}${isWorldSurface ? ' model-node--world-surface' : ''}${shouldRenderSpatial ? ' model-node--spatial-surface' : ''}${isTextSurface ? ' model-node--text-surface' : ''}${isStructuredSurface ? ' model-node--structured-surface' : ''}${isInlineTextNode ? ' model-node--inline-text' : ''}${isTextInput ? ' model-node--text-input' : ''}${isImageInput ? ' model-node--image-input' : ''}${isStickyNote ? ' model-node--sticky-note' : ''}${isJev ? ' model-node--jev' : ''}${showJevResult ? ' model-node--jev-surface' : ''} ${switchable ? ' model-node--switchable' : ''} ${isNodeSelected ? 'model-node--selected' : ''}${entranceClass}`}
      onClick={() => selectNode(id)}
      style={isJev ? jevBrandStyle() : { ['--node-category-color' as string]: categoryColor }}
    >
      {/* Settings bar — floats above the card when selected; renders model
       * name + an "Edit" affordance that opens the node panel settings. When
       * this is the only selected node, the same actions move into the
       * selection toolbar instead, so there is one bar, not two. */}
      {isNodeSelected && !actionSlot && (
        <div className="model-node__settings-bar">
          <span className="model-node__settings-model">{definition.displayName}</span>
          {renderNodeActions('pill')}
        </div>
      )}
      {actionSlot && createPortal(renderNodeActions('toolbar'), actionSlot)}

      {/* Card — the visible content surface. Default + Hermes skins style
       * .model-node directly (this wrapper inherits transparency); Slava
       * Restraint skin moves the dark-glass surface here so the type label
       * and settings bar can float above the card cleanly. */}
      <div className="model-node__card" data-node-inspector-anchor={id}>
      <div className="model-node__header">
        {isSlavaSkin
          ? <NodeTypeIcon definition={definition} />
          : <span className="model-node__category-dot" style={{ backgroundColor: categoryColor }} />}
        <NodeLabel nodeId={id} label={nodeData.label} displayName={definition.displayName} />
        {batchPreview.label && <span className="batch-carousel__active-label" title={batchPreview.lineage}>[{batchPreview.label}]</span>}
        {nodeData.keyStatus === 'missing' && !switchable && <span className="model-node__badge model-node__badge--warning"
          title={usesKreaAccount(definition, nodeData.params) ? 'Krea sign-in required' : missingKeyTitle(definition, nodeData.params)}>&#x26A0;</span>}
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
        {/* One indicator on these nodes: the chip replaces the missing-key badge. */}
        {switchable && (
          <ProviderSwitcher definition={definition} params={nodeData.params} variant="chip"
            wired={wiredCounts} onPick={onProviderPick} />
        )}
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

      {switchable && providerNote && (
        <div className="model-node__provider-note nodrag nopan" role="status">
          <span className="model-node__provider-note-text">{providerNote}</span>
          <button type="button" className="model-node__provider-note-dismiss" aria-label="Dismiss provider note"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); useProviderNoteStore.getState().dismiss(id); }}>
            &times;
          </button>
        </div>
      )}

      {nodeData.outputFreshness && nodeData.outputFreshness.outOfDateReasons.length > 0 && (
        <div className="model-node__source-stale nodrag nopan" role="status">
          <strong>Out of date — source updated</strong>
          {nodeData.outputFreshness.outOfDateReasons.map((reason) => <span key={reason}>{reason}</span>)}
          {nodeData.outputFreshness.runId && <button type="button" disabled={isExecuting || !latestPaperSourceReady}
            title={latestPaperSourceReady ? 'Reuse the saved recipe with the latest exported artwork' : 'Refresh or reconnect the Paper source first'}
            onClick={(event) => {
            event.stopPropagation();
            const runId = nodeData.outputFreshness?.runId;
            if (runId) void useGraphStore.getState().rerunHistoryWithLatestPaperSource(runId);
          }}>Rerun with latest source</button>}
        </div>
      )}

      {definition.inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input" style={{ ['--port-count' as string]: definition.inputPorts.length }}>
          {definition.inputPorts.map((port, portIndex) => {
            // Semantic reference role badge (see referenceRoles.ts). Role is
            // advisory metadata — ports without a role render exactly as
            // before: no badge, no extra DOM.
            const roleDef = port.role ? getReferenceRole(port.role) : undefined;
            return (
              <div key={port.id} className="model-node__port-row" style={{ ['--port-index' as string]: portIndex }}>
                <Handle type="target" position={Position.Left} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
                <span className="model-node__port-label">
                  {port.label}{port.multiple ? ' +' : ''}
                </span>
                {roleDef && (
                  <span
                    className="model-node__role-badge"
                    style={{ backgroundColor: roleDef.color }}
                    aria-label={`Reference role: ${roleDef.label}`}
                    title={`${roleDef.label} reference — ${roleDef.description}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <MoodboardAdapterRow data={nodeData} definition={definition} nodeId={id} />

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
        <div className="model-node__preview model-node__preview--overview">
          <OverviewImage
            src={imageInputPreview}
            alt="Image input"
            className={imageClassName}
            loading="lazy"
            draggable={!isSlavaSkin}
            onDragStart={isSlavaSkin ? undefined : startImageDrag(imageInputPreview)}
          />
        </div>
      )}

      {showMaskComposite && maskSourcePreview && maskOverlayData && (
        <div className="model-node__preview model-node__mask-composite model-node__preview--overview">
          <OverviewImage
            src={maskSourcePreview}
            alt="Mask source"
            className={imageClassName}
            loading="lazy"
            draggable={false}
          />
          <img
            src={maskOverlayData}
            alt="Painted mask overlay"
            className="model-node__mask-overlay nodrag"
            draggable={false}
          />
        </div>
      )}

      {isMaskPainter && maskSourcePreview && !maskOverlayData && (
        <div className="model-node__preview model-node__preview--overview">
          <OverviewImage
            src={maskSourcePreview}
            alt="Mask source preview"
            className={imageClassName}
            loading="lazy"
            draggable={false}
          />
        </div>
      )}

      {jevField && (
        <JevCardField
          nodeId={id}
          definition={definition}
          field={jevField}
          params={nodeData.params}
          portWired={jevFieldPortWired}
          portLabel={jevFieldPort?.label}
        />
      )}

      <NodeRunStatus data={nodeData} definition={definition} nodeId={id} />

      {jevResult && (
        <JevResultView
          key={jevResultKey(previewOutputs)}
          result={jevResult}
          params={nodeData.params}
          inputs={jevInputs}
          fieldText={jevFieldText}
        />
      )}

      {showCompare && compareBefore && compareAfter && (
        <div className="model-node__preview">
          <BeforeAfterSlider
            beforeSrc={compareBefore}
            afterSrc={compareAfter}
            beforeAlt="Image A"
            afterAlt="Image B"
          />
        </div>
      )}

      {previewComplete && worldOutput && (
        <div className="model-node__preview model-node__preview--world">
          <RepresentationViewer type={worldOutput.type} value={worldOutput.value} />
        </div>
      )}

      {shouldRenderSpatial && spatialOutput && (
        <div className="model-node__preview model-node__preview--spatial">
          <RepresentationViewer type={spatialOutput.type} value={spatialOutput.value} />
        </div>
      )}

      {finalImageOutput && !showJevResult && !worldOutput && !imageInputPreview && !isImageCompare && !(isMaskPainter && maskSourcePreview) && (
        <div className="model-node__preview model-node__preview--overview">
          <OverviewImage
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
        <div className="model-node__preview model-node__preview--overview">
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

      {previewText && !showJevResult && !worldOutput && !shouldRenderSpatial && !isInlineTextNode && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {previewText.length > 300 ? `${previewText.slice(0, 300)}...` : previewText}
          </div>
        </div>
      )}

      {previewComplete && videoOutput && typeof videoOutput.value === 'string' && (
        <div className="model-node__preview model-node__preview--overview">
          <video
            src={videoOutput.value}
            controls
            loop={videoLoop}
            className="model-node__preview-video nodrag nowheel"
            onMouseDown={(e) => e.stopPropagation()}
          />
          <OverviewVideoStill src={videoOutput.value} />
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

      {previewComplete && !worldOutput && meshOutput && typeof meshOutput.value === 'string' && (
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

      {previewComplete && audioOutput && typeof audioOutput.value === 'string' && (
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

      {isStructuredSurface && (
        <div className="model-node__preview model-node__preview--structured model-node__preview--overview">
          <StructuredOutputs outputs={structuredOutputs} labels={portLabels(definition)}
            definitionId={nodeData.definitionId} />
        </div>
      )}

      {nodeData.state === 'error' && nodeData.error && (
        <NodeError
          category={nodeData.errorCategory}
          friendly={nodeData.errorFriendly}
          person={nodeData.errorPerson}
          providerText={nodeData.errorProviderText}
          raw={nodeData.error}
        />
      )}

      {nodeData.state === 'skipped' && <SkippedBadge reason={nodeData.skipReason} />}

      <BatchCarousel preview={batchPreview} />

      {definition.outputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--output" style={{ ['--port-count' as string]: definition.outputPorts.length }}>
          {definition.outputPorts.map((port, portIndex) => (
            <div key={port.id} className="model-node__port-row model-node__port-row--output" style={{ ['--port-index' as string]: portIndex }}>
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
