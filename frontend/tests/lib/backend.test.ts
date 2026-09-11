import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// VAL-TRANSPORT-005: WS URL derivation — http→ws / https→wss, no discovery
// ---------------------------------------------------------------------------

describe('backendWebSocketUrl with injected endpoint (VAL-TRANSPORT-005)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  async function importWithBridge(bridge: Record<string, string>) {
    vi.resetModules();
    Object.defineProperty(window, 'nebulaDesktop', {
      value: Object.freeze(bridge),
      configurable: true,
      writable: true,
    });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    return import('../../src/lib/backend');
  }

  afterEach(() => {
    delete (window as Record<string, unknown>).nebulaDesktop;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('derives ws:// URL from an http injected base without probing', async () => {
    const backend = await importWithBridge({
      platform: 'darwin',
      shell: 'electron',
      apiBaseUrl: 'http://127.0.0.1:9999',
      wsBaseUrl: 'ws://127.0.0.1:9999',
    });
    await expect(backend.backendWebSocketUrl('/ws')).resolves.toBe('ws://127.0.0.1:9999/ws');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('derives wss:// URL from an https injected base without probing', async () => {
    const backend = await importWithBridge({
      platform: 'darwin',
      shell: 'electron',
      apiBaseUrl: 'https://127.0.0.1:9999',
      wsBaseUrl: 'wss://127.0.0.1:9999',
    });
    await expect(backend.backendWebSocketUrl('/ws/chat')).resolves.toBe('wss://127.0.0.1:9999/ws/chat');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// VAL-TRANSPORT-006: Injected endpoint outranks env, localStorage, discovery,
// force, sync cache, and test-mode default
// ---------------------------------------------------------------------------

describe('injected endpoint precedence (VAL-TRANSPORT-006)', () => {
  const INJECTED_API = 'http://127.0.0.1:9999';
  const INJECTED_WS = 'ws://127.0.0.1:9999';
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('MODE', 'test');
    vi.stubEnv('VITE_NEBULA_API_BASE', 'http://decoy.invalid:9000');
    window.localStorage.setItem('nebula:backendBaseUrl', 'http://old.example:8000');
    Object.defineProperty(window, 'nebulaDesktop', {
      value: Object.freeze({
        platform: 'darwin',
        shell: 'electron',
        apiBaseUrl: INJECTED_API,
        wsBaseUrl: INJECTED_WS,
      }),
      configurable: true,
      writable: true,
    });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    delete (window as Record<string, unknown>).nebulaDesktop;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.localStorage.removeItem('nebula:backendBaseUrl');
    vi.resetModules();
  });

  it('getBackendBaseUrl returns the injected base', async () => {
    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl()).resolves.toBe(INJECTED_API);
  });

  it('getBackendBaseUrl with force returns the injected base (exercised twice)', async () => {
    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl({ force: true })).resolves.toBe(INJECTED_API);
    await expect(backend.getBackendBaseUrl({ force: true })).resolves.toBe(INJECTED_API);
  });

  it('getCachedBackendBaseUrl is non-null synchronously after import', async () => {
    const backend = await import('../../src/lib/backend');
    expect(backend.getCachedBackendBaseUrl()).toBe(INJECTED_API);
  });

  it('backendUrlSync resolves against the injected base', async () => {
    const backend = await import('../../src/lib/backend');
    expect(backend.backendUrlSync('/api/graph/export')).toBe(`${INJECTED_API}/api/graph/export`);
  });

  it('backendAssetUrlSync rewrites asset paths to the injected base', async () => {
    const backend = await import('../../src/lib/backend');
    expect(backend.backendAssetUrlSync('/api/outputs/run/x.png')).toBe(`${INJECTED_API}/api/outputs/run/x.png`);
    expect(backend.backendAssetUrlSync('/api/presets/thumbnails/cinematic-noir')).toBe(
      `${INJECTED_API}/api/presets/thumbnails/cinematic-noir`,
    );
  });

  it('localStorage is neither consulted as source nor rewritten/cleared', async () => {
    const backend = await import('../../src/lib/backend');
    await backend.getBackendBaseUrl();
    await backend.getBackendBaseUrl({ force: true });
    expect(window.localStorage.getItem('nebula:backendBaseUrl')).toBe('http://old.example:8000');
  });

  it('zero fetch/probe calls occur during resolution', async () => {
    const backend = await import('../../src/lib/backend');
    await backend.getBackendBaseUrl();
    await backend.getBackendBaseUrl({ force: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sync cache never equals localhost:8000', async () => {
    const backend = await import('../../src/lib/backend');
    expect(backend.getCachedBackendBaseUrl()).not.toBe('http://localhost:8000');
    expect(backend.backendUrlSync('/api/test')).not.toContain('localhost:8000');
  });

  it('rewriteBackendAssetUrls resolves splat URLs and collider meshes to the injected base', async () => {
    const backend = await import('../../src/lib/backend');
    const result = backend.rewriteBackendAssetUrls({
      splats: { '100k': '/api/outputs/run/world-100k.spz' },
      colliderMesh: '/api/outputs/run/collider.glb',
      marbleUrl: 'https://marble.worldlabs.ai/world/world-123',
    });
    expect(result.splats['100k']).toBe(`${INJECTED_API}/api/outputs/run/world-100k.spz`);
    expect(result.colliderMesh).toBe(`${INJECTED_API}/api/outputs/run/collider.glb`);
    expect(result.marbleUrl).toBe('https://marble.worldlabs.ai/world/world-123');
  });
});

// ---------------------------------------------------------------------------
// VAL-TRANSPORT-007: Failed reads and mutations are never retried,
// rediscovered, or replayed with an injected source
// ---------------------------------------------------------------------------

describe('no retry, rediscovery, or replay with injected endpoint (VAL-TRANSPORT-007)', () => {
  const INJECTED_API = 'http://127.0.0.1:9999';
  const INJECTED_WS = 'ws://127.0.0.1:9999';
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(window, 'nebulaDesktop', {
      value: Object.freeze({
        platform: 'darwin',
        shell: 'electron',
        apiBaseUrl: INJECTED_API,
        wsBaseUrl: INJECTED_WS,
      }),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    delete (window as Record<string, unknown>).nebulaDesktop;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('a failing GET rejects with the original error after exactly one call', async () => {
    fetchSpy = vi.fn(async () => {
      throw new TypeError('connection reset after send');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await import('../../src/lib/backend');
    await expect(backend.apiFetch('/api/read')).rejects.toThrow('connection reset after send');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${INJECTED_API}/api/read`);
  });

  it('a GET receiving 502 surfaces that exact status after exactly one call with no discovery retry', async () => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await import('../../src/lib/backend');
    const response = await backend.apiFetch('/api/status');
    expect(response.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${INJECTED_API}/api/status`);
  });

  it('a GET receiving 503 surfaces that exact status after exactly one call', async () => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await import('../../src/lib/backend');
    const response = await backend.apiFetch('/api/status');
    expect(response.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a GET receiving 504 surfaces that exact status after exactly one call', async () => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 504 }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await import('../../src/lib/backend');
    const response = await backend.apiFetch('/api/status');
    expect(response.status).toBe(504);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('each failed POST/PUT/DELETE is issued exactly once and never replayed', async () => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await import('../../src/lib/backend');
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      await backend.apiFetch(`/api/mutate-${method.toLowerCase()}`, { method });
    }

    const urls = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual([
      `${INJECTED_API}/api/mutate-post`,
      `${INJECTED_API}/api/mutate-put`,
      `${INJECTED_API}/api/mutate-delete`,
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(urls.every((u) => u.startsWith(INJECTED_API))).toBe(true);
    expect(urls.some((u) => u.includes('/api/health'))).toBe(false);
  });

  it('the full spy log contains no /api/health candidate probes', async () => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await import('../../src/lib/backend');
    await backend.apiFetch('/api/data').catch(() => {});
    await backend.apiFetch('/api/thing', { method: 'POST' }).catch(() => {});

    const urls = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(urls.some((u) => u.includes('/api/health'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-TRANSPORT-010: Browser/Vite mode unchanged when the bridge is absent
// ---------------------------------------------------------------------------

describe('browser/Vite mode unchanged when bridge absent (VAL-TRANSPORT-010)', () => {
  beforeEach(() => {
    vi.resetModules();
    // Ensure the Electron bridge is absent — simulates browser/Vite mode.
    delete (window as Record<string, unknown>).nebulaDesktop;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.localStorage.removeItem('nebula:backendBaseUrl');
    vi.resetModules();
  });

  it('test mode resolves synchronously to localhost:8000', async () => {
    vi.stubEnv('MODE', 'test');
    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl()).resolves.toBe('http://localhost:8000');
  });

  it('getCachedBackendBaseUrl is null before discovery when bridge absent', async () => {
    vi.stubEnv('MODE', 'production');
    const backend = await import('../../src/lib/backend');
    expect(backend.getCachedBackendBaseUrl()).toBeNull();
  });

  it('explicit VITE_NEBULA_API_BASE is used without probing', async () => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_NEBULA_API_BASE', 'http://explicit.example:8888');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl()).resolves.toBe('http://explicit.example:8888');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('discovery probes candidates and persists the found base to localStorage', async () => {
    vi.stubEnv('MODE', 'production');
    window.localStorage.removeItem('nebula:backendBaseUrl');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8000/api/health') {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', app: 'nebula' }) } as Response;
      }
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const backend = await import('../../src/lib/backend');
    const result = await backend.getBackendBaseUrl();
    expect(result).toBe('http://127.0.0.1:8000');
    expect(window.localStorage.getItem('nebula:backendBaseUrl')).toBe('http://127.0.0.1:8000');
  });

  it('a fully failing probe set rejects with the existing not-found message', async () => {
    vi.stubEnv('MODE', 'production');
    window.localStorage.removeItem('nebula:backendBaseUrl');

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as Response));

    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl()).rejects.toThrow(/Nebula backend not found/);
  });
});
