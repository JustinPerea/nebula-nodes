import { useState, useMemo, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { WorkspaceModeNavigation } from '../CanvasTabs';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useCreateDraftStore, type CreateDraft, type CreateDraftSeed } from '../../store/createDraftStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from '../../lib/createParams';
import { isCreateModel } from '../../lib/createModels';
import { normalizeKreaMode } from '../../lib/kreaConnection';
import { attachCreateReferences, canRetryCreateReference, retryCreateReference, removeCreateReferenceUpload, clearCreateReferenceUploads } from '../../lib/createUploads';
import { revealInFinder, saveToFolder } from '../../lib/createFiles';
import { generationRecordsFromHistory, galleryItemsFromCanvas } from '../../lib/createGallery';
import { composerStateFromSelection } from '../../lib/createSelection';
import type { ResultContext } from '../../lib/resultContext';
import { applyPresetToComposer } from '../../lib/applyPreset';
import { createPreset, type Preset } from '../../lib/createPresets';
import { CreateComposer } from './CreateComposer';
import { PresetLibrary } from './PresetLibrary';
import { ResultsGallery } from './ResultsGallery';
import { ReferenceTray } from './ReferenceTray';
import { usePrompt } from '../../hooks/usePrompt';
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

  const defaultDraft = (): CreateDraftSeed => ({
    modelId: 'nano-banana', prompt: '',
    params: buildDefaultParamsForUi(NODE_DEFINITIONS['nano-banana'], apiKeys, normalizeKreaMode(kreaConnectionMode)),
    refs: [], quantity: 1,
  });
  const [seededDraft] = useState<CreateDraft>(() => {
    const seed = { ...defaultDraft(), ...initial.prefill };
    return sessionId ? useCreateDraftStore.getState().getOrCreateDraft(sessionId, seed)
      : { ...seed, revision: 'uninitialized', uploads: [] };
  });
  const draft = useCreateDraftStore((state) => sessionId ? state.drafts[sessionId] : undefined) ?? seededDraft;
  const { modelId, prompt, params, refs, quantity, uploads } = draft;
  const updateDraft = (patch: Partial<CreateDraft> | ((current: CreateDraft) => Partial<CreateDraft>)) => {
    if (sessionId) useCreateDraftStore.getState().updateDraft(sessionId, patch);
  };
  const setPrompt = (value: string) => updateDraft({ prompt: value });
  const setParams = (value: Record<string, unknown>) => updateDraft({ params: value });
  const setQuantity = (value: number) => updateDraft({ quantity: value });
  const setRefs = (updater: (current: AttachedRef[]) => AttachedRef[]) => updateDraft((current) => ({ refs: updater(current.refs) }));
  const generations = useMemo(() => generationRecordsFromHistory(runHistory, sessionId ?? undefined), [runHistory, sessionId]);
  const activeCreateRuns = useMemo(() => runHistory.filter((run) => run.status === 'running' && run.createOrigin), [runHistory]);
  const galleryNodes = useMemo(() => {
    const activeModelIds = new Set(activeCreateRuns.flatMap((run) => run.createOrigin!.modelNodeIds));
    return allNodes.map((node) => activeModelIds.has(node.id) && node.data.state === 'idle'
      ? { ...node, data: { ...node.data, state: 'queued' as const } }
      : node);
  }, [allNodes, activeCreateRuns]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [presetReloadKey, setPresetReloadKey] = useState(0);
  const [ask, promptElement] = usePrompt();
  const [savingStyle, setSavingStyle] = useState(false);
  const [styleSaveError, setStyleSaveError] = useState<string | null>(null);
  const [reusedDraft, setReusedDraft] = useState<{ previous: CreateDraftSeed; fingerprint: string; removedAttachments: boolean } | null>(null);
  const focusDraft = useRef(false);
  const composerArea = useRef<HTMLDivElement>(null);
  const canUndoReuse = reusedDraft?.fingerprint === JSON.stringify(draft);
  useEffect(() => {
    if (!focusDraft.current) return;
    focusDraft.current = false;
    composerArea.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
  }, [draft.revision]);
  const styleSavePending = useRef(false);
  const styleName = useRef<string | null>(null);

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
    updateDraft({ modelId: id, params: buildDefaultParamsForUi(NODE_DEFINITIONS[id], apiKeys, normalizeKreaMode(kreaConnectionMode)) });
  };

  const handleApplyPreset = (preset: Preset) => {
    const next = applyPresetToComposer(preset, { modelId, prompt, params }, apiKeys, normalizeKreaMode(kreaConnectionMode));
    updateDraft((current) => ({
      modelId: next.modelId ?? current.modelId, prompt: next.prompt, params: next.params,
      refs: [...current.refs, ...preset.refImages.filter((fp) => !current.refs.some((ref) => ref.filePath === fp))
        .map((fp) => ({ filePath: fp, previewUrl: fp }))],
    }));
  };

  // If the Assets panel's Styles tab handed us a preset before switching to
  // Create, apply it once on mount (consume clears it so it doesn't re-apply).
  useEffect(() => {
    const pending = useUIStore.getState().consumePendingPreset();
    if (pending) handleApplyPreset(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveCurrentStyle = async () => {
    if (!modelDef || styleSavePending.current) return;
    if (uploads.length > 0) {
      setStyleSaveError('Finish attaching references or remove them before saving this style.');
      return;
    }
    styleSavePending.current = true;
    setStyleSaveError(null);
    try {
      const name = (await ask('Name this style:', styleName.current ?? (prompt.slice(0, 40) || modelDef.displayName)))?.trim();
      if (!name || !mounted.current) return;
      styleName.current = name;
      setSavingStyle(true);
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
      styleName.current = null;
      if (mounted.current) setPresetReloadKey((k) => k + 1);
    } catch (err) {
      if (mounted.current) setStyleSaveError(err instanceof Error ? err.message : 'Could not save this style. Please try again.');
    } finally {
      styleSavePending.current = false;
      if (mounted.current) setSavingStyle(false);
    }
  };

  const handleAttach = (files: FileList) => {
    if (sessionId) attachCreateReferences(sessionId, files);
  };

  const handleNewDraft = () => {
    if (!sessionId) return;
    clearCreateReferenceUploads(sessionId);
    useCreateDraftStore.getState().resetDraft(sessionId, defaultDraft());
    setGenerationError(null);
    setStyleSaveError(null);
    setReusedDraft(null);
  };

  const handleReuseSettings = (context: ResultContext) => {
    if (!sessionId || !context.reusableDraft) {
      setGenerationError(context.reuseUnavailableReason ?? 'This recipe cannot be copied into Create. Open it on Canvas.');
      return;
    }
    const current = useCreateDraftStore.getState().drafts[sessionId];
    if (!current) return;
    // Replacing a draft revokes pending uploads and stale composer callbacks.
    // Undo retains only ready references; aborted files must be attached again.
    const previous: CreateDraftSeed = structuredClone({ modelId: current.modelId, prompt: current.prompt,
      params: current.params, refs: current.refs, quantity: current.quantity, uploads: [] });
    clearCreateReferenceUploads(sessionId);
    focusDraft.current = true;
    useCreateDraftStore.getState().resetDraft(sessionId, structuredClone(context.reusableDraft));
    setReusedDraft({ previous, fingerprint: JSON.stringify(useCreateDraftStore.getState().drafts[sessionId]), removedAttachments: current.uploads.length > 0 });
    setGenerationError(null);
    setStyleSaveError(null);
  };

  const handleUndoReuse = () => {
    if (!sessionId || !reusedDraft || reusedDraft.fingerprint !== JSON.stringify(useCreateDraftStore.getState().drafts[sessionId])) return;
    clearCreateReferenceUploads(sessionId);
    focusDraft.current = true;
    useCreateDraftStore.getState().resetDraft(sessionId, reusedDraft.previous);
    setReusedDraft(null);
  };

  const handleGenerate = async () => {
    if (!sessionId) return;
    const currentDraft = useCreateDraftStore.getState().drafts[sessionId];
    const currentModel = currentDraft?.modelId ? NODE_DEFINITIONS[currentDraft.modelId] : null;
    if (!currentDraft || !currentModel) return;
    if (currentDraft.uploads.length > 0) {
      setGenerationError('Finish attaching references or remove them before generating.');
      return;
    }
    // Selection and saved styles can prefill models outside the Create picker.
    // Check admission before reserving a job or authoring an incomplete recipe.
    if (!isCreateModel(currentModel)) {
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
        definitionId: currentModel.id,
        prompt: currentDraft.prompt,
        params: currentDraft.params,
        refPaths: currentDraft.refs.map((r) => r.filePath),
        quantity: currentDraft.quantity,
        sessionId,
        genId,
        layoutOrigin: { x: 80, y: layoutY },
      });
      const lifecycle = useGraphStore.getState();
      if (!lifecycle.createLaunchingIds.includes(genId) || lifecycle.createCancelledLaunchIds.includes(genId)) return;
      if (modelNodeIds.length === 0 || allNodeIds.length === 0) throw new Error('Could not create generation nodes. Please try again.');
      // The shared execution store consumes the reservation atomically when it
      // creates the history/Stop owner. This survives leaving Create mid-launch.
      await store.executeClusterConcurrent(allNodeIds, { genId, prompt: currentDraft.prompt, ts, sessionId, modelNodeIds, allNodeIds });
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
    return saveToFolder(url);
  };

  return (
    <div className="create-view">
      <WorkspaceHeader title="Creator Studio" onBack={exitCreateView} className="create-view__topbar"
        navigation={<WorkspaceModeNavigation />}>
        <button type="button" className="create-view__back" onClick={handleNewDraft}>New draft</button>
        {styleSaveError && <span className="create-view__save-error" role="alert">{styleSaveError}</span>}
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
      </WorkspaceHeader>

      <div
        className="create-view__stage"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) void handleAttach(e.dataTransfer.files); }}
      >
        {(() => {
          const hasSessionResults = generations.length > 0;
          const hasCanvasResults = galleryItemsFromCanvas(allNodes).length > 0;
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
              history={runHistory}
              onReuseSettings={handleReuseSettings}
              emptyState={!hasSessionResults && !hasCanvasResults ? <div className="create-view__hero">
                <div className="create-view__hero-title">Start creating</div>
                <div className="create-view__hero-sub">Describe an idea, pick a model, and generate. Your nodes build on the canvas as you go.</div>
              </div> : undefined}
            />
          );
        })()}
      </div>

      {stylesOpen && (
        <PresetLibrary
          onApply={handleApplyPreset}
          onSaveCurrent={handleSaveCurrentStyle}
          onClose={() => setStylesOpen(false)}
          reloadKey={presetReloadKey}
          saving={savingStyle}
        />
      )}
      <div ref={composerArea} className="create-view__composer-area">
        {canUndoReuse && <div className="create-view__reuse-feedback">
          <span role="status">Settings copied to draft. Generate when ready.</span>
          {reusedDraft?.removedAttachments && <span>Unfinished attachments were removed. Reattach those files after Undo.</span>}
          <button type="button" className="create-view__back" onClick={handleUndoReuse}>Undo</button>
        </div>}
        <ReferenceTray refs={refs} uploads={uploads}
          onRemove={(fp) => setRefs((p) => p.filter((r) => r.filePath !== fp))}
          canRetry={(id) => Boolean(sessionId && canRetryCreateReference(sessionId, id))}
          onRetry={(id, file) => { if (sessionId) retryCreateReference(sessionId, id, file); }}
          onRemoveUpload={(id) => { if (sessionId) removeCreateReferenceUpload(sessionId, id); }} />
        <CreateComposer
          key={draft.revision}
          modelDef={modelDef}
          prompt={prompt}
          params={params}
          activeCount={activeCount}
          isLaunching={createLaunchingIds.length > 0 || isImportingGraph}
          referencesBlocked={uploads.length > 0}
          referenceStatus={uploads.some((upload) => upload.status === 'uploading')
            ? 'Uploading references…' : uploads.length > 0 ? 'Retry, attach again or remove failed references to generate.' : undefined}
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
      {promptElement}
    </div>
  );
}
