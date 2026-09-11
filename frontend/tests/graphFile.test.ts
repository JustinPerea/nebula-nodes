import JSZip from 'jszip';
import * as backend from '../src/lib/backend';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import {
  addGraphAssetsToBundle,
  assertGraphComplexityWithinLimits,
  deserializeGraph,
  GRAPH_BUNDLE_MAX_ASSET_MEMBERS,
  GRAPH_BUNDLE_MAX_IMPORT_BYTES,
  GRAPH_MAX_DEPTH,
  GRAPH_MAX_NODES,
  GRAPH_MAX_VALUES,
  GRAPH_JSON_MAX_IMPORT_BYTES,
  loadFromFile,
  loadViaInput,
  normalizeRuntimeMediaParams,
  saveToFile,
  serializeGraph,
  type NebulaFile,
} from '../src/lib/graphFile';
import { readBoundedAssetResponse } from '../src/lib/boundedAsset';
import {
  spatialFixtureByType,
  worldV2Fixture,
} from './fixtures/spatialValues';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'showOpenFilePicker');
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

describe('graph file runtime media metadata', () => {
  it('moves legacy probe fields on provider nodes into the private namespace', () => {
    expect(normalizeRuntimeMediaParams('gemini-omni-flash', {
      task: 'text_to_video',
      sourceDuration: 3.008,
      sourceFps: 24,
      sourceIsVfr: false,
    })).toEqual({
      task: 'text_to_video',
      _sourceDuration: 3.008,
      _sourceFps: 24,
      _sourceIsVfr: false,
    });
  });

  it('keeps declared Video Edit state as declared params', () => {
    const params = {
      sourceDuration: 8,
      sourceFps: 30,
      sourceIsVfr: false,
    };
    expect(normalizeRuntimeMediaParams('video-edit', params)).toEqual(params);
  });

  it('normalizes both future saves and legacy loads', () => {
    const node = {
      id: 'n1',
      type: 'model-node',
      position: { x: 10, y: 20 },
      data: {
        label: 'Gemini Omni Flash',
        definitionId: 'gemini-omni-flash',
        params: { task: 'text_to_video', sourceDuration: 4 },
        outputs: {},
        state: 'idle',
      },
    } as Node<NodeData>;

    const serialized = serializeGraph([node], []);
    expect(serialized.nodes[0].data.params).toEqual({
      task: 'text_to_video',
      _sourceDuration: 4,
    });

    const legacy = {
      ...serialized,
      version: 3,
      nodes: [{
        ...serialized.nodes[0],
        data: {
          ...serialized.nodes[0].data,
          params: { task: 'text_to_video', sourceDuration: 4 },
        },
      }],
    } as NebulaFile;
    const loaded = deserializeGraph(legacy);
    expect(loaded.nodes[0].data.params).toEqual({
      task: 'text_to_video',
      _sourceDuration: 4,
    });
  });
});

