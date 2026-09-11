import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import {
  collectDownloadableOutputs,
  downloadSelectedOutputs,
  selectedNodeIds,
} from '../../src/lib/canvasSelection';
import { GRAPH_BUNDLE_MAX_ASSET_BYTES } from '../../src/lib/graphFile';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});


function node(
  id: string,
  selected: boolean,
  outputs: NodeData['outputs'] = {},
): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    selected,
    data: {
      label: `Node ${id}`,
      definitionId: 'text-input',
      params: {},
      outputs,
      state: 'idle',
    },
  };
}


describe('canvas selection context', () => {
  it('returns selected IDs in canvas order', () => {
    expect(selectedNodeIds([node('n2', true), node('n1', false), node('n3', true)]))
      .toEqual(['n2', 'n3']);
  });

  it('collects only downloadable URL outputs', () => {
    const nodes = [node('n1', true, {
      image: { type: 'Image', value: '/api/outputs/example.png' },
      text: { type: 'Text', value: 'not a URL' },
      gallery: { type: 'Array', value: [
        '/api/outputs/a.png',
        'https://cdn.example.com/b.png',
      ] },
    })];

    expect(collectDownloadableOutputs(nodes).map((output) => output.url)).toEqual([
      '/api/outputs/example.png',
      '/api/outputs/a.png',
      'https://cdn.example.com/b.png',
    ]);
  });

  it('does not mistake base64/data values for downloadable URLs', () => {
    expect(collectDownloadableOutputs([node('n1', true, {
      image: { type: 'Image', value: 'data:image/png;base64,AAAA' },
    })])).toEqual([]);
  });

  it('collects and deduplicates materialized assets from a structured World output', () => {
    const worldValue = {
      schemaVersion: 1,
      provider: 'worldlabs',
      worldId: 'world-123',
      model: 'marble-1.1',
      displayName: 'Courtyard',
      promptType: 'text',
      assets: {
        splats: {
          '100k': '/api/outputs/world-100k.spz',
          '150k': '/api/outputs/world-150k.spz',
          '500k': '/api/outputs/world-500k.spz',
          future_lod: '/api/outputs/world-future.spz',
          'future/v2?quality=max': '/api/outputs/world-future-punctuated.spz',
        },
        panorama: '/api/outputs/panorama.jpg',
        colliderMesh: '/api/outputs/collider.glb',
        thumbnail: '/api/outputs/thumb.jpg',
      },
      semantics: { coordinateFrame: 'marble_raw_opencv' },
    };
    const outputs: NodeData['outputs'] = {
      world: { type: 'World', value: worldValue },
      thumbnail: { type: 'Image', value: '/api/outputs/thumb.jpg' },
    };

    expect(collectDownloadableOutputs([node('n1', true, outputs)]).map((output) => output.url)).toEqual([
      '/api/outputs/world-100k.spz',
      '/api/outputs/world-150k.spz',
      '/api/outputs/world-500k.spz',
      '/api/outputs/world-future.spz',
      '/api/outputs/world-future-punctuated.spz',
      '/api/outputs/panorama.jpg',
      '/api/outputs/collider.glb',
      '/api/outputs/thumb.jpg',
    ]);
  });

  it('refuses an oversized selected output before buffering it into a ZIP', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { 'Content-Length': String(GRAPH_BUNDLE_MAX_ASSET_BYTES + 1) },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadSelectedOutputs([node('n1', true, {
      world: {
        type: 'World',
        value: {
          schemaVersion: 1,
          provider: 'worldlabs',
          worldId: 'world-123',
          assets: { splats: { full_res: '/api/outputs/world-full.spz' } },
          semantics: { coordinateFrame: 'marble_raw_opencv' },
        },
      },
    })])).rejects.toThrow('exceeds the safe ZIP size limit');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/outputs/world-full.spz',
      { cache: 'no-store' },
    );
  });
});
