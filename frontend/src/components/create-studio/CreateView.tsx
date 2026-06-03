import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from '../../lib/createParams';
import { uploadReference } from '../../lib/createUploads';
import { type GenerationRecord } from '../../lib/createGallery';
import { CreateComposer } from './CreateComposer';
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

  const [modelId, setModelId] = useState<string | null>('nano-banana');
  const [prompt, setPrompt] = useState('');
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    buildDefaultParamsForUi(NODE_DEFINITIONS['nano-banana']),
  );
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [refs, setRefs] = useState<AttachedRef[]>([]);
  const [quantity, setQuantity] = useState(1);

  const modelDef = modelId ? NODE_DEFINITIONS[modelId] ?? null : null;

  const handleSelectModel = (id: string) => {
    setModelId(id);
    setParams(buildDefaultParamsForUi(NODE_DEFINITIONS[id]));
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
        {generations.length === 0 ? (
          <div className="create-view__hero">
            <div className="create-view__hero-title">Start creating</div>
            <div className="create-view__hero-sub">Describe an idea, pick a model, and generate. Your nodes build on the canvas as you go.</div>
          </div>
        ) : (
          <ResultsGallery
            records={generations}
            nodes={allNodes}
            onOpenInCanvas={handleOpenInCanvas}
            onUseAsInput={handleUseAsInput}
            onDelete={handleDelete}
          />
        )}
      </div>

      <ReferenceTray refs={refs} onRemove={(fp) => setRefs((p) => p.filter((r) => r.filePath !== fp))} />
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
      />
    </div>
  );
}
