import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { serializeGraph, deserializeGraph } from '../src/lib/graphFile';
import { useIsValidConnection } from '../src/hooks/useIsValidConnection';

const flow = vi.hoisted(() => ({ nodes: [] as Node[], edges: [] as Edge[] }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ getNodes: () => flow.nodes, getEdges: () => flow.edges }),
}));
afterEach(() => vi.restoreAllMocks());

function node(id: string, definitionId: string, params: Record<string, unknown>): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, data: {
    definitionId, label: definitionId, state: 'idle', outputs: {}, params,
  } };
}

function savedGraph() {
  return serializeGraph([
    node('camera', 'camera-rig', { height: 1.7, pitch: -20, roll: 12, subjectScreenX: 0 }),
    node('references', 'reference-set', { style_weight: 0.4, identity_weight: 0, pose_weight: 1 }),
    node('character', 'character', { _characterId: 'stored-character', strength_override: 0.35 }),
    node('scene', 'cinema-scene', { scene: {
      version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9',
      character: { refImageUrls: ['/api/uploads/front.png'], strength: 0.7 },
      shots: [{ id: 'opening', prompt: 'Opening frame' }],
    } }),
  ], [
    { id: 'camera-wire', source: 'camera', sourceHandle: 'camera_rig', target: 'scene',
      targetHandle: 'camera_rig', type: 'typed-edge', data: { portType: 'CameraRig' } },
    { id: 'reference-wire', source: 'references', sourceHandle: 'reference_set', target: 'scene',
      targetHandle: 'reference_set', type: 'typed-edge', data: { portType: 'ReferenceSet' } },
    { id: 'character-wire', source: 'character', sourceHandle: 'character', target: 'scene',
      targetHandle: 'character', type: 'typed-edge', data: { portType: 'Character' } },
  ]);
}

describe('saved Cinema art-direction connections', () => {
  it('declares optional typed Cinema ports rather than flattening guidance into images', () => {
    const ports = NODE_DEFINITIONS['cinema-scene'].inputPorts;
    expect(ports.find((port) => port.id === 'camera_rig')).toMatchObject({ dataType: 'CameraRig', required: false });
    expect(ports.find((port) => port.id === 'reference_set')).toMatchObject({ dataType: 'ReferenceSet', required: false });
  });

  it.each([1, 2, 3] as const)('preserves metadata and validates restored typed wires in graph version %s', (version) => {
    const file = savedGraph();
    file.version = version;
    const restored = deserializeGraph(JSON.parse(JSON.stringify(file)));
    expect(restored.edges).toEqual(file.edges);
    for (const saved of file.nodes) {
      expect(restored.nodes.find((node) => node.id === saved.id)?.data.params).toEqual(saved.data.params);
    }
    flow.nodes = restored.nodes;
    // Check fresh connections, with the persisted wires already present too.
    flow.edges = restored.edges;
    const { result } = renderHook(() => useIsValidConnection());
    for (const edge of restored.edges) expect(result.current(edge)).toBe(true);
    expect(result.current({ source: 'camera', sourceHandle: 'camera_rig', target: 'scene', targetHandle: 'reference_set' })).toBe(false);
    expect(result.current({ source: 'references', sourceHandle: 'reference_set', target: 'scene', targetHandle: 'camera_rig' })).toBe(false);
    expect(result.current({ source: 'camera', sourceHandle: 'camera_rig', target: 'scene', targetHandle: 'character_refs' })).toBe(false);
    expect(result.current({ source: 'references', sourceHandle: 'reference_set', target: 'scene', targetHandle: 'character_refs' })).toBe(false);
    // Stored unavailable strength values are retained, including a zero priority.
    expect(restored.nodes.find((node) => node.id === 'references')!.data.params.identity_weight).toBe(0);
    expect(restored.nodes.find((node) => node.id === 'character')!.data.params.strength_override).toBe(0.35);
  });
});
