import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { CreateView } from '../../src/components/create-studio/CreateView';
import { CREATE_DRAFT_STORAGE_KEY, useCreateDraftStore } from '../../src/store/createDraftStore';

interface CreateOrigin {
  genId: string; prompt: string; ts: number; sessionId: string; modelNodeIds: string[]; allNodeIds: string[];
}
interface FakeRun { id: string; status: string; createOrigin: CreateOrigin }
interface FakeGraph {
  nodes: Node<NodeData>[]; edges: []; runHistory: FakeRun[]; createLaunchingIds: string[]; createCancelledLaunchIds: string[]; activeRuns: { id: string; status: string }[];
  authorGenerationCluster: (...args: unknown[]) => Promise<{ modelNodeIds: string[]; allNodeIds: string[] }>;
  executeClusterConcurrent: (ids: string[], origin: CreateOrigin) => Promise<void>;
  reserveCreateGeneration: (id: string) => boolean;
  releaseCreateGeneration: (id: string) => void;
  cancelCreateGeneration: (id: string) => void;
  // GM r8 (3), #204 r7: Generate's lines go to the app's notice region.
  messageNotice: { id: number; text: string; tone: 'error' | 'info' } | null;
  undoNotice: null;
  notify: (text: string, tone?: 'error' | 'info') => void;
  cancelRun: (id: string) => Promise<void>;
}
const mocks = vi.hoisted(() => ({
  store: null as UseBoundStore<StoreApi<FakeGraph>> | null,
  author: vi.fn(), execute: vi.fn(), cancel: vi.fn(), exit: vi.fn(), dock: vi.fn(),
  ui: { createSessionId: 'session', settingsCache: { apiKeys: {} }, consumePendingPreset: vi.fn() },
}));
vi.mock('../../src/store/uiStore', () => ({
  useUIStore: Object.assign((selector: (state: unknown) => unknown) => selector({ ...mocks.ui, exitCreateView: mocks.exit, setLeftDock: mocks.dock }),
    { getState: () => ({ ...mocks.ui, exitCreateView: mocks.exit, setLeftDock: mocks.dock }) }),
}));
vi.mock('../../src/store/graphStore', async () => {
  const { create } = await import('zustand');
  const store = create<FakeGraph>(() => ({
    nodes: [], edges: [], runHistory: [], createLaunchingIds: [], createCancelledLaunchIds: [], unsavedScenes: {}, activeRuns: [],
    authorGenerationCluster: (...args) => mocks.author(...args),
    executeClusterConcurrent: async (ids, origin) => {
      mocks.execute(ids, origin);
      store.setState((state) => ({
        runHistory: [{ id: origin.genId, status: 'running', createOrigin: origin }, ...state.runHistory],
        createLaunchingIds: state.createLaunchingIds.filter((id) => id !== origin.genId),
      }));
    },
    reserveCreateGeneration: (id) => {
      const state = store.getState();
      if (state.createLaunchingIds.length + state.runHistory.filter((run) => run.status === 'running').length >= 2) return false;
      store.setState({ createLaunchingIds: [...state.createLaunchingIds, id] });
      return true;
    },
    releaseCreateGeneration: (id) => store.setState((state) => ({
      createLaunchingIds: state.createLaunchingIds.filter((existing) => existing !== id),
      createCancelledLaunchIds: state.createCancelledLaunchIds.filter((existing) => existing !== id),
    })),
    cancelCreateGeneration: (id) => store.setState((state) => ({ createCancelledLaunchIds: [...state.createCancelledLaunchIds, id] })),
    messageNotice: null, undoNotice: null,
    notify: (text, tone = 'info') => store.setState({ messageNotice: { id: Date.now(), text, tone } }),
    cancelRun: async (id) => { mocks.cancel(id); },
  }));
  mocks.store = store;
  return { useGraphStore: store };
});
vi.mock('../../src/components/create-studio/CreateComposer', () => ({
  CreateComposer: ({ onGenerate, activeCount, maxConcurrent, isLaunching }: {
    onGenerate: () => void; activeCount: number; maxConcurrent: number; isLaunching?: boolean;
  }) => <><button onClick={onGenerate} disabled={activeCount >= maxConcurrent || isLaunching}>Generate</button><span>{activeCount} active</span></>,
}));
vi.mock('../../src/components/create-studio/ReferenceTray', () => ({ ReferenceTray: () => null }));
vi.mock('../../src/components/create-studio/ResultsGallery', () => ({
  ResultsGallery: ({ records, nodes }: { records: CreateOrigin[]; nodes: Node<NodeData>[] }) => <div aria-label="Generations">{records.map((record) => <span key={record.genId}>{record.genId}</span>)}{nodes.map((node) => <span key={node.id} data-testid={`state-${node.id}`}>{node.data.state}</span>)}</div>,
}));

