import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { NodeData } from '../../src/types';
import type { RunRecord } from '../../src/lib/runHistory';
import type { ResultContext } from '../../src/lib/resultContext';
import { CreateView } from '../../src/components/create-studio/CreateView';
import { useCreateDraftStore } from '../../src/store/createDraftStore';
import { clearCreateReferenceUploads } from '../../src/lib/createUploads';

const SESSION = 'result-reuse-session';
const MODEL = 'krea-image-google-nano-banana';
const RESULT = '/api/outputs/synthetic-saved-logo.png';
const REFERENCE = '/api/outputs/synthetic-saved-reference.png';
const PROMPT = 'Synthetic magenta logo with a clean silhouette';

interface FakeGraph {
  nodes: Node<NodeData>[];
  edges: Edge[];
  runHistory: RunRecord[];
  activeRuns: [];
  createLaunchingIds: string[];
  createCancelledLaunchIds: [];
  isImportingGraph: boolean;
  reserveCreateGeneration: (id: string) => boolean;
  releaseCreateGeneration: (id: string) => void;
  authorGenerationCluster: (...args: unknown[]) => Promise<{ modelNodeIds: string[]; allNodeIds: string[] }>;
  executeClusterConcurrent: (...args: unknown[]) => Promise<void>;
  cancelCreateGeneration: () => void;
  cancelRun: () => Promise<void>;
  deleteGeneration: () => void;
}

const mocks = vi.hoisted(() => ({
  graph: null as UseBoundStore<StoreApi<FakeGraph>> | null,
  fetch: vi.fn(), author: vi.fn(), execute: vi.fn(), exit: vi.fn(), dock: vi.fn(),
  reuse: null as ((context: ResultContext) => void) | null,
  context: null as ResultContext | null,
}));

vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
  backendAssetUrlSync: (path: string) => path,
}));
vi.mock('../../src/store/uiStore', () => {
  const state = {
    createSessionId: 'result-reuse-session',
    // Different current billing mode proves a saved MCP route stays pinned.
    settingsCache: { apiKeys: {}, kreaConnectionMode: 'api-token' },
    exitCreateView: mocks.exit, setLeftDock: mocks.dock,
    consumePendingPreset: () => null,
  };
  return { useUIStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('../../src/store/graphStore', async () => {
  const { create } = await import('zustand');
  const store = create<FakeGraph>(() => ({
    nodes: [], edges: [], runHistory: [], activeRuns: [], createLaunchingIds: [], createCancelledLaunchIds: [], isImportingGraph: false,
    reserveCreateGeneration: (id) => { store.setState({ createLaunchingIds: [...store.getState().createLaunchingIds, id] }); return true; },
    releaseCreateGeneration: (id) => store.setState({ createLaunchingIds: store.getState().createLaunchingIds.filter((entry) => entry !== id) }),
    authorGenerationCluster: (...args) => mocks.author(...args),
    executeClusterConcurrent: (...args) => mocks.execute(...args),
    cancelCreateGeneration: vi.fn(), cancelRun: vi.fn(), deleteGeneration: vi.fn(),
  }));
  mocks.graph = store;
  return { useGraphStore: store };
});
// The real parent, draft store, upload coordinator and provenance helper are
// exercised here; the picker/gallery's rendering has its own component tests.
vi.mock('../../src/components/create-studio/CreateComposer', () => ({
  CreateComposer: ({ modelDef, prompt, params, quantity, referencesBlocked, onPromptChange, onParamsChange, onQuantityChange, onAttach, onGenerate }: {
    modelDef: { id: string } | null; prompt: string; params: Record<string, unknown>; quantity: number; referencesBlocked: boolean;
    onPromptChange: (value: string) => void;
    onParamsChange: (params: Record<string, unknown>) => void; onQuantityChange: (n: number) => void;
    onAttach: (files: FileList) => void; onGenerate: () => Promise<void>;
  }) => <>
    <textarea aria-label="Create prompt" value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
    <span aria-label="Draft model">{modelDef?.id}</span>
    <input aria-label="Draft width" type="number" value={typeof params.width === 'number' ? params.width : 0}
      onChange={(event) => onParamsChange({ ...params, width: Number(event.target.value) })} />
    <button onClick={() => onQuantityChange(quantity + 1)}>More variations</button><span>{quantity} variations</span>
    <input aria-label="Attach reference" type="file" multiple onChange={(event) => { if (event.target.files) onAttach(event.target.files); }} />
    <button disabled={referencesBlocked} onClick={() => void onGenerate()}>Generate</button>
  </>,
}));
vi.mock('../../src/components/create-studio/ResultsGallery', async () => {
  const { resultContextForNode } = await import('../../src/lib/resultContext');
  return {
    ResultsGallery: ({ nodes, history, onReuseSettings }: {
      nodes: Node<NodeData>[]; history: RunRecord[]; onReuseSettings: (context: ResultContext) => void;
    }) => {
      const context = resultContextForNode(nodes.find((entry) => entry.id === 'saved-model')!, history);
      mocks.reuse = onReuseSettings;
      mocks.context = context;
      return <button onClick={() => onReuseSettings(context)}>Reuse settings</button>;
    },
  };
});

function node(id: string, definitionId: string, params: Record<string, unknown>, outputs: NodeData['outputs'] = {}): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, data: { label: id, definitionId, params, state: 'complete', outputs } };
}

function seedSavedResult() {
  const outputs: NodeData['outputs'] = { image: { type: 'Image', value: RESULT } };
  const nodes = [
    node('saved-prompt', 'text-input', { value: 'Canvas prompt was edited after generation' }, { text: { type: 'Text', value: 'Changed' } }),
    node('saved-reference', 'image-input', { filePath: '/api/outputs/changed-reference.png' }, { image: { type: 'Image', value: '/api/outputs/changed-reference.png' } }),
    node('saved-model', MODEL, { _kreaAuth: 'api-token', width: 256, aspect_ratio: '9:16' }, outputs),
  ];
  const edges: Edge[] = [
    { id: 'saved-prompt-edge', source: 'saved-prompt', sourceHandle: 'text', target: 'saved-model', targetHandle: 'prompt' },
    { id: 'saved-reference-edge', source: 'saved-reference', sourceHandle: 'image', target: 'saved-model', targetHandle: 'image_urls' },
  ];
  const run: RunRecord = {
    id: 'immutable-earlier-run', trigger: 'cluster', status: 'complete', startedAt: 1_791_234_567_890,
    snapshot: {
      nodes: [
        { id: 'saved-prompt', definitionId: 'text-input', params: { value: PROMPT }, outputs: { text: { type: 'Text', value: PROMPT } } },
        { id: 'saved-reference', definitionId: 'image-input', params: { filePath: REFERENCE }, outputs: { image: { type: 'Image', value: REFERENCE } } },
        { id: 'saved-model', definitionId: MODEL, params: { _kreaAuth: 'mcp', width: 1024, aspect_ratio: '1:1', _jobId: 'synthetic-old-job' }, outputs: {} },
      ],
      edges: edges.map(({ id, source, sourceHandle, target, targetHandle }) => ({ id, source, sourceHandle, target, targetHandle })),
    },
    resultOutputs: { 'saved-model': outputs },
    createOrigin: {
      genId: 'saved-generation', sessionId: SESSION, prompt: PROMPT, ts: 1_791_234_567_890,
      modelNodeIds: ['saved-model'], allNodeIds: nodes.map((entry) => entry.id),
    },
  };
  mocks.graph!.setState({ nodes, edges, runHistory: [run] });
}

function currentDraft() { return useCreateDraftStore.getState().drafts[SESSION]; }
function readyDraft() {
  useCreateDraftStore.getState().getOrCreateDraft(SESSION, {
    modelId: 'gpt-image-2-generate', prompt: 'Unfinished synthetic study', params: { size: '1536x1024' },
    refs: [{ filePath: '/api/outputs/previous-reference.png', previewUrl: '/api/outputs/previous-reference.png' }], quantity: 3,
  });
}
function image(name = 'obsolete.png') {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], name, { type: 'image/png' });
}
function uploadResponse(path = '/api/outputs/obsolete.png') { return { ok: true, json: async () => ({ filePath: path, url: path }) }; }
function deferredUpload() {
  let resolve!: (response: ReturnType<typeof uploadResponse>) => void;
  mocks.fetch.mockReturnValueOnce(new Promise<ReturnType<typeof uploadResponse>>((finish) => { resolve = finish; }));
  return resolve;
}

beforeEach(() => {
  useCreateDraftStore.setState({ drafts: {} }); window.localStorage.clear();
  mocks.fetch.mockReset().mockResolvedValue(uploadResponse());
  mocks.author.mockReset().mockResolvedValue({ modelNodeIds: ['new-model'], allNodeIds: ['new-model'] });
  mocks.execute.mockReset().mockResolvedValue(undefined); mocks.exit.mockReset(); mocks.dock.mockReset();
  mocks.reuse = null; mocks.context = null;
  mocks.graph!.setState({ nodes: [], edges: [], runHistory: [], activeRuns: [], createLaunchingIds: [], createCancelledLaunchIds: [], isImportingGraph: false });
  seedSavedResult();
});
afterEach(() => { cleanup(); clearCreateReferenceUploads(SESSION); });