describe('portable graph asset bounds', () => {
  function worldFile(splats: Record<string, string>): NebulaFile {
    return {
      version: 3,
      name: 'World graph',
      createdAt: '2026-09-03T00:00:00.000Z',
      nodes: [{
        id: 'world-1',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          outputs: {
            world: {
              type: 'World',
              value: {
                schemaVersion: 1,
                provider: 'worldlabs',
                worldId: 'world-123',
                assets: { splats },
              },
            },
          },
        },
      }],
      edges: [],
    };
  }

  it('preserves a strict World v2 value through plain graph load', async () => {
    const graph = worldFile({});
    graph.version = 2;
    graph.nodes[0].data.outputs = {
      world: {
        type: 'World',
        value: worldV2Fixture as unknown as Record<string, unknown>,
      },
    };
    const file = new Blob([JSON.stringify(graph)], { type: 'application/json' }) as File;
    vi.stubGlobal('fetch', vi.fn());
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    const result = await loadFromFile();

    expect(result?.nodes[0].data.outputs.world.value).toEqual(worldV2Fixture);
    expect(result?.warnings).toEqual([]);
  });

  it('preserves every non-World spatial port through save and plain graph load', async () => {
    const entries = Object.entries(spatialFixtureByType)
      .filter(([type]) => type !== 'World');
    const nodes = entries.map(([type, value], index) => ({
      id: `spatial-${index}`,
      type: 'model-node',
      position: { x: index * 20, y: 0 },
      data: {
        label: `${type} fixture`,
        definitionId: 'spatial-value-validate',
        params: { expected_type: type },
        outputs: {
          value: {
            type,
            value: value as unknown as Record<string, unknown>,
          },
        },
        state: 'complete' as const,
      },
    })) as Node<NodeData>[];
    const serialized = serializeGraph(nodes, []);
    const file = new Blob(
      [JSON.stringify({ ...serialized, version: 2 })],
      { type: 'application/json' },
    ) as File;
    vi.stubGlobal('fetch', vi.fn());
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    const result = await loadFromFile();

    expect(result?.warnings).toEqual([]);
    expect(result?.nodes).toHaveLength(entries.length);
    entries.forEach(([type, value], index) => {
      expect(result?.nodes[index].data.outputs.value.type).toBe(type);
      expect(result?.nodes[index].data.outputs.value.value).toEqual(value);
    });
  });

  it.each(Object.entries(spatialFixtureByType))('preserves the node but removes malformed %s output on import', async (type, value) => {
    const graph = {
      version: 2,
      name: 'Spatial malformed output fixture',
      createdAt: new Date(0).toISOString(),
      nodes: [{ id: 'invalid-spatial', type: 'model-node', position: { x: 0, y: 0 }, data: {
        label: 'Retain this node', definitionId: 'spatial-value-validate',
        params: { expected_type: type }, state: 'complete',
        outputs: { value: { type, value: { ...value, schemaVersion: true } } },
      } }], edges: [],
    };
    const file = new Blob([JSON.stringify(graph)], { type: 'application/json' }) as File;
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });
    const result = await loadFromFile();
    expect(result?.nodes).toHaveLength(1);
    expect(result?.nodes[0].data.label).toBe('Retain this node');
    expect(result?.nodes[0].data.outputs.value).toBeUndefined();
    expect(result?.warnings.length).toBeGreaterThan(0);
  });

  it('fetches World variants sequentially and keeps ordinary assets in the ZIP', async () => {
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6])));
    vi.stubGlobal('fetch', fetchMock);
    const zip = new JSZip();
    const pending = addGraphAssetsToBundle(zip, worldFile({
      '100k': '/api/outputs/run/world-100k.spz',
      '500k': '/api/outputs/run/world-500k.spz',
    }), { maxAssetBytes: 32, maxTotalBytes: 64 });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFirst(new Response(new Uint8Array([1, 2, 3])));
    const summary = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ included: 2, skipped: 0, totalBytes: 6 });
    expect(zip.file('assets/run/world-100k.spz')).not.toBeNull();
    expect(zip.file('assets/run/world-500k.spz')).not.toBeNull();
  });

  it('enforces the aggregate byte ceiling even when responses omit Content-Length', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]))));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const summary = await addGraphAssetsToBundle(new JSZip(), worldFile({
      '100k': '/api/outputs/run/world-100k.spz',
      '500k': '/api/outputs/run/world-500k.spz',
    }), { maxAssetBytes: 4, maxTotalBytes: 5 });

    expect(summary).toEqual({ included: 1, skipped: 1, totalBytes: 3 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('byte allowance'));
  });

  it('rejects traversing and non-portable local references before fetch or ZIP insertion', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const zip = new JSZip();
    const summary = await addGraphAssetsToBundle(zip, worldFile({
      raw_dot: '/api/outputs/../settings',
      backslash: '/api/outputs/..\\settings',
      backslash_prefix: String.raw`/api\outputs\run\world.spz`,
      encoded_prefix: '/api%2Foutputs/run/world.spz',
      encoded_prefix_with_bad_suffix: '/api%2Foutputs/run/%FF.spz',
      encoded_dot: '/api/outputs/%2e%2e/settings',
      double_encoded_dot: '/api/outputs/%252e%252e/settings',
      absolute_encoded_dot: 'http://localhost:8000/api/outputs/%2e%2e/settings',
      absolute_backslash: String.raw`http:\localhost:8000\api\outputs\run\world.spz`,
      absolute_single_slash: 'http:/localhost:8000/api/outputs/run/world.spz',
      protocol_relative: '//localhost:8000/api/outputs/run/world.spz',
      network_backslash: String.raw`\\localhost:8000\api\outputs\run\world.spz`,
      encoded_slash: '/api/outputs/run%2Fsecret.txt',
      query: '/api/outputs/run/world.spz?secret=true',
      fragment: '/api/outputs/run/world.spz#fragment',
      encoded_hash: '/api/outputs/run/world%23fragment.spz',
      encoded_control: '/api/outputs/run/world%00.spz',
      reserved_name: '/api/outputs/run/CON.glb',
      prototype_component: '/api/outputs/run/constructor/asset.spz',
      folded_prototype: '/api/outputs/run/conſtructor/asset.spz',
      nonportable_colon: '/api/outputs/run/world:preview.spz',
      doubled_slash: '/api/outputs/run//world.spz',
      lone_surrogate: '/api/outputs/run/world\ud800.spz',
    }), { maxAssetBytes: 32, maxTotalBytes: 64 });

    expect(summary).toEqual({ included: 0, skipped: 23, totalBytes: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Object.keys(zip.files)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(21); // 20 bounded samples + one aggregate warning
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('3 additional unsafe'));
  });

  it('canonicalizes Unicode and spaces into a portable asset member', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    const zip = new JSZip();

    const summary = await addGraphAssetsToBundle(zip, worldFile({
      '500k': '/api/outputs/run/caf%C3%A9%20grove.spz',
    }), { maxAssetBytes: 32, maxTotalBytes: 64 });

    expect(summary).toEqual({ included: 1, skipped: 0, totalBytes: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/outputs/run/caf%C3%A9%20grove.spz',
      { cache: 'no-store' },
    );
    expect(zip.file('assets/run/caf%C3%A9%20grove.spz')).not.toBeNull();
  });

  it('skips paths that would collide on a case-insensitive restore filesystem', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const zip = new JSZip();

    const summary = await addGraphAssetsToBundle(zip, worldFile({
      upper: '/api/outputs/run/World.spz',
      lower: '/api/outputs/run/world.spz',
    }), { maxAssetBytes: 32, maxTotalBytes: 64 });

    expect(summary).toEqual({ included: 1, skipped: 1, totalBytes: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(zip.files)).toEqual(['assets/run/World.spz']);
  });

  it('keeps generated ZIP member count within the restore ceiling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const zip = new JSZip();

    const summary = await addGraphAssetsToBundle(zip, worldFile({
      first: '/api/outputs/run/first.spz',
      second: '/api/outputs/run/second.spz',
    }), { maxAssetBytes: 32, maxTotalBytes: 64, maxAssetMembers: 1 });

    expect(summary).toEqual({ included: 1, skipped: 1, totalBytes: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(zip.files)).toEqual(['assets/run/first.spz']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('member ceiling'));
    expect(GRAPH_BUNDLE_MAX_ASSET_MEMBERS).toBe(4095);
  });

  it('rejects a declared oversized response before reading its body', async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { 'Content-Length': '900' },
    });
    await expect(readBoundedAssetResponse(response, 100)).rejects.toThrow('above the 100-byte allowance');
  });

  it('warns after saving a bundle when a referenced World asset was skipped', async () => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-graph');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const graphNode = {
      id: 'world-1',
      type: 'model-node',
      position: { x: 0, y: 0 },
      data: {
        label: 'World Labs Environment',
        definitionId: 'worldlabs-environment',
        params: {},
        outputs: {
          world: {
            type: 'World',
            value: {
              schemaVersion: 1,
              provider: 'worldlabs',
              worldId: 'world-123',
              assets: { splats: { '500k': '/api/outputs/run/world-500k.spz' } },
              semantics: { coordinateFrame: 'marble_raw_opencv' },
            },
          },
        },
        state: 'complete',
      },
    } as Node<NodeData>;

    const summary = await saveToFile([graphNode], []);

    expect(summary).toMatchObject({ included: 0, skipped: 1 });
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining(
      'Graph saved, but 1 referenced asset was not included',
    ));
  });

  it('keeps the fallback blob alive until scheduled cleanup', async () => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:spatial-save');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const callbacks: Array<() => void> = [];
    vi.spyOn(window, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      expect(delay).toBe(1000);
      callbacks.push(callback);
      return 1;
    }) as typeof window.setTimeout);
    await saveToFile([], []);
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(callbacks).toHaveLength(1);
    callbacks[0]();
    expect(revoke).toHaveBeenCalledWith('blob:spatial-save');
  });

  it('refuses an oversized graph.json before asset fetch or compression', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const generateSpy = vi.spyOn(JSZip.prototype, 'generateAsync');
    const node = {
      id: 'large-graph',
      type: 'model-node',
      position: { x: 0, y: 0 },
      data: {
        label: 'Large graph',
        definitionId: 'text-input',
        params: { text: 'x'.repeat(GRAPH_JSON_MAX_IMPORT_BYTES) },
        outputs: {},
        state: 'idle',
      },
    } as Node<NodeData>;

    await expect(saveToFile([node], [])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('portable limit'));
  });

  it('refuses too many live nodes before mapping or compression', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const generateSpy = vi.spyOn(JSZip.prototype, 'generateAsync');
    const node = {
      id: 'repeated',
      type: 'model-node',
      position: { x: 0, y: 0 },
      data: {
        label: 'Text',
        definitionId: 'text-input',
        params: {},
        outputs: {},
        state: 'idle',
      },
    } as Node<NodeData>;

    await expect(saveToFile(new Array(GRAPH_MAX_NODES + 1).fill(node), [])).resolves.toBeNull();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('more than 10,000 nodes'));
  });

  it('refuses a generated bundle larger than its own import ceiling', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(JSZip.prototype, 'generateAsync').mockResolvedValue({
      size: GRAPH_BUNDLE_MAX_IMPORT_BYTES + 1,
    } as Blob);
    const createUrl = vi.spyOn(URL, 'createObjectURL');

    await expect(saveToFile([], [])).resolves.toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('finished bundle'));
  });

  it('stores generated members without creating a restore-rejected compression ratio', async () => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    const generateSpy = vi.spyOn(JSZip.prototype, 'generateAsync');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-graph');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await expect(saveToFile([], [])).resolves.toEqual({
      included: 0,
      skipped: 0,
      totalBytes: 0,
    });
    expect(generateSpy).toHaveBeenCalledWith({ type: 'blob', compression: 'STORE' });
  });
});

