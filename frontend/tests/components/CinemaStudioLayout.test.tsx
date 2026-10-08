import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import { CinemaStudioView } from '../../src/components/cinema-studio/CinemaStudioView';
import { cinemaConnectedInputs } from '../../src/lib/cinemaInputs';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import type { CinemaSceneSpec, NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
const initialGraph = { ...useGraphStore.getState() };
const initialUI = { ...useUIStore.getState() };
const executeNode = vi.fn(async () => undefined);
const executeShot = vi.fn(async () => undefined);

function spec(prefix = ''): CinemaSceneSpec {
  return { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [
    { id: 'a', prompt: `${prefix}First`, output: { status: 'done', imageUrl: '/first.png' } },
    { id: 'b', prompt: `${prefix}Second` }, { id: 'c', prompt: `${prefix}Third` },
  ] };
}
function node(id: string, definitionId: string, label: string, value?: unknown, handle = 'image'): Node<NodeData> {
  return { id, type: 'modelNode', position: { x: 0, y: 0 }, data: { label, definitionId,
    params: definitionId === 'cinema-scene' ? { scene: spec() } : {}, state: 'idle',
    outputs: value === undefined ? {} : { [handle]: { type: 'Any', value } } } };
}
function graph() {
  const nodes = [node('scene-local', 'cinema-scene', 'Scene'),
    node('photo', 'image-input', 'Portrait', ['/portrait.png', '/profile.png']),
    node('character', 'character', 'Ada', { name: 'Ada', referenceViews: ['/ada.png'] }, 'character'),
    node('rig', 'camera-rig', 'Lens', { focalLength: 50, height: 1.6 }, 'camera_rig'),
    node('refs', 'reference-set', 'Lighting study', { items: [
      { url: '/style.png', role: 'style', weight: 0.8 },
      { url: '/light.png', role: 'lighting', weight: 0.5 },
      { url: '/excluded.png', role: 'identity', weight: 0 },
    ] }, 'reference_set')];
  const edges: Edge[] = ['character_refs', 'character', 'camera_rig', 'reference_set'].map((role, index) => ({
    id: `input-${index}`, source: nodes[index + 1].id, sourceHandle: index === 0 ? 'image' : role,
    target: 'scene-local', targetHandle: role,
  }));
  return { nodes, edges };
}

beforeEach(() => {
  vi.clearAllMocks();
  useGraphStore.setState({ ...initialGraph, ...graph(), activeRuns: [], runHistory: [], undoStack: [], redoStack: [],
    isExecuting: false, isImportingGraph: false, executeNode, executeShot }, true);
  useUIStore.setState({ ...initialUI, cinemaEditorNodeId: 'scene-local', viewMode: 'cinema-editor', canvasFocusRequest: null }, true);
});
afterEach(() => { cleanup(); useGraphStore.setState(initialGraph, true); useUIStore.setState(initialUI, true); localStorage.clear(); });

describe('Cinema connected source inspection', () => {
  it('shows all four source roles and their actual connected output context', () => {
    render(<CinemaStudioView />);
    for (const name of ['Character refs on Canvas: Portrait', 'Character on Canvas: Ada',
      'Camera rig on Canvas: Lens', 'Reference set on Canvas: Lighting study']) {
      expect(screen.getByRole('button', { name: `View ${name}` })).toBeVisible();
    }
    expect(screen.getByText('50 mm · 1.6 m height')).toBeVisible();
    expect(screen.getByText('2 references · Style, Lighting')).toBeVisible();
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });

  it.each(['Character refs on Canvas: Portrait', 'Character on Canvas: Ada',
    'Camera rig on Canvas: Lens', 'Reference set on Canvas: Lighting study'])('views the exact source: %s', (name) => {
    const before = useGraphStore.getState();
    const scene = before.nodes[0].data.params.scene;
    const history = before.runHistory;
    render(<CinemaStudioView />);
    fireEvent.click(screen.getByRole('button', { name: `View ${name}` }));
    const selected = useGraphStore.getState().nodes.filter((candidate) => candidate.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].data.label).toBe(name.split(': ')[1]);
    expect(useUIStore.getState().canvasFocusRequest?.nodeId).toBe(selected[0].id);
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(useGraphStore.getState().nodes[0].data.params.scene).toBe(scene);
    expect(useGraphStore.getState().runHistory).toBe(history);
    expect(useGraphStore.getState().edges).toEqual(before.edges);
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });

  it('exposes a connected source awaiting output without substituting a different port', () => {
    const current = graph();
    current.nodes[1].data.outputs = { other: { type: 'Image', value: '/unconnected.png' } };
    useGraphStore.setState(current);
    const inputs = cinemaConnectedInputs('scene-local', current.nodes, current.edges);
    expect(inputs[0].imageUrls).toEqual([]); expect(inputs[0].summary).toBe('Awaiting output');
    render(<CinemaStudioView />);
    expect(screen.getByText('Awaiting output')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'View Character refs on Canvas: Portrait' }));
    expect(useUIStore.getState().selectedNodeId).toBe('photo');
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('uses static artwork only on a valid image handle and rejects stale/prototype roles', () => {
    const current = graph();
    current.nodes[1].data.outputs = {};
    current.nodes[1].data.params = { filePath: '/actual-static.png' };
    expect(cinemaConnectedInputs('scene-local', current.nodes, current.edges)[0].imageUrls).toEqual(['/actual-static.png']);
    current.edges[0].sourceHandle = 'missing';
    expect(cinemaConnectedInputs('scene-local', current.nodes, current.edges)[0].imageUrls).toEqual([]);
    current.edges[0].targetHandle = 'constructor';
    expect(cinemaConnectedInputs('scene-local', current.nodes, current.edges)).toHaveLength(3);
    current.nodes[0].data.definitionId = 'text-input';
    expect(cinemaConnectedInputs('scene-local', current.nodes, current.edges)).toEqual([]);
    expect(cinemaConnectedInputs('scene-local', current.nodes.slice(1), current.edges)).toEqual([]);
  });

  it('removes disconnected source controls and blocks source viewing during import', () => {
    render(<CinemaStudioView />);
    act(() => useGraphStore.setState({ isImportingGraph: true }));
    fireEvent.click(screen.getByRole('button', { name: 'View Camera rig on Canvas: Lens' }));
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    act(() => useGraphStore.setState({ edges: [] }));
    expect(screen.queryByRole('button', { name: /View Camera rig on Canvas/ })).not.toBeInTheDocument();
    expect(executeNode).not.toHaveBeenCalled();
  });
});

