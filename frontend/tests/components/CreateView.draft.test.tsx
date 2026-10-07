import { act, fireEvent, render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { NodeData } from '../../src/types';
import type { Preset } from '../../src/lib/createPresets';
import { CreateView } from '../../src/components/create-studio/CreateView';
import { useCreateDraftStore } from '../../src/store/createDraftStore';
import { clearCreateReferenceUploads } from '../../src/lib/createUploads';

interface FakeGraph {
  nodes: Node<NodeData>[]; edges: Edge[];
  runHistory: { id: string; status: string; createOrigin?: { genId: string; prompt: string; ts: number; sessionId: string; modelNodeIds: string[]; allNodeIds: string[] } }[];
  activeRuns: []; createLaunchingIds: string[]; createCancelledLaunchIds: []; isImportingGraph: boolean;
  reserveCreateGeneration: (id: string) => boolean;
  releaseCreateGeneration: (id: string) => void;
  authorGenerationCluster: (...args: unknown[]) => Promise<{ modelNodeIds: string[]; allNodeIds: string[] }>;
  executeClusterConcurrent: (...args: unknown[]) => Promise<void>;
  cancelCreateGeneration: () => void; cancelRun: () => Promise<void>; deleteGeneration: () => void;
}
const mocks = vi.hoisted(() => ({
  graph: null as UseBoundStore<StoreApi<FakeGraph>> | null,
  fetch: vi.fn(), author: vi.fn(), execute: vi.fn(), exit: vi.fn(), dock: vi.fn(),
  pendingPreset: null as Preset | null,
  directGenerate: null as (() => Promise<void>) | null,
}));

vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
  backendAssetUrlSync: (path: string) => path,
}));
vi.mock('../../src/store/uiStore', () => {
  const state = {
    createSessionId: 'draft-session', settingsCache: { apiKeys: {}, kreaConnectionMode: 'api-token' },
    exitCreateView: mocks.exit, setLeftDock: mocks.dock,
    consumePendingPreset: () => { const preset = mocks.pendingPreset; mocks.pendingPreset = null; return preset; },
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
// Controlled inputs exercise the parent/store integration. Composer keyboard
// and button admission are separately covered with the real CreateComposer.
vi.mock('../../src/components/create-studio/CreateComposer', () => ({
  CreateComposer: ({ modelDef, prompt, params, quantity, referencesBlocked, onPromptChange, onSelectModel, onParamsChange, onQuantityChange, onAttach, onGenerate }: {
    modelDef: { id: string } | null; prompt: string; params: Record<string, unknown>; quantity: number; referencesBlocked: boolean;
    onPromptChange: (value: string) => void; onSelectModel: (id: string) => void;
    onParamsChange: (params: Record<string, unknown>) => void; onQuantityChange: (n: number) => void;
    onAttach: (files: FileList) => void; onGenerate: () => Promise<void>;
  }) => {
    mocks.directGenerate = onGenerate;
    return <>
      <textarea aria-label="Create prompt" value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
      <select aria-label="Create model" value={modelDef?.id ?? ''} onChange={(event) => onSelectModel(event.target.value)}>
        <option value="nano-banana">Nano Banana</option><option value="gpt-image-2-generate">GPT Image 2</option>
      </select>
      <input aria-label="Draft seed" type="number" value={typeof params.seed === 'number' ? params.seed : 0}
        onChange={(event) => onParamsChange({ ...params, seed: Number(event.target.value) })} />
      <button onClick={() => onQuantityChange(quantity + 1)}>More variations</button><span>{quantity} variations</span>
      <input aria-label="Attach reference" type="file" multiple onChange={(event) => { if (event.target.files) onAttach(event.target.files); }} />
      <button disabled={referencesBlocked} onClick={() => void onGenerate()}>Generate</button>
    </>;
  },
}));
vi.mock('../../src/components/create-studio/ResultsGallery', () => ({ ResultsGallery: () => null }));

function node(id: string, definitionId: string, params: Record<string, unknown>, selected = false): Node<NodeData> {
  return { id, selected, position: { x: 0, y: 0 }, data: { label: id, definitionId, params, state: 'idle', outputs: {} } };
}
function selectCanvasRecipe(prompt: string, modelId = 'nano-banana') {
  mocks.graph!.setState({
    nodes: [node('canvas-prompt', 'text-input', { value: prompt }), node('canvas-model', modelId, { seed: 42 }, true)],
    edges: [{ id: 'prompt-edge', source: 'canvas-prompt', target: 'canvas-model', sourceHandle: 'text', targetHandle: 'prompt' }],
  });
}
function image(name = 'reference.png') {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], name, { type: 'image/png' });
}
function uploadResponse(path = '/api/outputs/reference.png') {
  return { ok: true, json: async () => ({ filePath: path, url: path }) };
}
function deferredUpload() {
  let resolve!: (response: ReturnType<typeof uploadResponse> | { ok: false; status: number; json: () => Promise<{ detail: string }> }) => void;
  const promise = new Promise<Parameters<typeof resolve>[0]>((finish) => { resolve = finish; });
  mocks.fetch.mockReturnValueOnce(promise);
  return resolve;
}
function history() {
  return [{ id: 'earlier-run', status: 'complete', createOrigin: {
    genId: 'earlier-generation', prompt: 'Earlier immutable recipe', ts: 1, sessionId: 'draft-session', modelNodeIds: ['earlier-model'], allNodeIds: ['earlier-model'],
  } }];
}
beforeEach(() => {
  useCreateDraftStore.setState({ drafts: {} });
  window.localStorage.clear();
  mocks.fetch.mockReset().mockResolvedValue(uploadResponse());
  mocks.author.mockReset().mockResolvedValue({ modelNodeIds: ['new-model'], allNodeIds: ['new-model'] });
  mocks.execute.mockReset().mockResolvedValue(undefined); mocks.exit.mockReset(); mocks.dock.mockReset();
  mocks.pendingPreset = null; mocks.directGenerate = null;
  mocks.graph!.setState({ nodes: [], edges: [], runHistory: [], activeRuns: [], createLaunchingIds: [], createCancelledLaunchIds: [], isImportingGraph: false });
});
afterEach(() => {
  cleanup();
  clearCreateReferenceUploads('draft-session');
});

describe('Create draft integration', () => {
  it('resumes prompt, model, parameters, variations and ready references instead of replacing them with a later Canvas selection', async () => {
    selectCanvasRecipe('First Canvas recipe');
    const first = render(<CreateView />);
    expect(first.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('First Canvas recipe');
    fireEvent.change(first.getByLabelText('Create model'), { target: { value: 'gpt-image-2-generate' } });
    fireEvent.change(first.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'My unfinished logo study' } });
    fireEvent.change(first.getByLabelText('Draft seed'), { target: { value: '987' } });
    fireEvent.click(first.getByRole('button', { name: 'More variations' }));
    fireEvent.change(first.getByLabelText('Attach reference'), { target: { files: [image()] } });
    expect(await first.findByAltText('Reference 1')).toHaveAttribute('src', '/api/outputs/reference.png');
    const saved = structuredClone(useCreateDraftStore.getState().drafts['draft-session']);
    fireEvent.click(first.getByRole('button', { name: 'Canvas' }));
    expect(mocks.exit).toHaveBeenCalledOnce(); first.unmount();
    selectCanvasRecipe('Different selected recipe');
    const reopened = render(<CreateView />);
    expect(reopened.getByRole('textbox', { name: 'Create prompt' })).toHaveValue(saved.prompt);
    expect(reopened.getByLabelText('Create model')).toHaveValue(saved.modelId);
    expect(reopened.getByLabelText('Draft seed')).toHaveValue(987);
    expect(reopened.getByText('2 variations')).toBeInTheDocument();
    expect(reopened.getByAltText('Reference 1')).toHaveAttribute('src', saved.refs[0].previewUrl);
    expect(useCreateDraftStore.getState().drafts['draft-session']).toEqual(saved);
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('opens History and resumes the same draft without changing earlier run metadata', () => {
    const earlierHistory = history(); mocks.graph!.setState({ runHistory: earlierHistory });
    const first = render(<CreateView />);
    fireEvent.change(first.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'Unfinished history comparison' } });
    fireEvent.click(first.getByRole('button', { name: 'History' }));
    expect(mocks.exit).toHaveBeenCalledOnce(); expect(mocks.dock).toHaveBeenCalledExactlyOnceWith('history');
    first.unmount();
    const reopened = render(<CreateView />);
    expect(reopened.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('Unfinished history comparison');
    expect(mocks.graph!.getState().runHistory).toEqual(earlierHistory);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('guards a stale Generate callback during pending and failed uploads, then permits explicit generation after removal', async () => {
    const finish = deferredUpload(); const view = render(<CreateView />);
    const beforeAttach = mocks.directGenerate!;
    fireEvent.change(view.getByLabelText('Attach reference'), { target: { files: [image('slow.png')] } });
    expect(view.getByText('Uploading…')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await act(async () => { await beforeAttach(); });
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
    await act(async () => { finish({ ok: false, status: 413, json: async () => ({ detail: 'Image exceeds 20 MB limit' }) }); });
    expect(await view.findByText('Image exceeds 20 MB limit')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await act(async () => { await mocks.directGenerate!(); });
    expect(mocks.author).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Remove slow.png' }));
    expect(view.getByRole('button', { name: 'Generate' })).toBeEnabled();
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(mocks.author).toHaveBeenCalledWith(expect.objectContaining({ refPaths: [] }));
  });

  it('retries a failed attachment without changing newer prompt edits and includes the accepted reference only on explicit Generate', async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ detail: 'Upload storage unavailable' }) });
    const view = render(<CreateView />);
    fireEvent.change(view.getByLabelText('Attach reference'), { target: { files: [image('retry.png')] } });
    expect(await view.findByText('Upload storage unavailable')).toBeInTheDocument();
    fireEvent.change(view.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'Newer draft while uploading' } });
    fireEvent.click(view.getByRole('button', { name: 'Retry retry.png' }));
    expect(await view.findByAltText('Reference 1')).toBeInTheDocument();
    expect(view.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('Newer draft while uploading');
    expect(mocks.execute).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(mocks.author).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Newer draft while uploading', refPaths: ['/api/outputs/reference.png'] }));
  });

  it('finishes an accepted pending attachment while Create is unmounted and restores it on return without generating', async () => {
    const finish = deferredUpload(); const first = render(<CreateView />);
    fireEvent.change(first.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'Keep this while inspecting Canvas' } });
    fireEvent.change(first.getByLabelText('Attach reference'), { target: { files: [image('background.png')] } });
    fireEvent.click(first.getByRole('button', { name: 'Canvas' })); first.unmount();
    await act(async () => { finish(uploadResponse('/api/outputs/background.png')); });
    const reopened = render(<CreateView />);
    expect(await reopened.findByAltText('Reference 1')).toHaveAttribute('src', '/api/outputs/background.png');
    expect(reopened.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('Keep this while inspecting Canvas');
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeEnabled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('keeps an explicit new draft clear when an aborted old upload responds late and preserves all earlier runs', async () => {
    selectCanvasRecipe('Previously connected recipe');
    const earlierHistory = history(); mocks.graph!.setState({ runHistory: earlierHistory });
    const earlierNodes = structuredClone(mocks.graph!.getState().nodes);
    const earlierEdges = structuredClone(mocks.graph!.getState().edges);
    const finish = deferredUpload(); const view = render(<CreateView />);
    fireEvent.change(view.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'Discarded draft' } });
    fireEvent.change(view.getByLabelText('Attach reference'), { target: { files: [image('obsolete.png')] } });
    const revision = useCreateDraftStore.getState().drafts['draft-session'].revision;
    const signal = (mocks.fetch.mock.calls[0][1] as RequestInit).signal!;
    fireEvent.click(view.getByRole('button', { name: 'New draft' }));
    expect(signal.aborted).toBe(true);
    expect(useCreateDraftStore.getState().drafts['draft-session'].revision).not.toBe(revision);
    fireEvent.change(view.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'Replacement draft' } });
    await act(async () => { finish(uploadResponse('/api/outputs/obsolete.png')); });
    expect(view.queryByAltText('Reference 1')).toBeNull();
    expect(view.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('Replacement draft');
    expect(useCreateDraftStore.getState().drafts['draft-session'].uploads).toEqual([]);
    expect(mocks.graph!.getState().runHistory).toEqual(earlierHistory);
    expect(mocks.graph!.getState().nodes).toEqual(earlierNodes);
    expect(mocks.graph!.getState().edges).toEqual(earlierEdges);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('applies an explicit pending Style only once to the saved draft and resets the composer without creating a new run', () => {
    const first = render(<CreateView />);
    fireEvent.change(first.getByRole('textbox', { name: 'Create prompt' }), { target: { value: 'My draft' } }); first.unmount();
    mocks.pendingPreset = { id: 'warm-style', name: 'Warm', category: 'My Styles', prompt: 'Warm scene',
      modelId: 'gpt-image-2-generate', params: { seed: 73 }, refImages: ['/api/outputs/style.png'],
      thumbnail: '', scope: 'project', projectId: null, version: 1, createdAt: '', updatedAt: '' };
    const styled = render(<CreateView />);
    expect(styled.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('My draft, Warm scene');
    expect(styled.getByLabelText('Create model')).toHaveValue('gpt-image-2-generate');
    expect(styled.getByAltText('Reference 1')).toHaveAttribute('src', '/api/outputs/style.png');
    styled.unmount();
    const reopened = render(<CreateView />);
    expect(reopened.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('My draft, Warm scene');
    fireEvent.click(reopened.getByRole('button', { name: 'New draft' }));
    expect(reopened.getByRole('textbox', { name: 'Create prompt' })).toHaveValue('');
    expect(reopened.getByLabelText('Create model')).toHaveValue('nano-banana');
    expect(reopened.getByText('1 variations')).toBeInTheDocument();
    expect(reopened.queryByAltText('Reference 1')).toBeNull();
    expect(mocks.pendingPreset).toBeNull(); expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.author).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
});
