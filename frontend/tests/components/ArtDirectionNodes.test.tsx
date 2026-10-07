import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { CameraRigNode } from '../../src/components/nodes/CameraRigNode';
import { ReferenceSetNode } from '../../src/components/nodes/ReferenceSetNode';
import { CinemaSceneNode } from '../../src/components/nodes/CinemaSceneNode';
import { CharacterDefinitionPanel } from '../../src/components/character-studio/CharacterDefinitionPanel';
import type { CharacterDraft } from '../../src/components/character-studio/CharacterStudioView';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { REFERENCE_ROLE_IDS } from '../../src/lib/referenceRoles';
import { freezeRunSnapshot, type RunRecord } from '../../src/lib/runHistory';
import { useGraphStore } from '../../src/store/graphStore';

const requests = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  apiFetch: requests.apiFetch,
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(),
} }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type, 'aria-label': label }: {
    id?: string; type: string; 'aria-label'?: string;
  }) => <span data-testid={`handle-${type}-${id}`} aria-label={label} />,
}));

function node(id: string, definitionId: string, params: Record<string, unknown>): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, data: {
    definitionId, label: definitionId, state: 'idle', outputs: {}, params,
  } };
}

function fixture() {
  const nodes = [
    node('n1', 'camera-rig', { height: 1.7, pitch: 0 }),
    node('n2', 'reference-set', { style_weight: 0.5, identity_weight: 1, pose_weight: 0 }),
    node('n3', 'cinema-scene', { scene: { version: 1, base: { model: 'nano-banana' },
      aspectRatio: '16:9', shots: [{ id: 'opening', prompt: 'An opening shot',
        output: { status: 'done', imageUrl: '/api/outputs/previous.png' },
        variations: [{ url: '/api/outputs/previous.png', seed: 7 }], selectedVariation: 0 }] } }),
    node('n4', 'image', {}),
  ];
  const edges: Edge[] = [
    { id: 'camera-wire', source: 'n1', sourceHandle: 'camera_rig', target: 'n3', targetHandle: 'camera_rig' },
    { id: 'reference-wire', source: 'n2', sourceHandle: 'reference_set', target: 'n3', targetHandle: 'reference_set' },
    ...['style', 'identity', 'pose'].map((role) => ({
      id: `${role}-wire`, source: 'n4', sourceHandle: 'image', target: 'n2', targetHandle: role,
    })),
  ];
  const history: RunRecord[] = [{ id: 'earlier-run', trigger: 'graph', status: 'complete', startedAt: 1,
    snapshot: freezeRunSnapshot({ nodes: nodes.map(({ id, data }) => ({
      id, definitionId: data.definitionId, params: data.params, outputs: data.outputs,
    })), edges }),
    resultOutputs: { n3: { shot_opening: { type: 'Image', value: '/api/outputs/previous.png' } } },
  }];
  return { nodes, edges, history };
}

function propsFor(node: Node<NodeData>): NodeProps {
  return { id: node.id, data: node.data, selected: false } as NodeProps;
}

function LinkedCards() {
  const nodes = useGraphStore((state) => state.nodes);
  return <>
    <CameraRigNode {...propsFor(nodes.find((node) => node.id === 'n1')!)} />
    <ReferenceSetNode {...propsFor(nodes.find((node) => node.id === 'n2')!)} />
  </>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  requests.apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  const { nodes, edges, history } = fixture();
  useGraphStore.setState({ nodes, edges, runHistory: history, activeRuns: [],
    isExecuting: false, isCancelling: false, undoStack: [], redoStack: [] });
});
afterEach(async () => {
  await act(async () => vi.runOnlyPendingTimersAsync());
  vi.useRealTimers();
});

