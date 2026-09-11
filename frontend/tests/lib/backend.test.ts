import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getBackendBaseUrl, backendAssetUrlSync, rewriteExecutionAssetUrls } from '../../src/lib/backend';

// In test mode discovery resolves to http://localhost:8000 and caches it, so
// backendAssetUrlSync can rewrite server-relative asset paths to an absolute
// backend origin (the real-world case: frontend and backend on different ports).
beforeAll(async () => {
  await getBackendBaseUrl();
});

describe('backendAssetUrlSync', () => {
  it('rewrites /api/outputs/ paths to the discovered backend origin', () => {
    expect(backendAssetUrlSync('/api/outputs/run/x.png')).toBe(
      'http://localhost:8000/api/outputs/run/x.png',
    );
  });

  it('rewrites /api/presets/thumbnails/ paths to the discovered backend origin', () => {
    // Regression: seeded preset thumbnails were left relative and resolved
    // against the frontend origin, so they 404'd whenever the backend wasn't
    // same-origin. They must be rewritten like generated media.
    expect(backendAssetUrlSync('/api/presets/thumbnails/cinematic-noir')).toBe(
      'http://localhost:8000/api/presets/thumbnails/cinematic-noir',
    );
  });

  it('leaves non-asset paths and plain strings untouched', () => {
    // /api/presets/<id> is a JSON endpoint, not an asset — must NOT be rewritten.
    expect(backendAssetUrlSync('/api/presets/abc123')).toBe('/api/presets/abc123');
    expect(backendAssetUrlSync('just-a-string')).toBe('just-a-string');
  });
});

describe('rewriteExecutionAssetUrls', () => {
  it('recursively rewrites nested World asset URLs to the discovered backend', () => {
    expect(rewriteExecutionAssetUrls({
      worldId: 'world-123',
      marbleUrl: 'https://marble.worldlabs.ai/world/world-123',
      assets: {
        splats: {
          '100k': '/api/outputs/run/world-100k.spz',
          full_res: '/tmp/nebula/output/run/world-full.spz',
        },
        colliderMesh: 'output/run/collider.glb',
      },
    })).toEqual({
      worldId: 'world-123',
      marbleUrl: 'https://marble.worldlabs.ai/world/world-123',
      assets: {
        splats: {
          '100k': 'http://localhost:8000/api/outputs/run/world-100k.spz',
          full_res: 'http://localhost:8000/api/outputs/run/world-full.spz',
        },
        colliderMesh: 'http://localhost:8000/api/outputs/run/collider.glb',
      },
    });
  });

  it('does not rewrite external provider URLs that happen to contain /output/', () => {
    expect(rewriteExecutionAssetUrls('https://cdn.example/output/world.spz')).toBe(
      'https://cdn.example/output/world.spz',
    );
  });
});

describe('apiFetch rediscovery replay safety', () => {
  it('never replays a mutation, while a read may rediscover after transport failure', async () => {
    vi.resetModules();
    vi.stubEnv('MODE', 'production');
    window.localStorage.setItem('nebula:backendBaseUrl', 'http://old.example:8000');

    let phase: 'discover' | 'post' | 'get' = 'discover';
    const response = (body: unknown, ok = true, status = 200) => ({
      ok,
      status,
      json: async () => body,
    }) as Response;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        if (phase === 'discover' && (
          url === 'http://old.example:8000/api/health'
          || url === 'http://localhost:8000/api/health'
        )) {
          return response({ status: 'ok', app: 'nebula' });
        }
        if (phase === 'get' && url === 'http://localhost:8000/api/health') {
          return response({ status: 'ok', app: 'nebula' });
        }
        return response({}, false, 503);
      }
      if (url === 'http://old.example:8000/api/execute') {
        return response({}, false, 502);
      }
      if (url === 'http://old.example:8000/api/execute-node') {
        throw new TypeError('connection reset after mutation');
      }
      if (url === 'http://old.example:8000/api/read') {
        throw new TypeError('connection reset after send');
      }
      if (url === 'http://localhost:8000/api/read') {
        return response({ status: 'ok' });
      }
      return response({}, false, 503);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const backend = await import('../../src/lib/backend');
      await expect(backend.getBackendBaseUrl()).resolves.toBe('http://old.example:8000');

      phase = 'post';
      await expect(backend.apiFetch('/api/execute', { method: 'POST' }))
        .resolves.toMatchObject({ status: 502 });
      expect(fetchMock.mock.calls.filter(([input]) => (
        String(input).endsWith('/api/execute')
      ))).toEqual([['http://old.example:8000/api/execute', { method: 'POST' }]]);

      await expect(backend.apiFetch('/api/execute-node', { method: 'POST' }))
        .rejects.toThrow('connection reset after mutation');
      expect(fetchMock.mock.calls.filter(([input]) => (
        String(input).endsWith('/api/execute-node')
      ))).toEqual([['http://old.example:8000/api/execute-node', { method: 'POST' }]]);

      phase = 'get';
      await expect(backend.apiFetch('/api/read')).resolves.toMatchObject({ status: 200 });
      expect(fetchMock.mock.calls.filter(([input]) => (
        String(input).endsWith('/api/read')
      )).map(([input]) => String(input))).toEqual([
        'http://old.example:8000/api/read',
        'http://localhost:8000/api/read',
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      window.localStorage.removeItem('nebula:backendBaseUrl');
      vi.resetModules();
    }
  });
});
