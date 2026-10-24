import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as backend from '../../src/lib/backend';
import { apiFetch, getBackendBaseUrl, rewriteBackendAssetUrls, rewriteExecutionAssetUrls } from '../../src/lib/backend';

// The tab shows backend-relative asset links from the backend's own origin;
// everything that carries the graph back (project saves, graph edits, runs)
// must send the relative links again, or the strict World contract refuses
// the save (worldsave, #185's live review).

const world = () => ({
  schemaVersion: 2, kind: 'world', id: 'w-1',
  assets: {
    splats: [{ id: 'preview', format: 'spz', asset: { id: 'spz', uri: '/api/outputs/run/world.spz', mediaType: 'application/octet-stream' } }],
    panorama: { id: 'pano', uri: '/api/outputs/run/pano.png', mediaType: 'image/png' },
  },
  provider: { marbleUrl: 'https://marble.worldlabs.ai/world/w-1' },
});

/** A value with every backend-relative link spelled absolute, as older tabs
 * held a World (and an Any port may still hold one). */
const absolute = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('"/api/', '"http://127.0.0.1:8801/api/'));

const canonical = (value: unknown) =>
  (backend as unknown as { canonicalBackendAssetUrls: (value: unknown) => unknown }).canonicalBackendAssetUrls(value);

beforeAll(async () => {
  vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '');
  vi.stubEnv('VITE_NEBULA_BACKEND_PORTS', '');
  await getBackendBaseUrl();
});

afterEach(() => vi.unstubAllGlobals());

describe('canonicalBackendAssetUrls', () => {
  it('undoes the display rewrite of media, nested or not', () => {
    const outputs = { image: { type: 'Image', value: '/api/outputs/run/x.png' },
      legacyWorld: { type: 'World', value: { schemaVersion: 1, assets: { splats: { full_res: '/api/outputs/run/w.spz' } } } } };
    expect(JSON.stringify(rewriteBackendAssetUrls(outputs))).toContain('http://localhost:8000/api/outputs/run/w.spz');
    expect(canonical(rewriteBackendAssetUrls(outputs))).toEqual(outputs);
    expect(canonical(rewriteExecutionAssetUrls(outputs))).toEqual(outputs);
  });

  it('makes a World that was made absolute relative again (a value the display rewrite never touched)', () => {
    const port = { type: 'World', value: world() };
    expect(canonical(absolute(port))).toEqual(port);
  });

  it('makes every backend asset kind relative from either loopback spelling and any port', () => {
    expect(canonical({
      a: 'http://localhost:8000/api/outputs/run/x.png',
      b: 'http://127.0.0.1:8801/api/presets/thumbnails/noir',
      c: ['http://127.0.0.1:5801/api/paper/snapshots/sha256-a.png'],
      d: '/api/outputs/already.png',
    })).toEqual({
      a: '/api/outputs/run/x.png',
      b: '/api/presets/thumbnails/noir',
      c: ['/api/paper/snapshots/sha256-a.png'],
      d: '/api/outputs/already.png',
    });
  });

  it('leaves links that are not this backend\'s assets, and text that mentions one, as they are', () => {
    const untouched = {
      provider: 'https://marble.worldlabs.ai/api/outputs/x.spz',
      lookalike: 'http://127.0.0.1.example.com/api/outputs/x.png',
      notAnAsset: 'http://localhost:8000/api/settings',
      jsonEndpoint: 'http://localhost:8000/api/presets/abc',
      prose: 'see http://localhost:8000/api/outputs/a.png for the take',
      number: 4, flag: true, empty: null,
    };
    expect(canonical(untouched)).toEqual(untouched);
  });
});

describe('display rewrites leave versioned spatial values as the backend gave them', () => {
  it('a World, nested spatial values and all, stays relative so its strict card parser accepts it', () => {
    const port = { type: 'World', value: world() };
    expect(rewriteBackendAssetUrls({ outputs: { world: port } })).toEqual({ outputs: { world: port } });
    expect(rewriteExecutionAssetUrls(port)).toEqual(port);
    // On an Any port (Spatial Value Validate) it is recognised by its own kind.
    expect(rewriteBackendAssetUrls({ type: 'Any', value: world() })).toEqual({ type: 'Any', value: world() });
    const cloud = { schemaVersion: 1, kind: 'point-cloud', id: 'c', asset: { id: 'a', uri: '/api/outputs/run/c.ply', mediaType: 'model/ply' } };
    expect(rewriteBackendAssetUrls([cloud])).toEqual([cloud]);
  });
});

describe('apiFetch sends the graph with relative asset links', () => {
  function capture() {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const bodyOf = (path: string) => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith(path)) as unknown as [string, RequestInit] | undefined;
      return call ? JSON.parse(String(call[1].body)) : undefined;
    };
    return { fetchMock, bodyOf };
  }
  const shown = () => absolute({ type: 'World', value: world() });

  it.each([
    ['PUT', '/api/projects/alpha', (port: unknown) => ({ snapshot: { nodes: [{ id: 'n1', data: { outputs: { world: port } } }] }, workspaceRevision: 'r' })],
    ['POST', '/api/projects/recover', (port: unknown) => ({ snapshot: { nodes: [{ id: 'n1', data: { outputs: { world: port } } }] } })],
    ['POST', '/api/execute', (port: unknown) => ({ nodes: [{ id: 'n1', definitionId: 'x', params: {}, outputs: { world: port } }], edges: [] })],
    ['POST', '/api/execute-node', (port: unknown) => ({ nodes: [{ id: 'n1', definitionId: 'x', params: {}, outputs: { world: port } }], edges: [], targetNodeId: 'n1' })],
    ['POST', '/api/graph/restore', (port: unknown) => ({ nodes: [{ id: 'n1', outputs: { world: port } }] })],
    ['PUT', '/api/graph/node/n1', (port: unknown) => ({ params: { source: port } })],
    ['POST', '/api/graph/import', (port: unknown) => ({ graph: { nodes: [{ data: { outputs: { world: port } } }] } })],
  ])('%s %s', async (method, path, body) => {
    const { bodyOf } = capture();
    await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(shown())) });
    expect(bodyOf(path)).toEqual(body({ type: 'World', value: world() }));
  });

  it('leaves a body that is not graph content as it was sent', async () => {
    const { fetchMock } = capture();
    const text = JSON.stringify({ url: 'http://localhost:8000/api/outputs/run/x.png' });
    await apiFetch('/api/settings', { method: 'PUT', body: text });
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/settings')) as unknown as [string, RequestInit];
    expect(call[1].body).toBe(text);
  });
});
