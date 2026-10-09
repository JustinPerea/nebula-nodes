import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { DynamicNode } from '../../src/components/nodes/DynamicNode';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import type { DynamicNodeData, NodeData } from '../../src/types';

const transport = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(), apiFetch: transport.apiFetch,
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(), Handle: () => <span />,
}));
vi.mock('../../src/components/nodes/MeshPreview', () => ({ MeshPreview: () => null }));
vi.mock('../../src/components/nodes/RepresentationViewer', () => ({ RepresentationViewer: () => null }));

const INITIAL_UI = useUIStore.getState();
const INITIAL_GRAPH = useGraphStore.getState();
const execute = vi.fn();

function source(patch: Partial<NodeData> = {}, dynamic = false): Node<NodeData> {
  const definition = NODE_DEFINITIONS['runway-video'];
  const data: NodeData = { label: 'Synthetic video', definitionId: definition.id, params: {},
    state: 'complete', outputs: { video: { type: 'Video', value: '/api/outputs/synthetic.mp4' } }, ...patch };
  if (dynamic) Object.assign(data, { isDynamic: true, providerType: 'fal', modelId: 'synthetic-video',
    dynamicInputPorts: definition.inputPorts, dynamicOutputPorts: definition.outputPorts,
    dynamicParams: [], providerMeta: {} } satisfies Partial<DynamicNodeData>);
  return { id: 'n1', type: dynamic ? 'dynamic-node' : 'model-node', position: { x: 10, y: 20 }, selected: true, data };
}

function StoreCard({ dynamic = false }: { dynamic?: boolean }) {
  const value = useGraphStore((state) => state.nodes.find((candidate) => candidate.id === 'n1'));
  if (!value) return null;
  const props = { id: value.id, data: value.data, selected: true } as NodeProps;
  return dynamic ? <DynamicNode {...props} /> : <ModelNode {...props} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  useUIStore.setState({ ...INITIAL_UI, skin: 'slava-restraint', viewMode: 'canvas',
    selectedNodeId: 'n1', commonsEnabled: true }, true);
  useGraphStore.setState({ ...INITIAL_GRAPH, nodes: [source()], edges: [],
    isImportingGraph: false, activeRuns: [], isExecuting: false, executeGraph: execute }, true);
});
afterEach(() => { cleanup(); useUIStore.setState(INITIAL_UI, true); useGraphStore.setState(INITIAL_GRAPH, true); });

