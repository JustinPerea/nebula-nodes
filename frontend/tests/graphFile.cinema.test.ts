import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { deserializeGraph, loadFromFile, serializeGraph, type NebulaFile } from '../src/lib/graphFile';
import { useIsValidConnection } from '../src/hooks/useIsValidConnection';

const flow = vi.hoisted(() => ({ nodes: [] as Node[], edges: [] as Edge[] }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ getNodes: () => flow.nodes, getEdges: () => flow.edges }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});

function savedScene(): NebulaFile {
  const nodes: Node<NodeData>[] = [{
    id: 'scene-source', type: 'cinemaSceneNode', position: { x: 10, y: 20 },
    data: {
      label: 'Storyboard', definitionId: 'cinema-scene', state: 'complete',
      params: { scene: { version: 1, base: { model: 'nano-banana' }, shots: [
        { id: 'opening', prompt: 'A green logo',
          output: { status: 'done', imageUrl: '/api/outputs/logo-green.png' },
          variations: [{ url: '/api/outputs/logo-green.png', seed: 7 }], selectedVariation: 0 },
        { id: 'close-up', prompt: 'The logo close up' },
      ] } },
      outputs: { shot_opening: { type: 'Image', value: '/api/outputs/logo-green.png' } },
      // Stale metadata must never override the persisted shot identities.
      isDynamic: true, dynamicOutputPorts: [{ id: 'shot_removed', dataType: 'Image' }],
    },
  }, {
    id: 'image-model', type: 'model-node', position: { x: 400, y: 20 },
    data: { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} },
  }];
  return serializeGraph(nodes, [{ id: 'saved-wire', source: 'scene-source', sourceHandle: 'shot_opening',
    target: 'image-model', targetHandle: 'images', type: 'typed-edge', data: { portType: 'Image' } }],
  { x: 5, y: 6, zoom: 0.8 }, 'Logo shots');
}

function assertReconnectable(restored: ReturnType<typeof deserializeGraph>) {
  flow.nodes = restored.nodes;
  flow.edges = restored.edges;
  const { result } = renderHook(() => useIsValidConnection());
  expect(result.current({ source: 'scene-source', sourceHandle: 'shot_close-up',
    target: 'image-model', targetHandle: 'images' })).toBe(true);
  expect(result.current({ source: 'scene-source', sourceHandle: 'shot_removed',
    target: 'image-model', targetHandle: 'images' })).toBe(false);
  expect(result.current({ source: 'scene-source', sourceHandle: 'shot_opening',
    target: 'image-model', targetHandle: 'prompt' })).toBe(false);
}

describe('saved Cinema connection ports', () => {
  it.each([1, 2, 3] as const)('restores shot identities and saved wires in file version %s', (version) => {
    const file = savedScene();
    file.version = version;
    if (version === 1) {
      delete file.nodes[0].data.outputs;
      delete file.nodes[0].data.state;
    }
    const restored = deserializeGraph(JSON.parse(JSON.stringify(file)));
    expect(restored.nodes[0].id).toBe('scene-source');
    expect(restored.nodes[0].data.params).toEqual(file.nodes[0].data.params);
    expect(restored.nodes[0].data.outputs).toEqual(file.nodes[0].data.outputs ?? {});
    expect(restored.edges).toEqual(file.edges);
    expect(restored.viewport).toEqual(file.viewport);
    expect(restored.nodes[0].data.dynamicOutputPorts).toEqual([
      { id: 'shot_opening', label: 'Shot 1', dataType: 'Image', required: false },
      { id: 'shot_close-up', label: 'Shot 2', dataType: 'Image', required: false },
    ]);
    assertReconnectable(restored);
  });

  it('reconstructs ports through the real JSON file picker path', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(savedScene()));
    const file = new Blob([bytes], { type: 'application/json' });
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: async () => file }]),
    });
    const restored = await loadFromFile();
    expect(restored).not.toBeNull();
    expect(restored!.edges[0].id).toBe('saved-wire');
    assertReconnectable(restored!);
  });

  it('does not invent output ports for an empty or malformed scene', () => {
    for (const scene of [undefined, null, {}, { shots: {} }, { shots: [null, {}, { id: 4 }] }]) {
      const file = savedScene();
      file.nodes[0].data.params = { scene };
      const restored = deserializeGraph(file);
      expect(restored.nodes[0].data.dynamicOutputPorts).toEqual([]);
      expect(restored.edges).toEqual(file.edges);
    }
  });
});
