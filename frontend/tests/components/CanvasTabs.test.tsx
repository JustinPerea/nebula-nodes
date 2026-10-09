import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { CanvasTabs, WorkspaceModeNavigation } from '../../src/components/CanvasTabs';
import { useCreateDraftStore } from '../../src/store/createDraftStore';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore, type ViewMode } from '../../src/store/uiStore';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
const INITIAL_UI = useUIStore.getState();
const INITIAL_GRAPH = useGraphStore.getState();
const INITIAL_DRAFTS = useCreateDraftStore.getState();
const execute = vi.fn();
const author = vi.fn();
const cancel = vi.fn();

function source(): Node<NodeData> {
  return { id: 'selected-video', type: 'modelNode', position: { x: 10, y: 20 }, selected: true,
    data: { label: 'Synthetic video', definitionId: 'runway-video', params: {}, state: 'complete',
      outputs: { video: { type: 'Video', value: '/api/outputs/synthetic.mp4' } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUIStore.setState({ ...INITIAL_UI, viewMode: 'canvas', selectedNodeId: 'selected-video',
    createSessionId: null, commonsEnabled: true }, true);
  useGraphStore.setState({ ...INITIAL_GRAPH, nodes: [source()], edges: [], isImportingGraph: false,
    activeRuns: [], isExecuting: false, executeGraph: execute, authorGenerationCluster: author,
    cancelRun: cancel, cancelCreateGeneration: cancel }, true);
  useCreateDraftStore.setState({ drafts: {} });
});
afterEach(() => {
  cleanup();
  useUIStore.setState(INITIAL_UI, true);
  useGraphStore.setState(INITIAL_GRAPH, true);
  useCreateDraftStore.setState(INITIAL_DRAFTS, true);
});

describe('Canvas and Creator Studio navigation', () => {
  it('shows one current Canvas heading and the two workspace choices without global video editing', () => {
    render(<CanvasTabs />);
    expect(screen.getAllByRole('heading', { name: 'Canvas', level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('navigation', { name: 'Workspace views' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Canvas', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Creator Studio', exact: true })).not.toHaveAttribute('aria-current');
    expect(screen.queryByText('Edit video')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit selected video' })).not.toBeInTheDocument();
  });

  it('switches both ways while preserving the saved draft, graph, selection, running jobs and history', () => {
    useUIStore.setState({ createSessionId: 'kept-session' });
    useGraphStore.setState({
      activeRuns: [{ id: 'accepted-job', kind: 'graph', nodeIds: ['selected-video'], status: 'running' }],
      createLaunchingIds: ['preparing-job'],
      runHistory: [{ id: 'accepted-job', trigger: 'cluster', startedAt: 1, status: 'running',
        snapshot: { nodes: [], edges: [] }, createOrigin: { sessionId: 'kept-session', genId: 'generation',
          prompt: 'Earlier saved recipe', ts: 1, modelNodeIds: ['selected-video'], allNodeIds: ['selected-video'] } }],
    });
    const draft = useCreateDraftStore.getState().getOrCreateDraft('kept-session', {
      modelId: 'nano-banana', prompt: 'Unfinished logo recipe', params: { seed: 42 }, quantity: 2,
      refs: [{ filePath: '/api/outputs/reference.png', previewUrl: '/api/outputs/reference.png' }],
    });
    const graphBefore = useGraphStore.getState();
    render(<WorkspaceModeNavigation />);
    fireEvent.click(screen.getByRole('button', { name: 'Creator Studio', exact: true }));
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'create', createSessionId: 'kept-session', selectedNodeId: 'selected-video' });
    expect(screen.getByRole('button', { name: 'Creator Studio', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Canvas', exact: true })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: 'Canvas', exact: true }));
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', createSessionId: 'kept-session', selectedNodeId: 'selected-video' });
    expect(useCreateDraftStore.getState().drafts['kept-session']).toBe(draft);
    const graphAfter = useGraphStore.getState();
    for (const key of ['nodes', 'edges', 'runHistory', 'activeRuns', 'createLaunchingIds'] as const) {
      expect(graphAfter[key]).toBe(graphBefore[key]);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(author).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does nothing when activating the current mode', () => {
    render(<WorkspaceModeNavigation />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas', exact: true }));
    expect(useUIStore.getState().createSessionId).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Creator Studio', exact: true }));
    const sessionId = useUIStore.getState().createSessionId;
    expect(sessionId).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Creator Studio', exact: true }));
    expect(useUIStore.getState().createSessionId).toBe(sessionId);
    expect(execute).not.toHaveBeenCalled();
    expect(author).not.toHaveBeenCalled();
  });

  it('preserves the same navigation semantics during graph replacement without creating nodes', () => {
    useGraphStore.setState({ isImportingGraph: true });
    const before = useGraphStore.getState().nodes;
    render(<WorkspaceModeNavigation />);
    fireEvent.click(screen.getByRole('button', { name: 'Creator Studio', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Canvas', exact: true }));
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(useGraphStore.getState().nodes).toBe(before);
    expect(useGraphStore.getState().isImportingGraph).toBe(true);
    expect(author).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks current workspace before acting on a stale activation', () => {
    render(<WorkspaceModeNavigation />);
    const create = screen.getByRole('button', { name: 'Creator Studio', exact: true });
    create.addEventListener('click', () => useUIStore.setState({ viewMode: 'editor' }), { capture: true, once: true });
    fireEvent.click(create);
    expect(useUIStore.getState().viewMode).toBe('editor');
    expect(useUIStore.getState().createSessionId).toBeNull();
    expect(author).not.toHaveBeenCalled();
  });

  it('uses disabled Commons as Canvas and reacts when Commons becomes available', () => {
    useUIStore.setState({ viewMode: 'commons', commonsEnabled: false });
    render(<CanvasTabs />);
    expect(screen.getByRole('heading', { name: 'Canvas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Canvas', exact: true })).toHaveAttribute('aria-current', 'page');
    act(() => useUIStore.setState({ commonsEnabled: true }));
    expect(screen.queryByRole('navigation', { name: 'Workspace views' })).not.toBeInTheDocument();
  });

  it.each<ViewMode>(['editor', 'remotion-editor', 'cinema-editor', 'character-editor', 'moodboard-editor', 'commons', 'brand-showcase'])(
    'keeps workspace navigation outside the %s editor', (viewMode) => {
      useUIStore.setState({ viewMode });
      render(<WorkspaceModeNavigation />);
      expect(screen.queryByRole('navigation', { name: 'Workspace views' })).not.toBeInTheDocument();
    },
  );
});
