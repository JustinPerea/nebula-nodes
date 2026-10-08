import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { CinemaStudioView } from '../../src/components/cinema-studio/CinemaStudioView';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import type { CinemaSceneSpec, CinemaShot, NodeData } from '../../src/types';
import type { Node } from '@xyflow/react';

interface SharedProps { onChange: (update: (current: CinemaSceneSpec) => CinemaSceneSpec) => void }
interface ShotProps { onChangeShot: (update: (current: CinemaShot) => CinemaShot) => void }
interface RailProps { onReorder: (shots: CinemaShot[]) => void }
const captured = vi.hoisted(() => ({
  shared: null as SharedProps | null,
  shot: null as ShotProps | null,
  rail: null as RailProps | null,
}));
vi.mock('../../src/components/cinema-studio/CinemaSharedControls', () => ({
  CinemaSharedControls: (props: SharedProps) => { captured.shared = props; return null; },
}));
vi.mock('../../src/components/cinema-studio/CinemaShotPanel', () => ({
  CinemaShotPanel: (props: ShotProps) => { captured.shot = props; return null; },
}));
vi.mock('../../src/components/cinema-studio/CinemaShotsRail', () => ({
  CinemaShotsRail: (props: RailProps) => { captured.rail = props; return null; },
}));
vi.mock('../../src/components/cinema-studio/CinemaStudioToolbar', () => ({ CinemaStudioToolbar: () => null }));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };

function scene(): CinemaSceneSpec {
  return { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
    shots: [{ id: 'a', prompt: 'Original A' }, { id: 'b', prompt: 'Original B' }] };
}

function node(spec: CinemaSceneSpec): Node<NodeData> {
  return { id: 'scene-local', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
    data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene: spec }, state: 'idle', outputs: {
      shot_a: { type: 'Image', value: '/old-result.png' },
    } } };
}

function currentScene(): CinemaSceneSpec {
  return useGraphStore.getState().nodes[0].data.params.scene as CinemaSceneSpec;
}

describe('Cinema Studio current-scene field ownership', () => {
  beforeEach(() => {
    useGraphStore.setState({ ...initialGraph, nodes: [node(scene())], edges: [], isExecuting: false, isImportingGraph: false,
      activeRuns: [], runHistory: [], undoStack: [], redoStack: [] }, true);
    useUIStore.setState({ ...initialUi, cinemaEditorNodeId: 'scene-local' }, true);
    captured.shared = null;
    captured.shot = null;
    captured.rail = null;
  });

  afterEach(() => {
    useGraphStore.setState(initialGraph, true);
    useUIStore.setState(initialUi, true);
    localStorage.clear();
  });

  it('applies retained edit/reorder callbacks to current shot objects and retains newly added shots', () => {
    const original = scene();
    render(<CinemaStudioView />);
    const sharedChange = captured.shared!.onChange;
    const shotChange = captured.shot!.onChangeShot;
    const reorder = captured.rail!.onReorder;
    const latest: CinemaSceneSpec = { ...original, look: { preset: 'bw-tri-x' },
      shots: [{ ...original.shots[0], prompt: 'New A', refImageUrls: ['/new-ref.png'],
        output: { status: 'done', imageUrl: '/new-result.png' }, variations: [{ url: '/new-result.png', seed: 7 }], selectedVariation: 0 },
      original.shots[1], { id: 'c', prompt: 'Added while uploading' }] };
    act(() => useGraphStore.setState({ nodes: [node(latest)] }));
    const history = useGraphStore.getState().runHistory;
    act(() => {
      sharedChange((current) => ({ ...current, aspectRatio: '1:1' }));
      shotChange((current) => ({ ...current, prompt: 'Explicit prompt edit' }));
      reorder([original.shots[1], original.shots[0]]);
    });
    const result = currentScene();
    expect(result.aspectRatio).toBe('1:1');
    expect(result.look).toEqual({ preset: 'bw-tri-x' });
    expect(result.shots.map((shot) => shot.id)).toEqual(['b', 'a', 'c']);
    expect(result.shots[1]).toEqual({ ...latest.shots[0], prompt: 'Explicit prompt edit' });
    expect(result.shots[2]).toEqual(latest.shots[2]);
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual(node(latest).data.outputs);
    expect(useGraphStore.getState().runHistory).toBe(history);
    expect(useGraphStore.getState().activeRuns).toEqual([]);
  });

  it('does not restore a shot removed since an old panel callback was rendered', () => {
    render(<CinemaStudioView />);
    const changeRemovedShot = captured.shot!.onChangeShot;
    act(() => useGraphStore.getState().removeShot('scene-local', 'a'));
    act(() => changeRemovedShot((current) => ({ ...current, refImageUrls: ['/late.png'] })));
    expect(currentScene().shots.map((shot) => shot.id)).toEqual(['b']);
    expect(currentScene().shots[0].refImageUrls).toBeUndefined();
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual({});
  });
});