describe('Cinema art-direction cards', () => {
  it('renders every declared Cinema input in a distinct labeled row and keeps shot outputs', () => {
    const scene = useGraphStore.getState().nodes.find((node) => node.id === 'n3')!;
    render(<CinemaSceneNode {...propsFor(scene)} />);
    const handles = NODE_DEFINITIONS['cinema-scene'].inputPorts.map((port) => {
      const handle = screen.getByTestId(`handle-target-${port.id}`);
      expect(handle).toHaveAttribute('aria-label', `${port.label} input`);
      expect(within(handle.parentElement!).getByText(port.label)).toBeInTheDocument();
      return handle;
    });
    expect(handles).toHaveLength(4);
    expect(new Set(handles.map((handle) => handle.parentElement)).size).toBe(4);
    expect(screen.getByTestId('handle-source-shot_opening')).toBeInTheDocument();
  });

  it('shows camera prompt guidance and role priority with zero-priority references excluded', () => {
    const view = render(<LinkedCards />);
    expect(screen.getByText(/camera prompt guidance/)).toHaveTextContent('Models may interpret it differently');
    expect(screen.getByText(/Reference priority sets image order; 0 excludes/)).toBeInTheDocument();
    expect(screen.getAllByRole('slider', { name: /reference priority/ })).toHaveLength(7);
    const preview = view.container.querySelector('.reference-set-node__preview')! as HTMLElement;
    expect(within(preview).getAllByText(/Identity|Style/).map((item) => item.textContent)).toEqual(['Identity', 'Style']);
    expect(within(preview).queryByText('Pose')).toBeNull();
    const handles = REFERENCE_ROLE_IDS.map((role) => screen.getByTestId(`handle-target-${role}`));
    expect(new Set(handles.map((handle) => handle.parentElement)).size).toBe(7);
  });

  it('edits guidance and disconnects inputs without generation or changing earlier results/history', async () => {
    vi.useFakeTimers();
    const history = JSON.stringify(useGraphStore.getState().runHistory);
    const scene = JSON.stringify(useGraphStore.getState().nodes.find((node) => node.id === 'n3')!.data.params);
    render(<LinkedCards />);
    fireEvent.change(screen.getByRole('slider', { name: /Pitch/ }), { target: { value: '30' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Style reference priority' }), { target: { value: '0.9' } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')!.data.params).toMatchObject({ pitch: 30 });
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n2')!.data.params).toMatchObject({ style_weight: 0.9, pose_weight: 0 });
    act(() => useGraphStore.getState().onEdgesChange([
      { type: 'remove', id: 'camera-wire' }, { type: 'remove', id: 'reference-wire' },
    ]));
    expect(useGraphStore.getState().edges.map((edge) => edge.id)).toEqual(['style-wire', 'identity-wire', 'pose-wire']);
    expect(JSON.stringify(useGraphStore.getState().runHistory)).toBe(history);
    expect(JSON.stringify(useGraphStore.getState().nodes.find((node) => node.id === 'n3')!.data.params)).toBe(scene);
    expect(useGraphStore.getState().activeRuns).toEqual([]);
    expect(useGraphStore.getState().isExecuting).toBe(false);
    // Observe the real store transport: only parameter persistence and wire
    // deletion are allowed. No execute/generate endpoint is invoked.
    expect(requests.apiFetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
      ['/api/graph/node/n1', 'PUT'], ['/api/graph/node/n2', 'PUT'],
      ['/api/graph/edge', 'DELETE'], ['/api/graph/edge', 'DELETE'],
    ]);
  });

  it('updates the ordered preview when a priority becomes zero without deleting its image connection', () => {
    const view = render(<LinkedCards />);
    fireEvent.change(screen.getByRole('slider', { name: 'Identity reference priority' }), { target: { value: '0' } });
    const preview = view.container.querySelector('.reference-set-node__preview')! as HTMLElement;
    expect(within(preview).queryByText('Identity')).toBeNull();
    expect(within(preview).getByText('Style')).toBeInTheDocument();
    expect(useGraphStore.getState().edges.some((edge) => edge.id === 'identity-wire')).toBe(true);
  });

  it('shows handler defaults for malformed imported values without rewriting saved metadata', () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => (
      node.id === 'n1' ? { ...node, data: { ...node.data, params: { height: false, subjectDistance: null } } }
        : node.id === 'n2' ? { ...node, data: { ...node.data,
          params: { style_weight: null, identity_weight: false, pose_weight: '' } } }
          : node
    )) }));
    const view = render(<LinkedCards />);
    expect(screen.getByRole('slider', { name: /Height/ })).toHaveValue('1.7');
    expect(screen.getByRole('slider', { name: /Subj m/ })).toHaveValue('3');
    expect(screen.getByRole('slider', { name: 'Identity reference priority' })).toHaveValue('1');
    const preview = view.container.querySelector('.reference-set-node__preview')! as HTMLElement;
    expect(within(preview).getAllByText(/Identity|Style|Pose/).map((item) => item.textContent)).toEqual(['Style', 'Identity', 'Pose']);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')!.data.params.height).toBe(false);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n2')!.data.params.identity_weight).toBe(false);
    expect(requests.apiFetch).not.toHaveBeenCalled();
  });
});

describe('Character strength availability', () => {
  const draft: CharacterDraft = { name: 'Vega', subjectType: 'stylized',
    referenceViews: ['/api/uploads/front.png', '/api/uploads/side.png', '/api/uploads/back.png'],
    frozenTraitString: '  copper coat, exact trait string\n', seed: 7, consistencyStrength: 0.65 };

  it('disables unsupported strength while retaining saved values when other Character fields are edited', () => {
    const onChange = vi.fn();
    render(<CharacterDefinitionPanel draft={draft} thumbnail="" onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: /Consistency strength/ });
    expect(slider).toBeDisabled();
    expect(slider).toHaveValue('0.65');
    expect(slider).toHaveAccessibleDescription(/Strength is unsupported; saved value 0.65 is retained/);
    fireEvent.change(slider, { target: { value: '0.2' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Vega II' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...draft, name: 'Vega II' });
    expect(draft.referenceViews).toEqual(['/api/uploads/front.png', '/api/uploads/side.png', '/api/uploads/back.png']);
    expect(draft.frozenTraitString).toBe('  copper coat, exact trait string\n');
    expect(draft.consistencyStrength).toBe(0.65);
  });
});
