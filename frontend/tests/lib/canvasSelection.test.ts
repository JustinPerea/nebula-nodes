import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import {
  collectDownloadableOutputs,
  downloadSelectedOutputs,
  selectedNodeIds,
} from '../../src/lib/canvasSelection';
import { GRAPH_BUNDLE_MAX_ASSET_BYTES } from '../../src/lib/graphFile';
import { CONNECTION_LOST_COPY, ConnectionLostError, NO_RESPONSE_COPY } from '../../src/lib/errorCopy';

const bounded = vi.hoisted(() => ({ fake: null as null | number }));
vi.mock('../../src/lib/boundedAsset', async (original) => {
  const actual = await original<typeof import('../../src/lib/boundedAsset')>();
  return {
    ...actual,
    // A selection far over the ZIP limit without allocating it: one byte that says it's `fake` bytes.
    readBoundedAssetResponse: async (...args: Parameters<typeof actual.readBoundedAssetResponse>) => {
      if (bounded.fake === null) return actual.readBoundedAssetResponse(...args);
      return Object.defineProperty(new Uint8Array(1), 'byteLength', { value: bounded.fake });
    },
  };
});

afterEach(() => {
  bounded.fake = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});


function node(
  id: string,
  selected: boolean,
  outputs: NodeData['outputs'] = {},
  label = `Node ${id}`,
): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    selected,
    data: {
      label,
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
    })])).rejects.toThrow('Node n1 is too large for the ZIP. Download it on its own.');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/outputs/world-full.spz',
      { cache: 'no-store' },
    );
  });

  // error-copy review: the selection toolbar shows this error as the Download
  // button's title, so it has to be copy, never the browser's "Failed to
  // fetch" or a node/port id.
  describe('download failure copy', () => {
    const selection = () => [node('n1', true, { image: { type: 'Image', value: '/api/outputs/example.png' } })];
    const failure = async () => {
      try {
        await downloadSelectedOutputs(selection());
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected the download to fail');
    };

    it.each([
      ['no answer (fetch TypeError)', () => Promise.reject(new TypeError('Failed to fetch')), CONNECTION_LOST_COPY],
      ['503', () => Promise.resolve(new Response('upstream down', { status: 503 })), NO_RESPONSE_COPY],
      ['429', () => Promise.resolve(new Response('', { status: 429 })), NO_RESPONSE_COPY],
      ['404', () => Promise.resolve(new Response('', { status: 404 })), "That didn't work. Try again, or reload if it keeps happening."],
      ['403', () => Promise.resolve(new Response('', { status: 403 })), "You don't have access to this anymore. Reload to sign in again."],
    ])('%s reads as copy', async (_kind, answer, line) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(answer));
      const error = await failure();
      // Round 2: the Download button's title is one line, "Couldn't {verb} {object}. {reason}".
      expect(error.message).toBe(`Couldn't download the outputs. ${line}`);
      expect(error.message).not.toMatch(/Failed to fetch|n1|image|\d{3}/);
    });

    it('keeps the browser error as the cause of a lost connection', async () => {
      const raw = new TypeError('Failed to fetch');
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(raw)));
      const error = await failure();
      expect(error).toBeInstanceOf(ConnectionLostError);
      expect(error.cause).toBe(raw);
    });
  });

  // Round 2 (GM): "{Node's display name} is too large for the ZIP. Download
  // it on its own." The name shown on the canvas, never n1:image; with no
  // name, its type ("This image…"). And: "Those outputs are too large for one
  // ZIP. Download fewer at a time."
  describe('ZIP size lines name the node as the canvas does', () => {
    const big = () => new Response(new Uint8Array([1]), { headers: { 'Content-Length': String(GRAPH_BUNDLE_MAX_ASSET_BYTES + 1) } });
    it('by its name on the canvas', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => big()));
      await expect(downloadSelectedOutputs([node('n1', true, { image: { type: 'Image', value: '/api/outputs/a.png' } }, 'Hero shot')]))
        .rejects.toThrow(/^Hero shot is too large for the ZIP\. Download it on its own\.$/);
    });
    it.each([['Image', 'image'], ['Video', 'video'], ['World', 'world']])('with no name, by its type: %s', async (type, noun) => {
      vi.stubGlobal('fetch', vi.fn(async () => big()));
      const error = await downloadSelectedOutputs([node('n1', true, { out: { type, value: '/api/outputs/a.bin' } }, '  ')])
        .catch((e: Error) => e);
      expect((error as Error).message).toBe(`This ${noun} is too large for the ZIP. Download it on its own.`);
      expect((error as Error).message).not.toMatch(/n1|out/);
    });
    it('the whole selection over the limit', async () => {
      const graphFile = await import('../../src/lib/graphFileShared');
      bounded.fake = Math.ceil(graphFile.GRAPH_BUNDLE_MAX_TOTAL_BYTES / 2);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(1))));
      const selection = ['n1', 'n2', 'n3'].map((id) => node(id, true, { image: { type: 'Image', value: `/api/outputs/${id}.png` } }));
      await expect(downloadSelectedOutputs(selection)).rejects.toThrow(/^Those outputs are too large for one ZIP\. Download fewer at a time\.$/);
    });
  });
});
