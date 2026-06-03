import { useState, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from '../../lib/createParams';
import { uploadReference } from '../../lib/createUploads';
import { revealInFinder, saveToFolder } from '../../lib/createFiles';
import { type GenerationRecord, galleryItemsFromCanvas } from '../../lib/createGallery';
import { composerStateFromSelection } from '../../lib/createSelection';
import { applyPresetToComposer } from '../../lib/applyPreset';
import { createPreset, type Preset } from '../../lib/createPresets';
import { CreateComposer } from './CreateComposer';
import { PresetLibrary } from './PresetLibrary';
import { ResultsGallery } from './ResultsGallery';
import { ReferenceTray } from './ReferenceTray';
import type { AttachedRef } from './ReferenceTray';
import '../../styles/create-studio.css';
import '../../styles/create-gallery.css';

export function CreateView() {
  const exitCreateView = useUIStore((s) => s.exitCreateView);
  const sessionId = useUIStore((s) => s.createSessionId);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const allNodes = useGraphStore((s) => s.nodes);

  // Snapshot selection once on mount — used to prefill composer + default tab.
  // Empty deps array is intentional: we only want the canvas state at open time.
  const initial = useMemo(
    () =>
      composerStateFromSelection(
        useGraphStore.getState().nodes,
        useGraphStore.getState().edges,
      ),
    [],
  );

  const selectedIds = useMemo(() => new Set(initial.selectedIds), [initial]);

  const [modelId, setModelId] = useState<string | null>(
    () => initial.prefill?.modelId ?? 'nano-banana',
  );
  const [prompt, setPrompt] = useState(() => initial.prefill?.prompt ?? '');
  const [params, setParams] = useState<Record<string, unknown>>(() => {
    if (initial.prefill) return initial.prefill.params;
    return buildDefaultParamsForUi(NODE_DEFINITIONS['nano-banana']);
  });
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [refs, setRefs] = useState<AttachedRef[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [presetReloadKey, setPresetReloadKey] = useState(0);

  const modelDef = modelId ? NODE_DEFINITIONS[modelId] ?? null : null;

  const handleSelectModel = (id: string) => {
    setModelId(id);
    setParams(buildDefaultParamsForUi(NODE_DEFINITIONS[id]));
  };

  const handleApplyPreset = (preset: Preset) => {
    const next = applyPresetToComposer(preset, { modelId, prompt, params });
    if (next.modelId && next.modelId !== modelId) setModelId(next.modelId);
    setPrompt(next.prompt);
    setParams(next.params);
    if (preset.refImages.length > 0) {
      setRefs((prev) => {
        const add = preset.refImages
          .filter((fp) => !prev.some((r) => r.filePath === fp))
          .map((fp) => ({ filePath: fp, previewUrl: fp }));
        return [...prev, ...add];
      });
    }
  };

  const handleSaveCurrentStyle = async () => {
    if (!modelDef) return;
    const name = window.prompt('Name this style:', prompt.slice(0, 40) || modelDef.displayName);
    if (!name) return;
    try {
      await createPreset({ name, category: 'My Styles', prompt, params, modelId: modelDef.id, refImages: refs.map((r) => r.filePath), scope: 'project' });
      setPresetReloadKey((k) => k + 1);
    } catch (err) { console.error('save style failed', err); }
  };

  const handleAttach = async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const up = await uploadReference(file);
        setRefs((prev) => prev.some((r) => r.filePath === up.filePath) ? prev : [...prev, up]);
      } catch (err) { console.error('reference upload failed', err); }
    }
  };

  const handleGenerate = async () => {
    if (!modelDef || !sessionId || isExecuting) return;
    const { authorGenerationCluster, executeCluster } = useGraphStore.getState();
    const genId = uuidv4();
    const { modelNodeIds, allNodeIds } = await authorGenerationCluster({
      definitionId: modelDef.id,
      prompt,
      params,
      refPaths: refs.map((r) => r.filePath),
      quantity,
      sessionId,
      genId,
      layoutOrigin: { x: 80, y: 80 + generations.length * 320 },
    });
    if (modelNodeIds.length > 0) {
      setGenerations((prev) => [...prev, { genId, prompt, ts: Date.now(), modelNodeIds }]);
    }
    await executeCluster(allNodeIds);
  };

  const handleOpenInCanvas = (nodeId: string) => {
    exitCreateView();
    useUIStore.getState().selectNode(nodeId);
  };

  const handleUseAsInput = (url: string) => {
    // Store a backend-relative /api/outputs/... path as the ref filePath: the backend
    // resolves relative refs on both the execution and persistence paths, but an
    // absolute http://host/... URL (non-same-origin backend) reaches external providers
    // unresolved. Keep the absolute URL for the preview thumbnail.
    let filePath = url;
    if (/^https?:\/\//i.test(url)) {
      try {
        filePath = new URL(url).pathname;
      } catch {
        filePath = url;
      }
    }
    setRefs((prev) =>
      prev.some((r) => r.filePath === filePath) ? prev : [...prev, { filePath, previewUrl: url }],
    );
  };

  const handleDelete = (nodeId: string) => {
    useGraphStore.getState().deleteGeneration([nodeId]);
    setGenerations((prev) =>
      prev
        .map((g) => ({ ...g, modelNodeIds: g.modelNodeIds.filter((id) => id !== nodeId) }))
        .filter((g) => g.modelNodeIds.length > 0),
    );
  };

  const handleReveal = (url: string) => {
    void revealInFinder(url);
  };

  const handleSaveToFolder = async (url: string) => {
    try {
      await saveToFolder(url);
    } catch (e) {
      console.error('save failed', e);
    }
  };

  return (
    <div className="create-view">
      <header className="create-view__topbar">
        <button type="button" className="create-view__back" onClick={exitCreateView}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /> Canvas
        </button>
        <span className="create-view__title">Create</span>
      </header>

      <div
        className="create-view__stage"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) void handleAttach(e.dataTransfer.files); }}
      >
        {(() => {
          const hasSessionResults = generations.length > 0;
          const hasCanvasResults = galleryItemsFromCanvas(allNodes).length > 0;
          if (!hasSessionResults && !hasCanvasResults) {
            return (
              <div className="create-view__hero">
                <div className="create-view__hero-title">Start creating</div>
                <div className="create-view__hero-sub">Describe an idea, pick a model, and generate. Your nodes build on the canvas as you go.</div>
              </div>
            );
          }
          const defaultTab: 'session' | 'canvas' =
            selectedIds.size > 0 || (!hasSessionResults && hasCanvasResults)
              ? 'canvas'
              : 'session';
          return (
            <ResultsGallery
              records={generations}
              nodes={allNodes}
              selectedIds={selectedIds}
              defaultTab={defaultTab}
              onOpenInCanvas={handleOpenInCanvas}
              onUseAsInput={handleUseAsInput}
              onDelete={handleDelete}
              onReveal={handleReveal}
              onSaveToFolder={handleSaveToFolder}
            />
          );
        })()}
      </div>

      <ReferenceTray refs={refs} onRemove={(fp) => setRefs((p) => p.filter((r) => r.filePath !== fp))} />
      {stylesOpen && (
        <PresetLibrary
          onApply={handleApplyPreset}
          onSaveCurrent={handleSaveCurrentStyle}
          onClose={() => setStylesOpen(false)}
          reloadKey={presetReloadKey}
        />
      )}
      <CreateComposer
        modelDef={modelDef}
        prompt={prompt}
        params={params}
        isExecuting={isExecuting}
        quantity={quantity}
        onPromptChange={setPrompt}
        onSelectModel={handleSelectModel}
        onParamsChange={setParams}
        onGenerate={handleGenerate}
        onAttach={handleAttach}
        onQuantityChange={setQuantity}
        onOpenStyles={() => setStylesOpen(true)}
      />
    </div>
  );
}