describe('Selected Cinema shot continuity and scope', () => {
  it('shows inherited scene values and updates their summary without running a model', () => {
    render(<CinemaStudioView />);
    expect(screen.getByText('Using scene palette: No palette')).toBeVisible();
    expect(screen.getByText('Using scene film look: No film look')).toBeVisible();
    act(() => useGraphStore.getState().updateScene('scene-local', (current) => ({ ...current,
      palette: { swatches: ['#123456'], strength: 0.4, method: 'reinhard' }, look: { preset: 'fuji-400h' },
    })));
    expect(screen.getByText('Using scene palette: #123456 · 40% · Reinhard')).toBeVisible();
    expect(screen.getByText('Using scene film look: Fuji 400H')).toBeVisible();
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });
  it('shows no colors for a saved palette source image without swatches, matching the skipped color stage', () => {
    useGraphStore.getState().updateScene('scene-local', (current) => ({ ...current,
      palette: { swatches: [], sourceImageUrl: '/palette-source.png', strength: 0.4, method: 'reinhard' },
    }));
    const before = useGraphStore.getState().nodes[0].data.params.scene;
    render(<CinemaStudioView />);
    expect(screen.getByText('Using scene palette: No colors · 40% · Reinhard')).toBeVisible();
    expect(screen.queryByText(/Using scene palette: Reference image/)).not.toBeInTheDocument();
    expect(useGraphStore.getState().nodes[0].data.params.scene).toBe(before);
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });
  it('displays effective defaults for a legacy palette missing keys without adding them to saved authoring', () => {
    const legacy = { swatches: ['#123456'] } as NonNullable<CinemaSceneSpec['palette']>;
    useGraphStore.getState().updateScene('scene-local', (current) => ({ ...current, palette: legacy }));
    const before = useGraphStore.getState().nodes[0].data.params.scene;
    render(<CinemaStudioView />);
    expect(screen.getByText('Using scene palette: #123456 · 70% · Lab')).toBeVisible();
    expect(useGraphStore.getState().nodes[0].data.params.scene).toBe(before);
    expect((before as CinemaSceneSpec).palette).toEqual({ swatches: ['#123456'] });
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });
  it.each(['constructor', 'toString', '__proto__'])('displays the actual unknown saved palette method %s', (method) => {
    const saved = { swatches: ['#123456'], strength: 0.4, method } as NonNullable<CinemaSceneSpec['palette']>;
    useGraphStore.getState().updateScene('scene-local', (current) => ({ ...current, palette: saved }));
    const before = useGraphStore.getState().nodes[0].data.params.scene;
    render(<CinemaStudioView />);
    expect(screen.getByText(`Using scene palette: #123456 · 40% · ${method}`)).toBeVisible();
    expect(useGraphStore.getState().nodes[0].data.params.scene).toBe(before);
    expect((before as CinemaSceneSpec).palette).toEqual(saved);
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });
  it('retains editor scroll during authoring and returns to the top for a different selected shot', () => {
    const view = render(<CinemaStudioView />);
    const panel = view.container.querySelector('.cinema-studio-view__panel') as HTMLDivElement;
    panel.scrollTop = 300;
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Edited at the current scroll position' } });
    expect(panel.scrollTop).toBe(300);
    fireEvent.click(screen.getByRole('button', { name: 'Select Shot 2' }));
    expect(panel.scrollTop).toBe(0);
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });
  it('keeps one scene-wide generate action separate from selected-shot generation', () => {
    render(<CinemaStudioView />);
    expect(screen.getAllByRole('button', { name: 'Generate all' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Generate shot' })).toBeVisible();
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });

  it('selects the neighboring shot after deleting a middle selection and retains surviving outputs', () => {
    render(<CinemaStudioView />);
    fireEvent.click(screen.getByRole('button', { name: 'Select Shot 2' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Second');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Shot 2' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Third');
    expect(screen.getByRole('button', { name: 'Select Shot 2' })).toHaveFocus();
    const scene = useGraphStore.getState().nodes[0].data.params.scene as CinemaSceneSpec;
    expect(scene.shots.map((shot) => shot.id)).toEqual(['a', 'c']);
    expect(scene.shots[0].output?.imageUrl).toBe('/first.png');
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });

  it('does not carry shot selection into a different scene with reused shot IDs', () => {
    const second = node('other-scene', 'cinema-scene', 'Other scene');
    second.data.params.scene = spec('Other ');
    useGraphStore.setState((current) => ({ nodes: [...current.nodes, second] }));
    render(<CinemaStudioView />);
    fireEvent.click(screen.getByRole('button', { name: 'Select Shot 2' }));
    act(() => useUIStore.setState({ cinemaEditorNodeId: 'other-scene' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Other First');
    expect(screen.getByRole('button', { name: 'Select Shot 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(executeNode).not.toHaveBeenCalled(); expect(executeShot).not.toHaveBeenCalled();
  });
});