function origin(genId: string, modelNodeIds: string[] = ['model']): CreateOrigin {
  return { genId, modelNodeIds, allNodeIds: modelNodeIds, prompt: 'Synthetic prompt', ts: 1, sessionId: 'session' };
}
function model(id: string): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, data: { label: id, definitionId: 'nano-banana', params: {}, state: 'queued', outputs: {} } };
}
beforeEach(() => {
  useCreateDraftStore.setState({ drafts: {} });
  localStorage.removeItem(CREATE_DRAFT_STORAGE_KEY);
  mocks.author.mockReset().mockResolvedValue({ modelNodeIds: ['model'], allNodeIds: ['model'] });
  mocks.execute.mockReset(); mocks.cancel.mockReset(); mocks.exit.mockReset(); mocks.dock.mockReset();
  mocks.ui.consumePendingPreset.mockReset().mockReturnValue(null);
  mocks.store!.setState({ nodes: [], edges: [], runHistory: [], createLaunchingIds: [], createCancelledLaunchIds: [], activeRuns: [], messageNotice: null });
});

describe('Create lifecycle across view visits', () => {
  it('rejects a Canvas selection requiring unsupported inputs before creating a job', () => {
    mocks.store!.setState({ nodes: [{ ...model('selected-video'), selected: true,
      data: { ...model('selected-video').data, definitionId: 'runway-aleph' } }] });
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    expect(mocks.store!.getState().messageNotice?.text).toContain('This model needs Canvas input controls');
    expect(view.queryByRole('alert')).toBeNull();
    expect(mocks.store!.getState().createLaunchingIds).toHaveLength(0);
    expect(mocks.author).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects a saved style requiring unsupported inputs before creating a job', () => {
    mocks.ui.consumePendingPreset.mockReturnValueOnce({
      id: 'unsupported-style', name: 'Video edit style', category: 'My Styles',
      modelId: 'runway-aleph', prompt: 'Edit the input video', params: {}, refImages: [],
      thumbnail: '', version: 1, scope: 'global', projectId: null, createdAt: '', updatedAt: '',
    });
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    expect(mocks.store!.getState().messageNotice?.text).toContain('This model needs Canvas input controls');
    expect(view.queryByRole('alert')).toBeNull();
    expect(mocks.store!.getState().createLaunchingIds).toHaveLength(0);
    expect(mocks.author).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('shows recovered active model nodes as generating when the backend snapshot still has idle state', () => {
    mocks.store!.setState({
      nodes: [{ ...model('restored-model'), data: { ...model('restored-model').data, state: 'idle' } }],
      runHistory: [{ id: 'restored-run', status: 'running', createOrigin: origin('restored', ['restored-model']) }],
    });
    const view = render(<CreateView />);
    expect(view.getByLabelText('Generations')).toHaveTextContent('restored');
    expect(view.getByTestId('state-restored-model')).toHaveTextContent('queued');
    expect(mocks.store!.getState().nodes[0].data.state).toBe('idle');
  });
  it('keeps the active cap and gallery after unmounting and reopening, counting a variation batch as one job', () => {
    mocks.store!.setState({
      nodes: [model('m1'), model('m2'), model('m3')],
      runHistory: [{ id: 'run-one', status: 'running', createOrigin: origin('one', ['m1', 'm2']) },
        { id: 'run-two', status: 'running', createOrigin: origin('two', ['m3']) }],
    });
    const first = render(<CreateView />);
    expect(first.getByText('2 active')).toBeInTheDocument();
    expect(first.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(first.getByLabelText('Generations')).toHaveTextContent('one');
    act(() => mocks.store!.setState({ nodes: [] }));
    expect(first.getByText('2 active')).toBeInTheDocument();
    first.unmount();
    const reopened = render(<CreateView />);
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(reopened.getByLabelText('Generations')).toHaveTextContent('two');
    expect(mocks.author).not.toHaveBeenCalled();
  });

  it('reserves before authoring, blocks rapid duplicate clicks and retains that guard while the view is closed', async () => {
    let finish!: (value: { modelNodeIds: string[]; allNodeIds: string[] }) => void;
    mocks.author.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<CreateView />);
    const generate = view.getByRole('button', { name: 'Generate' });
    fireEvent.click(generate);
    fireEvent.click(generate);
    expect(mocks.author).toHaveBeenCalledTimes(1);
    expect(mocks.store!.getState().createLaunchingIds).toHaveLength(1);
    view.unmount();
    const reopened = render(<CreateView />);
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await act(async () => { finish({ modelNodeIds: ['model'], allNodeIds: ['model'] }); });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(reopened.getByText('1 active')).toBeInTheDocument();
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeEnabled();
    fireEvent.click(reopened.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeDisabled();
    act(() => mocks.store!.setState((state) => ({ runHistory: state.runHistory.map((run, i) => i === 0 ? { ...run, status: 'complete' } : run) })));
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('releases failed authoring reservations and displays a retryable error', async () => {
    mocks.author.mockResolvedValueOnce({ modelNodeIds: [], allNodeIds: [] });
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.store!.getState().messageNotice?.text).toContain('Nebula couldn’t start the generation. Its nodes weren’t added to the canvas.'));
    expect(mocks.store!.getState().createLaunchingIds).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    // The next Generate takes back the line it showed.
    expect(mocks.store!.getState().messageNotice).toBeNull();
  });

  it('GM r10 (3): the cluster refused only for this tab says GM\'s line, nodes not added', async () => {
    mocks.author.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'person_required' }));
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.store!.getState().messageNotice?.text).toBe('Nebula couldn’t start the generation. Its nodes weren’t added to the canvas. This change needs your OK, and this tab isn’t connected as you. Open the link Nebula printed when it started, then try again.'));
  });

  it('GM r13 (1): a start refused after the cluster was added says the nodes are there, and never try again', async () => {
    mocks.execute.mockImplementationOnce(() => { throw Object.assign(new Error('refused'), { code: 'person_required' }); });
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.store!.getState().messageNotice?.text).toBe('Nebula added the nodes to the canvas but couldn’t start the generation because this tab isn’t connected as you. Open the link Nebula printed when it started, then run them from the canvas.'));
    // Never "try again": a second Generate would add the nodes again.
    expect(mocks.store!.getState().messageNotice?.text).not.toMatch(/try again/i);
    expect(view.queryByRole('button', { name: /try again|retry/i })).toBeNull();
    // The promote re-runs nothing: the nodes are on the canvas, and the person runs them there.
    const { notePersonPromoted } = await import('../../src/lib/personSession');
    act(() => notePersonPromoted());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mocks.author).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('a new Generate takes back only its own line (another screen\'s notice stays)', async () => {
    mocks.author.mockResolvedValueOnce({ modelNodeIds: [], allNodeIds: [] });
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.store!.getState().messageNotice?.text).toContain('Nebula couldn’t start the generation.'));
    act(() => mocks.store!.setState({ messageNotice: { id: 7, text: 'Another line.', tone: 'info' } }));
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    expect(mocks.store!.getState().messageNotice?.text).toBe('Another line.');
  });

  it('retains a cancelled authoring reservation across visits and never executes its delayed cluster', async () => {
    let finish!: (value: { modelNodeIds: string[]; allNodeIds: string[] }) => void;
    mocks.author.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Generate' }));
    fireEvent.click(view.getByRole('button', { name: 'Stop preparing generation' }));
    expect(mocks.store!.getState().createLaunchingIds).toHaveLength(1);
    expect(view.getByRole('button', { name: 'Cancelling preparation' })).toBeDisabled();
    view.unmount();
    const reopened = render(<CreateView />);
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(reopened.getByRole('button', { name: 'Cancelling preparation' })).toBeDisabled();
    await act(async () => { finish({ modelNodeIds: ['model'], allNodeIds: ['model'] }); });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.store!.getState().createLaunchingIds).toHaveLength(0);
    expect(mocks.store!.getState().createCancelledLaunchIds).toHaveLength(0);
    expect(reopened.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('offers scoped Stop with cancelling state and opens persistent history on Canvas', () => {
    mocks.store!.setState({ runHistory: [{ id: 'run-one', status: 'running', createOrigin: origin('one') }] });
    const view = render(<CreateView />);
    fireEvent.click(view.getByRole('button', { name: 'Stop generation 1' }));
    expect(mocks.cancel).toHaveBeenCalledWith('run-one');
    act(() => mocks.store!.setState({ activeRuns: [{ id: 'run-one', status: 'cancelling' }] }));
    expect(view.getByRole('button', { name: 'Cancelling generation 1' })).toBeDisabled();
    fireEvent.click(view.getByRole('button', { name: 'History' }));
    expect(mocks.exit).toHaveBeenCalled();
    expect(mocks.dock).toHaveBeenCalledWith('history');
  });
});
