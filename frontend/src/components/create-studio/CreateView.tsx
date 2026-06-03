import { useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from '../../lib/createParams';
import { CreateComposer } from './CreateComposer';
import { OutputRenderer } from './OutputRenderer';
import '../../styles/create-studio.css';

export function CreateView() {
  const exitCreateView = useUIStore((s) => s.exitCreateView);
  const sessionId = useUIStore((s) => s.createSessionId);
  const isExecuting = useGraphStore((s) => s.isExecuting);

  const [modelId, setModelId] = useState<string | null>('nano-banana');
  const [prompt, setPrompt] = useState('');
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    buildDefaultParamsForUi(NODE_DEFINITIONS['nano-banana']),
  );
  const [lastModelNodeIds, setLastModelNodeIds] = useState<string[]>([]);
  const cursor = useRef({ x: 80, y: 80 });

  const modelDef = modelId ? NODE_DEFINITIONS[modelId] ?? null : null;

  const resultNode = useGraphStore((s) =>
    lastModelNodeIds[0] ? s.nodes.find((n) => n.id === lastModelNodeIds[0]) : undefined,
  );

  const handleSelectModel = (id: string) => {
    setModelId(id);
    setParams(buildDefaultParamsForUi(NODE_DEFINITIONS[id]));
  };

  const handleGenerate = async () => {
    if (!modelDef || !sessionId || isExecuting) return;
    const { authorGenerationCluster, executeCluster } = useGraphStore.getState();
    const { modelNodeIds, allNodeIds } = await authorGenerationCluster({
      definitionId: modelDef.id,
      prompt,
      params,
      refPaths: [],
      quantity: 1,
      sessionId,
      genId: uuidv4(),
      layoutOrigin: { ...cursor.current },
    });
    cursor.current = { x: cursor.current.x, y: cursor.current.y + 320 };
    setLastModelNodeIds(modelNodeIds);
    await executeCluster(allNodeIds);
  };

  const heroEmpty = useMemo(() => lastModelNodeIds.length === 0, [lastModelNodeIds]);

  return (
    <div className="create-view">
      <header className="create-view__topbar">
        <button type="button" className="create-view__back" onClick={exitCreateView}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /> Canvas
        </button>
        <span className="create-view__title">Create</span>
      </header>

      <div className="create-view__stage">
        {heroEmpty ? (
          <div className="create-view__hero">
            <div className="create-view__hero-title">Start creating</div>
            <div className="create-view__hero-sub">Describe an idea, pick a model, and generate. Your nodes build on the canvas as you go.</div>
          </div>
        ) : (
          <div className="create-view__result">
            {resultNode && (
              <OutputRenderer
                outputs={resultNode.data.outputs}
                state={resultNode.data.state}
                error={resultNode.data.error}
                streamingText={resultNode.data.streamingText}
                streamingPartials={resultNode.data.streamingPartials}
              />
            )}
          </div>
        )}
      </div>

      <CreateComposer
        modelDef={modelDef}
        prompt={prompt}
        params={params}
        isExecuting={isExecuting}
        onPromptChange={setPrompt}
        onSelectModel={handleSelectModel}
        onParamsChange={setParams}
        onGenerate={handleGenerate}
      />
    </div>
  );
}
