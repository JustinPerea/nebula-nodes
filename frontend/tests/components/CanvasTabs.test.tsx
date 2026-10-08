import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { CanvasTabs } from '../../src/components/CanvasTabs';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
const INITIAL_UI = useUIStore.getState();
const INITIAL_GRAPH = useGraphStore.getState();
const execute = vi.fn();

function source(outputs: NodeData['outputs'] = { video: { type: 'Video', value: '/api/outputs/synthetic.mp4' } }): Node<NodeData> {
  return { id: 'selected-video', type: 'modelNode', position: { x: 10, y: 20 }, selected: true,
    data: { label: 'Synthetic video', definitionId: 'runway-video', params: {}, state: 'complete', outputs } };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ ...INITIAL_UI, viewMode: 'canvas', selectedNodeId: 'selected-video', commonsEnabled: true }, true);
  useGraphStore.setState({ ...INITIAL_GRAPH, nodes: [source()], edges: [], isImportingGraph: false,
    activeRuns: [], isExecuting: false, executeGraph: execute }, true);
});
afterEach(() => { cleanup(); useUIStore.setState(INITIAL_UI, true); useGraphStore.setState(INITIAL_GRAPH, true); });

describe('Canvas video editing action', () => {
  it('opens an editor for the exact selected video only after explicit activation, retaining history', () => {
    const history = useGraphStore.getState().runHistory;
    render(<CanvasTabs />);
    const edit = screen.getByRole('button', { name: 'Edit selected video' });
    expect(edit).toBeEnabled();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(useUIStore.getState().viewMode).toBe('canvas');
    fireEvent.click(edit);
    const graph = useGraphStore.getState();
    expect(useUIStore.getState().viewMode).toBe('editor');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([expect.objectContaining({ source: 'selected-video', sourceHandle: 'video',
      target: useUIStore.getState().editorTargetNodeId, targetHandle: 'video_in' })]);
    expect(graph.runHistory).toBe(history);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { video: { type: 'Video', value: '' } },
    { video: { type: 'Video', value: '  \n ' } },
    { video: { type: 'Image', value: '/wrong-type.png' } },
    { video: { type: 'Video', value: 12 } },
    { video: { type: 'Video', value: ['/multiple.mp4'] } },
    { unrelated: { type: 'Video', value: '/unconnected.mp4' } },
  ] as NodeData['outputs'][])('requires the declared port to contain one real nonblank Video URL: %j', (outputs) => {
    useGraphStore.setState({ nodes: [source(outputs)] });
    render(<CanvasTabs />);
    const edit = screen.getByRole('button', { name: 'Edit selected video' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'The selected node has no video result to edit');
    fireEvent.click(edit);
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it.each(['idle', 'executing', 'error'] as const)('keeps incomplete video sources unavailable: %s', (state) => {
    const pending = source(); pending.data.state = state;
    useGraphStore.setState({ nodes: [pending] });
    render(<CanvasTabs />);
    expect(screen.getByRole('button', { name: 'Edit selected video' })).toBeDisabled();
  });

  it('disables editing during graph replacement and resumes when replacement ownership is released', () => {
    render(<CanvasTabs />);
    act(() => useGraphStore.setState({ isImportingGraph: true }));
    const edit = screen.getByRole('button', { name: 'Edit selected video' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Wait for the graph import to finish');
    fireEvent.click(edit);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    act(() => useGraphStore.setState({ isImportingGraph: false }));
    expect(edit).toBeEnabled();
  });

  it.each(['selection', 'source', 'output', 'ownership', 'navigation'] as const)(
    'rechecks current %s during activation before creating an edit node', (change) => {
      render(<CanvasTabs />);
      const edit = screen.getByRole('button', { name: 'Edit selected video' });
      edit.addEventListener('click', () => {
        if (change === 'selection') useUIStore.setState({ selectedNodeId: null });
        else if (change === 'source') useGraphStore.setState({ nodes: [] });
        else if (change === 'output') useGraphStore.setState({ nodes: [source({})] });
        else if (change === 'ownership') useGraphStore.setState({ isImportingGraph: true });
        else useUIStore.setState({ viewMode: 'create' });
      }, { capture: true, once: true });
      fireEvent.click(edit);
      expect(useUIStore.getState().editorTargetNodeId).toBeNull();
      expect(useUIStore.getState().viewMode).toBe(change === 'navigation' ? 'create' : 'canvas');
      expect(useGraphStore.getState().nodes.some((node) => node.data.definitionId === 'video-edit')).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('uses disabled Commons as the visible Canvas fallback and reacts when Commons becomes available', () => {
    useUIStore.setState({ viewMode: 'commons', commonsEnabled: false });
    render(<CanvasTabs />);
    expect(screen.getByRole('heading', { name: 'Canvas' })).toBeInTheDocument();
    act(() => useUIStore.setState({ commonsEnabled: true }));
    expect(screen.queryByRole('button', { name: 'Edit selected video' })).not.toBeInTheDocument();
  });
});