describe('Create result reuse', () => {
  it('copies the matching immutable recipe with one variation and pinned billing into a fresh draft without authoring or changing history', () => {
    readyDraft();
    const previous = structuredClone(currentDraft());
    const graph = structuredClone({ nodes: mocks.graph!.getState().nodes, edges: mocks.graph!.getState().edges, history: mocks.graph!.getState().runHistory });
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    expect(view.getByRole('textbox', { name: 'Create prompt' })).toHaveValue(PROMPT);
    expect(view.getByLabelText('Draft model')).toHaveTextContent(MODEL);
    expect(view.getByLabelText('Draft width')).toHaveValue(1024);
    expect(view.getByText('1 variations')).toBeInTheDocument();
    expect(view.getByAltText('Reference 1')).toHaveAttribute('src', REFERENCE);
    expect(currentDraft().revision).not.toBe(previous.revision);
    expect(currentDraft().params).toEqual(expect.objectContaining({ _kreaAuth: 'mcp', width: 1024, aspect_ratio: '1:1' }));
    expect(currentDraft().params).not.toHaveProperty('_jobId');
    expect(currentDraft().refs).toEqual([{ filePath: REFERENCE, previewUrl: REFERENCE }]);
    expect(currentDraft().uploads).toEqual([]);
    expect(view.getByRole('status')).toHaveTextContent('Settings copied to draft. Generate when ready.');
    expect(view.getByRole('textbox', { name: 'Create prompt' })).toHaveFocus();
    expect(mocks.graph!.getState().nodes).toEqual(graph.nodes);
    expect(mocks.graph!.getState().edges).toEqual(graph.edges);
    expect(mocks.graph!.getState().runHistory).toEqual(graph.history);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('starts a new run only after explicit Generate and sends the copied saved recipe', async () => {
    const view = render(<CreateView />);
    const history = structuredClone(mocks.graph!.getState().runHistory);
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(mocks.author).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      definitionId: MODEL, prompt: PROMPT, quantity: 1,
      params: expect.objectContaining({ _kreaAuth: 'mcp', width: 1024, aspect_ratio: '1:1' }),
      refPaths: [REFERENCE], sessionId: SESSION,
    }));
    expect(mocks.author.mock.calls[0][0].params).not.toHaveProperty('_jobId');
    expect(mocks.graph!.getState().runHistory).toEqual(history);
  });

  it('aborts an old pending reference and ignores its late completion after reuse', async () => {
    const finish = deferredUpload(); const view = render(<CreateView />);
    fireEvent.change(view.getByLabelText('Attach reference'), { target: { files: [image()] } });
    expect(view.getByText('Uploading…')).toBeInTheDocument();
    const previousRevision = currentDraft().revision;
    const signal = (mocks.fetch.mock.calls[0][1] as RequestInit).signal!;
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    expect(signal.aborted).toBe(true);
    expect(currentDraft().revision).not.toBe(previousRevision);
    await act(async () => { finish(uploadResponse()); });
    expect(currentDraft().refs).toEqual([{ filePath: REFERENCE, previewUrl: REFERENCE }]);
    expect(currentDraft().uploads).toEqual([]);
    expect(view.queryByText('Uploading…')).toBeNull();
    expect(view.getByRole('button', { name: 'Generate' })).toBeEnabled();
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('undoes replacement to the previous ready draft with a new revision without reviving cancelled uploads', async () => {
    readyDraft(); const beforeUpload = structuredClone(currentDraft());
    const finish = deferredUpload(); const view = render(<CreateView />);
    fireEvent.change(view.getByLabelText('Attach reference'), { target: { files: [image()] } });
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    const copiedRevision = currentDraft().revision;
    fireEvent.click(view.getByRole('button', { name: 'Undo' }));
    expect(currentDraft()).toEqual({ ...beforeUpload, revision: expect.any(String), uploads: [] });
    expect(currentDraft().revision).not.toBe(beforeUpload.revision);
    expect(currentDraft().revision).not.toBe(copiedRevision);
    await act(async () => { finish(uploadResponse()); });
    expect(currentDraft().refs).toEqual(beforeUpload.refs);
    expect(currentDraft().uploads).toEqual([]);
    expect(view.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('does not let Undo replace a newer edit, and New draft clears the reuse action', () => {
    readyDraft(); const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    fireEvent.change(view.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'New intentional draft edit' } });
    expect(view.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(currentDraft().prompt).toBe('New intentional draft edit');
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    expect(view.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'New draft' }));
    expect(view.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(view.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('');
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('guards an unavailable saved recipe even if a stale gallery callback asks to reuse it', () => {
    const state = mocks.graph!.getState();
    // A live output without exact saved resultOutputs must not reuse edited
    // Canvas controls while claiming they generated the displayed image.
    mocks.graph!.setState({ runHistory: state.runHistory.map((entry) => ({ ...entry, resultOutputs: undefined })) });
    readyDraft(); const view = render(<CreateView />); const before = structuredClone(currentDraft());
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    expect(currentDraft()).toEqual(before);
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
});
