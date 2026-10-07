import { useState, useMemo, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from '../../lib/createParams';
import { isCreateModel } from '../../lib/createModels';
import { normalizeKreaMode } from '../../lib/kreaConnection';
import { uploadReference } from '../../lib/createUploads';
import { revealInFinder, saveToFolder } from '../../lib/createFiles';
import { generationRecordsFromHistory, galleryItemsFromCanvas } from '../../lib/createGallery';
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

const MAX_CONCURRENT = 2;

export function CreateView() {
  const exitCreateView = useUIStore((s) => s.exitCreateView);
  const sessionId = useUIStore((s) => s.createSessionId);
  const apiKeys = useUIStore((s) => s.settingsCache.apiKeys);
  const kreaConnectionMode = useUIStore((s) => s.settingsCache.kreaConnectionMode);
  const allNodes = useGraphStore((s) => s.nodes);
  const runHistory = useGraphStore((s) => s.runHistory);
  const activeRuns = useGraphStore((s) => s.activeRuns);
  const createLaunchingIds = useGraphStore((s) => s.createLaunchingIds);
  const isImportingGraph = useGraphStore((s) => s.isImportingGraph);
  const createCancelledLaunchIds = useGraphStore((s) => s.createCancelledLaunchIds);
  const cancelCreateGeneration = useGraphStore((s) => s.cancelCreateGeneration);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const setLeftDock = useUIStore((s) => s.setLeftDock);


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
    return buildDefaultParamsForUi(NODE_DEFINITIONS['nano-banana'], apiKeys);
  });
  const generations = useMemo(() => generationRecordsFromHistory(runHistory, sessionId ?? undefined), [runHistory, sessionId]);
  const activeCreateRuns = useMemo(() => runHistory.filter((run) => run.status === 'running' && run.createOrigin), [runHistory]);
  const galleryNodes = useMemo(() => {
    const activeModelIds = new Set(activeCreateRuns.flatMap((run) => run.createOrigin!.modelNodeIds));
    return allNodes.map((node) => activeModelIds.has(node.id) && node.data.state === 'idle'
      ? { ...node, data: { ...node.data, state: 'queued' as const } }
      : node);
  }, [allNodes, activeCreateRuns]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [refs, setRefs] = useState<AttachedRef[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [presetReloadKey, setPresetReloadKey] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const modelDef = modelId ? NODE_DEFINITIONS[modelId] ?? null : null;

  // A variation batch occupies one shared job slot. Reservations cover the
  // authoring window; history covers accepted jobs until their terminal event.
  const activeCount = createLaunchingIds.length + activeCreateRuns.length;

  const handleSelectModel = (id: string) => {
    setModelId(id);
    setParams(buildDefaultParamsForUi(NODE_DEFINITIONS[id], apiKeys, normalizeKreaMode(kreaConnectionMode)));
  };

  const handleApplyPreset = (preset: Preset) => {
    const next = applyPresetToComposer(preset, { modelId, prompt, params }, apiKeys, normalizeKreaMode(kreaConnectionMode));
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

  // If the Assets panel's Styles tab handed us a preset before switching to
  // Create, apply it once on mount (consume clears it so it doesn't re-apply).
  useEffect(() => {
    const pending = useUIStore.getState().consumePendingPreset();
    if (pending) handleApplyPreset(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveCurrentStyle = async () => {
    if (!modelDef) return;
    const name = window.prompt('Name this style:', prompt.slice(0, 40) || modelDef.displayName);
    if (!name) return;
    try {
      // Capture the first image output from the most-recent completed generation
      // as the thumbnail so saved user styles show a real result instead of the
      // gradient placeholder.
      let thumbnail = '';
      const nodes = useGraphStore.getState().nodes;
      const latestGen = [...generations].sort((a, b) => b.ts - a.ts)[0];
      if (latestGen) {
        outer: for (const nodeId of latestGen.modelNodeIds) {
          const node = nodes.find((n) => n.id === nodeId);
          if (!node || node.data.state !== 'complete') continue;
          for (const output of Object.values(node.data.outputs ?? {})) {
            if (output?.type === 'Image' && typeof output.value === 'string' && output.value) {
              thumbnail = output.value;
              break outer;
            }
          }
        }
      }
      await createPreset({ name, category: 'My Styles', prompt, params, modelId: modelDef.id, refImages: refs.map((r) => r.filePath), scope: 'project', thumbnail });
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
    if (!modelDef || !sessionId) return;
    // Selection and saved styles can prefill models outside the Create picker.
    // Check admission before reserving a job or authoring an incomplete recipe.
    if (!isCreateModel(modelDef)) {
      setGenerationError('This model needs Canvas input controls. Choose another model or return to Canvas.');
      return;
    }
    const store = useGraphStore.getState();
    // Do not turn repeated clicks during authoring into duplicate paid jobs.
    // Once the first job is tracked, an intentional second launch is allowed.
    if (store.createLaunchingIds.length > 0) return;
    const genId = uuidv4();
    if (!store.reserveCreateGeneration(genId)) return;
    const ts = Date.now();
    setGenerationError(null);
    const layoutY = Math.max(80, ...store.nodes.filter((node) => node.data._createOrigin).map((node) => node.position.y + 320));
    try {
      const { modelNodeIds, allNodeIds } = await store.authorGenerationCluster({
        definitionId: modelDef.id,
        prompt,
        params,
        refPaths: refs.map((r) => r.filePath),
        quantity,
        sessionId,
        genId,
        layoutOrigin: { x: 80, y: layoutY },
      });
      const lifecycle = useGraphStore.getState();
      if (!lifecycle.createLaunchingIds.includes(genId) || lifecycle.createCancelledLaunchIds.includes(genId)) return;
      if (modelNodeIds.length === 0 || allNodeIds.length === 0) throw new Error('Could not create generation nodes. Please try again.');
      // The shared execution store consumes the reservation atomically when it
      // creates the history/Stop owner. This survives leaving Create mid-launch.
      await store.executeClusterConcurrent(allNodeIds, { genId, prompt, ts, sessionId, modelNodeIds, allNodeIds });
    } catch (error) {
      if (mounted.current && !useGraphStore.getState().createCancelledLaunchIds.includes(genId)) {
        setGenerationError(error instanceof Error ? error.message : 'Could not start generation. Please try again.');
      }
    } finally {
      store.releaseCreateGeneration(genId);
    }
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
        {generationError && <span className="create-view__run-error" role="alert">{generationError}</span>}
        {createLaunchingIds.length > 0 && <span role="status">Preparing generation…</span>}
        {createLaunchingIds.map((genId) => {
          const cancelling = createCancelledLaunchIds.includes(genId);
          return <button key={genId} type="button" className="create-view__back" disabled={cancelling}
            aria-label={cancelling ? 'Cancelling preparation' : 'Stop preparing generation'} onClick={() => cancelCreateGeneration(genId)}>
            {cancelling ? 'Cancelling…' : 'Stop preparing'}
          </button>;
        })}
        {activeCreateRuns.map((run, index) => {
          const cancelling = activeRuns.some((active) => active.id === run.id && active.status === 'cancelling');
          return <button key={run.id} type="button" className="create-view__back" disabled={cancelling}
            aria-label={`${cancelling ? 'Cancelling' : 'Stop'} generation ${index + 1}`} onClick={() => void cancelRun(run.id)}>
            {cancelling ? 'Cancelling…' : `Stop ${index + 1}`}
          </button>;
        })}
        <button type="button" className="create-view__back" onClick={() => { exitCreateView(); setLeftDock('history'); }}>History</button>
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
              nodes={galleryNodes}
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
        activeCount={activeCount}
        isLaunching={createLaunchingIds.length > 0 || isImportingGraph}
        maxConcurrent={MAX_CONCURRENT}
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