describe('graph structural complexity', () => {
  it('matches the backend node ceiling before walking individual nodes', () => {
    expect(() => assertGraphComplexityWithinLimits({
      nodes: new Array(GRAPH_MAX_NODES + 1).fill(null),
      edges: [],
    })).toThrow(`more than ${GRAPH_MAX_NODES.toLocaleString()} nodes`);
  });

  it('rejects a graph deeper than the backend restore ceiling without recursion', () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < GRAPH_MAX_DEPTH + 1; index += 1) {
      nested = { next: nested };
    }
    expect(() => assertGraphComplexityWithinLimits(nested)).toThrow(
      `more than ${GRAPH_MAX_DEPTH} levels deep`,
    );
  });

  it('rejects circular live graph values before JSON serialization', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => assertGraphComplexityWithinLimits(circular)).toThrow('circular value');
  });

  it('rejects a wide sparse live value at the backend value ceiling', () => {
    expect(() => assertGraphComplexityWithinLimits(
      new Array(GRAPH_MAX_VALUES + 1),
    )).toThrow(`more than ${GRAPH_MAX_VALUES.toLocaleString()} values`);
  });
});

describe('graph import memory ceiling', () => {
  function oversizedFile() {
    return {
      size: GRAPH_BUNDLE_MAX_IMPORT_BYTES + 1,
      arrayBuffer: vi.fn(),
    } as unknown as File;
  }

  it('rejects an oversized File System Access selection before arrayBuffer()', async () => {
    const file = oversizedFile();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Nebula can safely open bundles up to'));
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  it('rejects an oversized fallback input selection before arrayBuffer()', async () => {
    const file = oversizedFile();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function triggerSelection() {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.onchange?.(new Event('change'));
    });

    await expect(loadViaInput()).resolves.toBeNull();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Nebula can safely open bundles up to'));
  });

  it('applies a smaller parse-memory ceiling to plain JSON after signature inspection', async () => {
    const fullRead = vi.fn();
    const file = {
      size: GRAPH_JSON_MAX_IMPORT_BYTES + 1,
      slice: vi.fn().mockReturnValue(new Blob([new Uint8Array([0x7b, 0x22, 0x76, 0x65])])),
      arrayBuffer: fullRead,
    } as unknown as File;
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(file.slice).toHaveBeenCalledWith(0, 4);
    expect(fullRead).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('safely parse JSON graphs up to'));
  });

  function zipSelection(): File {
    return new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])], {
      type: 'application/zip',
    }) as File;
  }

  function validRestoredGraph(): NebulaFile {
    return {
      version: 3,
      name: 'Restored graph',
      createdAt: '2026-09-03T00:00:00.000Z',
      nodes: [{
        id: 'world-1',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          outputs: {},
          state: 'idle',
        },
      }],
      edges: [],
    };
  }

  function restoredGraphWithSplats(splats: Record<string, string>): NebulaFile {
    const graph = validRestoredGraph();
    graph.nodes[0].data.outputs = {
      world: {
        type: 'World',
        value: {
          schemaVersion: 1,
          provider: 'worldlabs',
          worldId: 'restored-world',
          assets: { splats },
        },
      },
    };
    graph.nodes[0].data.state = 'complete';
    return graph;
  }

  it('posts a ZIP to the bounded backend restore path without browser decompression', async () => {
    const file = zipSelection();
    const fullRead = vi.spyOn(file, 'arrayBuffer');
    const loadAsync = vi.spyOn(JSZip, 'loadAsync');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      graph: validRestoredGraph(),
      urlMapping: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    await expect(loadFromFile()).resolves.toMatchObject({
      nodes: [expect.objectContaining({ id: 'world-1' })],
      edges: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/outputs/restore',
      expect.objectContaining({ method: 'POST', body: expect.any(Blob) }),
    );
    expect(loadAsync).not.toHaveBeenCalled();
    expect(fullRead).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed graph returned by restore before deserializing it', async () => {
    const malformedGraph = {
      ...validRestoredGraph(),
      nodes: [null],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      graph: malformedGraph,
      urlMapping: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(zipSelection()) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('nodes[0] must be an object'));
  });

  it('uses own mapping entries and marks inherited or missing local paths unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      graph: restoredGraphWithSplats({
        inherited: '/api/outputs/toString',
        stale: '/api/outputs/old-run/world.spz',
      }),
      urlMapping: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(zipSelection()) }]),
    });

    const result = await loadFromFile();
    expect(result?.nodes[0].data.outputs.world).toBeUndefined();
    expect(result?.warnings).toEqual(expect.arrayContaining([
      'Bundled asset unavailable: toString',
      'Bundled asset unavailable: old-run/world.spz',
      '1 invalid World output was made unavailable.',
    ]));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('round-trips a mapped asset whose portable member contains spaces and Unicode', async () => {
    vi.spyOn(backend, 'backendAssetUrlSync').mockImplementation(path => `http://127.0.0.1:8007${path}`);
    const restoredUrl = '/api/outputs/restored/run/caf%25C3%25A9%2520grove.spz';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      graph: restoredGraphWithSplats({
        '500k': '/api/outputs/run/caf%C3%A9%20grove.spz',
      }),
      urlMapping: {
        'run/caf%C3%A9%20grove.spz': restoredUrl,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(zipSelection()) }]),
    });

    const result = await loadFromFile();
    const world = result?.nodes[0].data.outputs.world.value as {
      assets: { splats: Record<string, unknown> };
    };
    expect(world.assets.splats['500k']).toBe(restoredUrl);
    expect(result?.warnings).toEqual([]);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('omits external World assets from a legacy plain JSON import', async () => {
    const graph = restoredGraphWithSplats({
      local: '/api/outputs/old-run/local.spz',
      private: 'http://127.0.0.1:9090/private.spz',
      tracker: 'https://tracker.example/world.spz',
    });
    graph.version = 2;
    const file = new Blob([JSON.stringify(graph)], { type: 'application/json' }) as File;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    const result = await loadFromFile();
    expect(result?.nodes[0].data.outputs.world).toBeUndefined();
    expect(result?.warnings).toContain(
      '2 external World asset references were omitted; only Nebula output assets can be loaded.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects deeply nested legacy JSON before returning it for graph import', async () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < GRAPH_MAX_DEPTH + 1; index += 1) nested = { next: nested };
    const graph = validRestoredGraph();
    graph.version = 2;
    graph.nodes[0].data.params = { _nested: nested };
    const file = new Blob([JSON.stringify(graph)], { type: 'application/json' }) as File;
    vi.stubGlobal('fetch', vi.fn());
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('nested more than'));
  });

  it('keeps client-side envelope validation for legacy plain JSON files', async () => {
    const file = new Blob([
      JSON.stringify({ version: 999, nodes: [], edges: [] }),
    ], { type: 'application/json' }) as File;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Unsupported .nebula file version'));
  });
});
