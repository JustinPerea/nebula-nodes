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
  inspectGraphFileWithinLimit,
  loadFromFile,
  loadViaInput,
  normalizeRuntimeMediaParams,
  readGraphSelection,
  saveToFile,
  serializeGraph,
  type NebulaFile,
} from '../src/lib/graphFile';
import { readBoundedAssetResponse } from '../src/lib/boundedAsset';
import { PROJECT_SAVE_LIMIT_BYTES } from '../src/lib/projectSize';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import {
  spatialFixtureByType,
  worldV2Fixture,
} from './fixtures/spatialValues';

// Error copy round 3f (GM): every alert is a canvas notice now. `noticeSpy`
// records each notice's text, so the checks below read as they did; the
// window.alert stub stays to prove nothing still calls it.
const noticeStops: (() => void)[] = [];
function noticeSpy() {
  const spy = vi.fn();
  vi.spyOn(window, 'alert').mockImplementation(() => { throw new Error('window.alert called'); });
  const listener = (event: Event) => spy((event as CustomEvent<CanvasNoticeDetail>).detail.text);
  window.addEventListener(CANVAS_NOTICE_EVENT, listener);
  noticeStops.push(() => window.removeEventListener(CANVAS_NOTICE_EVENT, listener));
  return spy;
}

afterEach(() => {
  for (const stop of noticeStops.splice(0)) stop();
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

  // A .nebula written by Save graph before the world-save fix carried the
  // tab's display links (http://127.0.0.1:<port>/api/outputs/...). Load graph
  // reads them back as this backend's relative links, so the World survives.
  it('keeps a World whose file holds loopback display links from an older Save graph', async () => {
    const graph = worldFile({});
    graph.version = 2;
    graph.nodes[0].data.outputs = {
      world: { type: 'World', value: worldV2Fixture as unknown as Record<string, unknown> },
      thumbnail: { type: 'Image', value: '/api/outputs/run-w/thumb.png' },
    };
    const text = JSON.stringify(graph).replaceAll('"/api/outputs/', '"http://127.0.0.1:8000/api/outputs/');
    expect(text).toContain('http://127.0.0.1:8000/api/outputs/');

    const result = await readGraphSelection({ file: new Blob([text]) as File, isZip: false });

    expect(result.warnings).toEqual([]);
    expect(result.nodes[0].data.outputs.world.value).toEqual(worldV2Fixture);
    expect(result.nodes[0].data.outputs.thumbnail.value).toBe('/api/outputs/run-w/thumb.png');
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
    const alertSpy = noticeSpy();
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
      'Graph saved without 1 of its files. It may be missing when the graph is opened somewhere else.',
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

  // Q121 a (Justin, 2026-10-24): "Save graph can write a bundle for a
  // project over the limit." The graph inside a bundle may be as large as the
  // bundle itself; only the bundle's ceiling refuses it.
  it('saves a bundle whose graph is over the 16 MiB save limit', async () => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    const alertSpy = noticeSpy();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:big-graph');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const generateSpy = vi.spyOn(JSZip.prototype, 'generateAsync');
    const node = {
      id: 'large-graph',
      type: 'model-node',
      position: { x: 0, y: 0 },
      data: {
        label: 'Large graph',
        definitionId: 'text-input',
        params: { text: 'x'.repeat(PROJECT_SAVE_LIMIT_BYTES) },
        outputs: {},
        state: 'idle',
      },
    } as Node<NodeData>;

    await expect(saveToFile([node], [])).resolves.toMatchObject({ included: 0, skipped: 0 });
    expect(generateSpy).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("names the bundle and its graph after the project", async () => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:named-graph');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const files: string[] = [];
    const fileSpy = vi.spyOn(JSZip.prototype, 'file');
    await saveToFile([], [], undefined, 'Glass: campaign');
    for (const call of fileSpy.mock.calls) if (call[0] === 'graph.json') files.push(String(call[1]));
    expect(names).toEqual(['Glass campaign.nebula.zip']);
    expect(JSON.parse(files[0]).name).toBe('Glass: campaign');
    names.length = 0;
    await saveToFile([], []);
    expect(names).toEqual(['Untitled Graph.nebula.zip']);
  });

  it('refuses a graph past the bundle ceiling before asset fetch or compression', async () => {
    const alertSpy = noticeSpy();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const generateSpy = vi.spyOn(JSZip.prototype, 'generateAsync');
    // A graph.json past the ceiling is too big to build in a test; the save
    // measures the graph's UTF-8 bytes, so that measure stands in for it.
    vi.spyOn(TextEncoder.prototype, 'encode').mockReturnValue({ byteLength: GRAPH_BUNDLE_MAX_IMPORT_BYTES + 1 } as Uint8Array);
    const node = {
      id: 'large-graph',
      type: 'model-node',
      position: { x: 0, y: 0 },
      data: { label: 'Large graph', definitionId: 'text-input', params: { text: 'x' }, outputs: {}, state: 'idle' },
    } as Node<NodeData>;

    await expect(saveToFile([node], [])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith("Nebula couldn’t save the canvas. This graph is 528.0 MB. Nebula opens graphs up to 528 MB.");
  });

  // GM - Design, 2026-10-24: a graph Nebula would open (up to 528 MB) but the
  // browser can't write. Chromium (the desktop app's engine too) caps a
  // string at 2^29 - 24 = 536,870,888 characters, just under 512 MiB, so
  // JSON.stringify of a graph.json past that throws RangeError("Invalid
  // string length") before the 528 MB check can measure it.
  it("a graph too big for the browser's string limit: GM's line, before any asset fetch", async () => {
    const alertSpy = noticeSpy();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const generateSpy = vi.spyOn(JSZip.prototype, 'generateAsync');
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer?: never, space?: string | number) => {
      if (space === 2) throw new RangeError('Invalid string length');
      return stringify(value, replacer, space);
    }) as typeof JSON.stringify);

    await expect(saveToFile([], [])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith("Nebula couldn’t save the canvas. It's too big to save in a browser.");
  });

  it('another failure building graph.json (a stack overflow) keeps the generic line', async () => {
    const alertSpy = noticeSpy();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer?: never, space?: string | number) => {
      if (space === 2) throw new RangeError('Maximum call stack size exceeded');
      return stringify(value, replacer, space);
    }) as typeof JSON.stringify);

    await expect(saveToFile([], [])).resolves.toBeNull();
    expect(alertSpy).toHaveBeenCalledWith("Nebula couldn’t save the canvas. Try again, or reload if it keeps happening.");
  });

  it('refuses too many live nodes before mapping or compression', async () => {
    const alertSpy = noticeSpy();
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
    const alertSpy = noticeSpy();
    vi.spyOn(JSZip.prototype, 'generateAsync').mockResolvedValue({
      size: GRAPH_BUNDLE_MAX_IMPORT_BYTES + 1,
    } as Blob);
    const createUrl = vi.spyOn(URL, 'createObjectURL');

    await expect(saveToFile([], [])).resolves.toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/^Nebula couldn’t save the canvas\. This graph is [\d.]+ MB\. Nebula opens graphs up to \d+ MB\.$/));
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
    const alertSpy = noticeSpy();
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/^Nebula couldn’t load the canvas\. This graph is [\d.]+ MB\. Nebula opens graphs up to \d+ MB\.$/));
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  it('rejects an oversized fallback input selection before arrayBuffer()', async () => {
    const file = oversizedFile();
    const alertSpy = noticeSpy();
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function triggerSelection() {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.onchange?.(new Event('change'));
    });

    await expect(loadViaInput()).resolves.toBeNull();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/^Nebula couldn’t load the canvas\. This graph is [\d.]+ MB\. Nebula opens graphs up to \d+ MB\.$/));
  });

  // Q118 (Justin, 2026-10-23): "Let Load graph open bigger .nebula files (up
  // to the 512 MiB it already allows for a bundle)". A plain JSON file past
  // the 16 MiB save limit is read now; only the bundle's ceiling refuses it
  // before reading, and the shape walk's limits still apply.
  it('reads a plain JSON file over 16 MiB, up to the bundle ceiling', async () => {
    const text = JSON.stringify({ version: 2, name: 'Big', createdAt: '2026-10-23T00:00:00.000Z', nodes: [{
      id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Brief', definitionId: 'text-input', params: { value: 'x'.repeat(PROJECT_SAVE_LIMIT_BYTES) } },
    }], edges: [] });
    const file = new File([text], 'Big campaign.nebula', { type: 'application/json' });
    expect(file.size).toBeGreaterThan(PROJECT_SAVE_LIMIT_BYTES);
    const selection = await inspectGraphFileWithinLimit(file);
    expect(selection).toMatchObject({ isZip: false, name: 'Big campaign.nebula' });
    const loaded = await readGraphSelection(selection);
    expect(loaded.nodes[0].data.params.value).toHaveLength(PROJECT_SAVE_LIMIT_BYTES);
    expect(loaded.fileName).toBe('Big campaign.nebula');
  });

  it('refuses a plain JSON file past the bundle ceiling before reading it', async () => {
    const fullRead = vi.fn();
    const file = {
      size: GRAPH_BUNDLE_MAX_IMPORT_BYTES + 1,
      slice: vi.fn().mockReturnValue(new Blob([new Uint8Array([0x7b, 0x22, 0x76, 0x65])])),
      arrayBuffer: fullRead,
    } as unknown as File;
    await expect(inspectGraphFileWithinLimit(file)).rejects.toThrow(/Nebula opens graphs up to 528 MB\./);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('keeps the shape limits for a big plain JSON file', async () => {
    const node = { id: 'n', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'n', definitionId: 'text-input', params: {} } };
    const text = JSON.stringify({ version: 2, name: 'Many', createdAt: '2026-10-23T00:00:00.000Z',
      nodes: Array.from({ length: 10_001 }, (_, index) => ({ ...node, id: `n${index}` })), edges: [] });
    const selection = await inspectGraphFileWithinLimit(new File([text], 'Many.nebula'));
    await expect(readGraphSelection(selection)).rejects.toThrow(/more than 10,000 nodes/);
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
    const alertSpy = noticeSpy();
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

  it.each([
    // Round 16 (GM: lead with what the person pressed): Load graph's own
    // heading, then the reason, never "(HTTP 503)"; on 1fc3d846 this said
    // "Failed to load graph: Asset restore failed (HTTP 503)", and on fc906cb6
    // "Couldn't restore the asset.".
    [new Response('', { status: 503 }), "Nebula couldn’t load the canvas. Nebula didn't respond. Try again."],
    [new Response('', { status: 400 }), "Nebula couldn’t load the canvas. Try again, or reload if it keeps happening."],
    [new Response(JSON.stringify({ detail: 'That bundle has too many files.' }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
      "Nebula couldn’t load the canvas. That bundle has too many files."],
  ])('a refused restore names the action and the reason (%#)', async (answer, line) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer));
    const alertSpy = noticeSpy();
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(zipSelection()) }]),
    });
    await expect(loadFromFile()).resolves.toBeNull();
    expect(alertSpy).toHaveBeenCalledWith(line);
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
    const alertSpy = noticeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(zipSelection()) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Error copy round 3e (GM): the person reads a written line; the check's
    // own text ("nodes[0] must be an object") goes to the console only.
    expect(alertSpy).toHaveBeenCalledWith('Nebula couldn’t load the canvas. This file is damaged or isn’t a Nebula canvas.');
    expect(consoleError).toHaveBeenCalledWith('[nebula] graph load', expect.stringContaining('nodes[0] must be an object'));
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
    const alertSpy = noticeSpy();
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
    const alertSpy = noticeSpy();
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
    const alertSpy = noticeSpy();
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
    const alertSpy = noticeSpy();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ getFile: vi.fn().mockResolvedValue(file) }]),
    });

    await expect(loadFromFile()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith("Nebula couldn’t load the canvas. This file is from a newer Nebula. Update Nebula, then open it again.");
    expect(consoleError).toHaveBeenCalledWith('[nebula] graph load', expect.stringContaining('Unsupported .nebula file version'));
  });
});
