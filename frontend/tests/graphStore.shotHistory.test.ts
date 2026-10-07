import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../src/types';
import { useGraphStore } from '../src/store/graphStore';
import { serializeGraph, deserializeGraph } from '../src/lib/graphFile';
import { freezeRunSnapshot, type RunRecord } from '../src/lib/runHistory';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
const initial = { ...useGraphStore.getState() };

afterEach(() => {
  useGraphStore.getState().resetExecution();
  useGraphStore.setState(initial, true);
  localStorage.clear();
});

describe('Cinema deleted-shot results', () => {
  it.each(['removeShot', 'updateScene'] as const)('prunes only removed active outputs through %s and leaves history intact', (action) => {
    const scene: CinemaSceneSpec = {
      version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9', shots: [
        { id: 'removed', prompt: 'Original', output: { status: 'done', imageUrl: '/api/outputs/removed.png' } },
        { id: 'kept', prompt: 'Keep', output: { status: 'done', imageUrl: '/api/outputs/kept.png' },
          variations: [{ url: '/api/outputs/kept.png', seed: 42 }], selectedVariation: 0 },
      ],
    };
    const nodes: Node<NodeData>[] = [{
      id: 'scene-local', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
      data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene }, state: 'complete',
        outputs: {
          shot_removed: { type: 'Image', value: '/api/outputs/removed.png' },
          shot_kept: { type: 'Image', value: '/api/outputs/kept.png' },
        } },
    }, { id: 'target-local', position: { x: 400, y: 0 }, data: {
      label: 'Target', definitionId: 'nano-banana', params: {}, outputs: {}, state: 'idle',
    } }];
    const edges: Edge[] = ['removed', 'kept'].map((shot) => ({ id: shot, source: 'scene-local',
      sourceHandle: `shot_${shot}`, target: 'target-local', targetHandle: 'images', type: 'typed-edge', data: { portType: 'Image' } }));
    const history: RunRecord[] = [{ id: 'older-run', trigger: 'shot', startedAt: 1, status: 'complete',
      cinemaShot: { nodeId: 'scene-local', shotId: 'removed' },
      snapshot: freezeRunSnapshot({ nodes: [{ id: 'scene-local', definitionId: 'cinema-scene', params: { scene }, outputs: {} }], edges: [] }),
      resultOutputs: { 'scene-local': { shot_removed: { type: 'Image', value: '/api/outputs/removed.png' } } },
    }];
    useGraphStore.setState({ nodes, edges, runHistory: history });
    if (action === 'removeShot') useGraphStore.getState().removeShot('scene-local', 'removed');
    else useGraphStore.getState().updateScene('scene-local', { ...scene, shots: [scene.shots[1]] });
    const current = useGraphStore.getState();
    expect(current.nodes[0].data.outputs).toEqual({ shot_kept: nodes[0].data.outputs.shot_kept });
    expect(current.edges.map((edge) => edge.id)).toEqual(['kept']);
    expect(current.runHistory).toBe(history);
    expect(current.runHistory[0].snapshot.nodes[0].params.scene).toEqual(scene);
    expect(current.runHistory[0].resultOutputs?.['scene-local'].shot_removed.value).toBe('/api/outputs/removed.png');
    const restored = deserializeGraph(serializeGraph(current.nodes, current.edges, { x: 0, y: 0, zoom: 1 }));
    expect(restored.nodes[0].data.outputs).toEqual(current.nodes[0].data.outputs);
    expect(restored.nodes[0].data.params.scene).toEqual({ ...scene, shots: [scene.shots[1]] });
    expect(restored.nodes[0].data.dynamicOutputPorts).toEqual([{ id: 'shot_kept', label: 'Shot 1', dataType: 'Image', required: false }]);
    expect(restored.edges).toEqual(current.edges);
  });
});