describe.each([['ModelNode', false], ['DynamicNode', true]] as const)('%s video edit action', (_name, dynamic) => {
  it('enters editing for this exact source explicitly, preserving source, prior connections and history without execution', () => {
    const original = source({}, dynamic);
    const priorEdge = { id: 'existing', source: 'n1', sourceHandle: 'video', target: 'n2', targetHandle: 'video' };
    useGraphStore.setState({ nodes: [original], edges: [priorEdge] });
    const history = useGraphStore.getState().runHistory;
    render(<StoreCard dynamic={dynamic} />);
    const edit = screen.getByRole('button', { name: 'Edit video' });
    expect(edit).toBeEnabled();
    expect(edit).toHaveClass('nodrag', 'nopan');
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(useGraphStore.getState().nodes).toEqual([original]);
    fireEvent.click(edit);
    const graph = useGraphStore.getState();
    expect(useUIStore.getState().viewMode).toBe('editor');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toBe(original);
    expect(graph.edges[0]).toBe(priorEdge);
    expect(graph.edges[1]).toEqual(expect.objectContaining({ source: 'n1', sourceHandle: 'video',
      target: useUIStore.getState().editorTargetNodeId, targetHandle: 'video_in' }));
    expect(graph.runHistory).toBe(history);
    expect(graph.activeRuns).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(transport.apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    {}, { video: { type: 'Video', value: '' } }, { video: { type: 'Video', value: '  \n ' } },
    { video: { type: 'Image', value: '/wrong-type.png' } }, { video: { type: 'Video', value: 12 } },
    { video: { type: 'Video', value: ['/multiple.mp4'] } }, { unrelated: { type: 'Video', value: '/unconnected.mp4' } },
  ] as NodeData['outputs'][])('does not offer editing for absent, malformed or undeclared output: %j', (outputs) => {
    useGraphStore.setState({ nodes: [source({ outputs }, dynamic)] });
    render(<StoreCard dynamic={dynamic} />);
    expect(screen.queryByRole('button', { name: 'Edit video' })).not.toBeInTheDocument();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(transport.apiFetch).not.toHaveBeenCalled();
  });

  it.each(['idle', 'queued', 'executing', 'error'] as const)('does not offer editing on a %s node with retained outputs', (state) => {
    useGraphStore.setState({ nodes: [source({ state }, dynamic)] });
    render(<StoreCard dynamic={dynamic} />);
    expect(screen.queryByRole('button', { name: 'Edit video' })).not.toBeInTheDocument();
  });

  it('edits only the canonical displayed batch result, without replacing an earlier snapshot', () => {
    const earlier = { video: { type: 'Video' as const, value: '/api/outputs/earlier.mp4' } };
    const latest = source({}, dynamic).data.outputs;
    const value = source({ batchRunId: 'run-a', batchOutputs: [earlier, latest] }, dynamic);
    useGraphStore.setState({ nodes: [value] });
    render(<StoreCard dynamic={dynamic} />);
    expect(screen.queryByRole('button', { name: 'Edit video' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
    expect(screen.getByRole('button', { name: 'Edit video' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit video' }));
    expect(useGraphStore.getState().nodes[0]).toBe(value);
    expect(value.data.batchOutputs).toEqual([earlier, latest]);
    expect(useUIStore.getState().viewMode).toBe('editor');
    expect(transport.apiFetch).not.toHaveBeenCalled();
  });

  it('disables editing while an import owns the graph and resumes after ownership returns', () => {
    useGraphStore.setState({ nodes: [source({}, dynamic)] });
    render(<StoreCard dynamic={dynamic} />);
    act(() => useGraphStore.setState({ isImportingGraph: true }));
    const edit = screen.getByRole('button', { name: 'Edit video' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Wait for the graph import to finish');
    fireEvent.click(edit);
    expect(useUIStore.getState().viewMode).toBe('canvas');
    act(() => useGraphStore.setState({ isImportingGraph: false }));
    expect(edit).toBeEnabled();
  });

  it.each(['source', 'replacement', 'output', 'readiness', 'ownership', 'navigation'] as const)(
    'rechecks current %s before creating an edit node', (change) => {
      useGraphStore.setState({ nodes: [source({}, dynamic)] });
      render(<StoreCard dynamic={dynamic} />);
      const edit = screen.getByRole('button', { name: 'Edit video' });
      edit.addEventListener('click', () => {
        if (change === 'source') useGraphStore.setState({ nodes: [] });
        else if (change === 'replacement') useGraphStore.setState({ nodes: [source({ label: 'Replacement owner' }, dynamic)] });
        else if (change === 'output') useGraphStore.setState({ nodes: [source({ outputs: { video: { type: 'Video', value: '/api/outputs/new.mp4' } } }, dynamic)] });
        else if (change === 'readiness') useGraphStore.setState({ nodes: [source({ state: 'executing' }, dynamic)] });
        else if (change === 'ownership') useGraphStore.setState({ isImportingGraph: true });
        else useUIStore.setState({ viewMode: 'create' });
      }, { capture: true, once: true });
      fireEvent.click(edit);
      expect(useUIStore.getState().editorTargetNodeId).toBeNull();
      expect(useUIStore.getState().viewMode).toBe(change === 'navigation' ? 'create' : 'canvas');
      expect(useGraphStore.getState().nodes.some((node) => node.data.definitionId === 'video-edit')).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(transport.apiFetch).not.toHaveBeenCalled();
    },
  );

  it('supports a native keyboard button and stops pointer/key/click propagation to the canvas', () => {
    const parentPointer = vi.fn(); const parentKey = vi.fn(); const parentClick = vi.fn();
    useGraphStore.setState({ nodes: [source({}, dynamic)] });
    render(<div onPointerDown={parentPointer} onKeyDown={parentKey} onClick={parentClick}><StoreCard dynamic={dynamic} /></div>);
    const edit = screen.getByRole('button', { name: 'Edit video' });
    edit.focus();
    expect(edit).toHaveFocus();
    fireEvent.pointerDown(edit);
    fireEvent.keyDown(edit, { key: 'Enter' });
    fireEvent.click(edit, { detail: 0 });
    expect(parentPointer).not.toHaveBeenCalled();
    expect(parentKey).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
    expect(useUIStore.getState().viewMode).toBe('editor');
  });
});

it('offers editing on an uploaded Video input and reuses an existing connected edit without new graph changes', () => {
  const uploaded = source({ definitionId: 'video-input', params: { _sourceDuration: 3 } });
  useGraphStore.setState({ nodes: [uploaded] });
  const existingEdit = useGraphStore.getState().getOrCreateEditNodeDownstream('n1');
  const originalNodes = useGraphStore.getState().nodes;
  const originalEdges = useGraphStore.getState().edges;
  render(<StoreCard />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit video' }));
  expect(useUIStore.getState().editorTargetNodeId).toBe(existingEdit);
  expect(useGraphStore.getState().nodes).toBe(originalNodes);
  expect(useGraphStore.getState().edges).toBe(originalEdges);
  expect(transport.apiFetch).not.toHaveBeenCalled();
});

it('does not offer editing on a non-video definition or an auxiliary source URI', () => {
  useGraphStore.setState({ nodes: [source({ definitionId: 'nano-banana' })] });
  const view = render(<StoreCard />);
  expect(screen.queryByRole('button', { name: 'Edit video' })).not.toBeInTheDocument();
  act(() => useGraphStore.setState({ nodes: [source({ definitionId: 'veo-3',
    outputs: { source_uri: { type: 'Video', value: 'remote://source' } } })] }));
  view.rerender(<StoreCard />);
  expect(screen.queryByRole('button', { name: 'Edit video' })).not.toBeInTheDocument();
});

it('respects the effective dynamic port schema instead of a stale static Video declaration', () => {
  const changed = source({}, true);
  (changed.data as DynamicNodeData).dynamicOutputPorts = [{ id: 'video', label: 'Caption', dataType: 'Text', required: false }];
  useGraphStore.setState({ nodes: [changed] });
  render(<StoreCard dynamic />);
  expect(screen.queryByRole('button', { name: 'Edit video' })).not.toBeInTheDocument();
});
