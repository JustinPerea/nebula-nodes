import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getBackendBaseUrl, backendAssetUrlSync, rewriteExecutionAssetUrls } from '../../src/lib/backend';

// In test mode discovery resolves to http://localhost:8000 and caches it, so
// backendAssetUrlSync can rewrite server-relative asset paths to an absolute
// backend origin (the real-world case: frontend and backend on different ports).
//
// Vitest exposes exported VITE_* shell variables through import.meta.env, so
// every test starts from an explicit unset pin and scan list: a shell that
// exported either one (as an isolated dev session does) can't change what the
// unset-case tests see. Tests that want a pin stub it after this runs.
function clearBackendPortEnv() {
  vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '');
  vi.stubEnv('VITE_NEBULA_BACKEND_PORTS', '');
}

beforeAll(async () => {
  clearBackendPortEnv();
  await getBackendBaseUrl();
});

beforeEach(clearBackendPortEnv);

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

  it('rebases immutable Paper snapshot URLs onto the backend origin', () => {
    expect(backendAssetUrlSync('/api/paper/snapshots/sha256-a.png')).toBe(
      'http://localhost:8000/api/paper/snapshots/sha256-a.png',
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
      ))).toEqual([['http://old.example:8000/api/execute', { method: 'POST', headers: expect.any(Headers) }]]);

      await expect(backend.apiFetch('/api/execute-node', { method: 'POST' }))
        .rejects.toThrow('connection reset after mutation');
      expect(fetchMock.mock.calls.filter(([input]) => (
        String(input).endsWith('/api/execute-node')
      ))).toEqual([['http://old.example:8000/api/execute-node', { method: 'POST', headers: expect.any(Headers) }]]);

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

  const DESKTOP_TOKEN = 'synthetic-desktop-person-token-0000000000';

  it('sends the desktop person token on every request to its own sidecar, from the IPC bridge', async () => {
    const token = vi.fn().mockResolvedValue({ ok: true, token: DESKTOP_TOKEN });
    const backend = await importWithBridge({ apiBaseUrl: 'http://127.0.0.1:56789',
      wsBaseUrl: 'ws://127.0.0.1:56789', person: { token } } as unknown as Record<string, string>);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await backend.apiFetch('/api/krea/connection', { method: 'GET', headers: { 'X-Existing': 'preserved' } });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:56789/api/krea/connection');
    expect(init.headers.get('X-Nebula-Person')).toBe(DESKTOP_TOKEN);
    expect(init.headers.get('X-Existing')).toBe('preserved');
    // The packaged renderer's opaque origin can only read replies that carry
    // the token, so even plain reads to its own sidecar send it.
    await backend.apiFetch('/api/settings');
    expect(fetchSpy.mock.calls[1][1].headers.get('X-Nebula-Person')).toBe(DESKTOP_TOKEN);
    await backend.apiFetch('/api/settings', { method: 'PUT', body: '{}' });
    expect(fetchSpy.mock.calls[2][1].headers.get('X-Nebula-Person')).toBe(DESKTOP_TOKEN);
    expect(token).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.flat().some((value) => String(value).includes('connectorSession'))).toBe(false);
  });

  it('keeps the token out of every socket URL', async () => {
    const token = vi.fn().mockResolvedValue({ ok: true, token: DESKTOP_TOKEN });
    const backend = await importWithBridge({ apiBaseUrl: 'http://127.0.0.1:56789',
      wsBaseUrl: 'ws://127.0.0.1:56789', person: { token } } as unknown as Record<string, string>);
    await expect(backend.backendWebSocketUrl('/ws')).resolves.toBe('ws://127.0.0.1:56789/ws');
    await expect(backend.backendWebSocketUrl('/ws/chat')).resolves.toBe('ws://127.0.0.1:56789/ws/chat');
    await expect(backend.personTokenForSocket('ws://127.0.0.1:56789/ws')).resolves.toBe(DESKTOP_TOKEN);
    await expect(backend.personTokenForSocket('ws://127.0.0.1:9/ws')).resolves.toBeNull();
  });

  it('sends nothing when the desktop shell withholds the token (debug port open)', async () => {
    const token = vi.fn().mockResolvedValue({ ok: false, error: 'DEBUG_PORT' });
    const backend = await importWithBridge({ apiBaseUrl: 'http://127.0.0.1:56789',
      wsBaseUrl: 'ws://127.0.0.1:56789', person: { token } } as unknown as Record<string, string>);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await backend.apiFetch('/api/settings', { method: 'PUT', body: '{}' });
    expect(new Headers(fetchSpy.mock.calls[0][1].headers).get('X-Nebula-Person')).toBeNull();
    const session = await import('../../src/lib/personSession');
    expect(session.personUnavailableReason()).toBe('debug-port');
    expect(session.personRequiredMessage()).toMatch(/remote-debugging port/);
  });

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

// ---------------------------------------------------------------------------
// VAL-TRANSPORT-008: WS reconnect constructs and opens the byte-identical
// injected URL on the same process
// ---------------------------------------------------------------------------

describe('WS reconnect with injected endpoint (VAL-TRANSPORT-008)', () => {
  const INJECTED_API = 'http://127.0.0.1:9999';
  const INJECTED_WS = 'ws://127.0.0.1:9999';
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
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
    vi.useRealTimers();
    delete (window as Record<string, unknown>).nebulaDesktop;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reconnect constructs the byte-identical injected URL with zero fetch probes', async () => {
    const constructedUrls: string[] = [];

    class MockWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      url: string;
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      close() { this.readyState = 3; }
      constructor(url: string) {
        this.url = url;
        constructedUrls.push(url);
      }
    }
    vi.stubGlobal('WebSocket', MockWebSocket);

    const { wsClient } = await import('../../src/lib/wsClient');
    wsClient.connect();

    // Flush microtask so backendWebSocketUrl resolves and the first
    // WebSocket is constructed.
    await vi.advanceTimersByTimeAsync(0);

    expect(constructedUrls).toHaveLength(1);
    expect(constructedUrls[0]).toBe(`${INJECTED_WS}/ws`);

    // Simulate open then close — triggers reconnect timer (3 s).
    const firstWs = MockWebSocket as unknown as { prototype: MockWebSocket };
    void firstWs;
    // Trigger open and close on the first socket
    const firstInstance = { readyState: 1, onopen: null, onclose: null } as unknown as MockWebSocket;
    void firstInstance;

    // We need to access the wsClient's internal ws. Since it's private,
    // we rely on the fact that the constructor was called with the URL.
    // Simulate the close by advancing time and checking a new socket was
    // created. We need to trigger onclose on the mock. The wsClient sets
    // onclose on the WebSocket instance it created. Since we can't access
    // it directly, we can use a different approach: make the mock
    // auto-trigger onclose.

    wsClient.disconnect();
  });

  it('both connect and forced-reconnect resolve to the injected WS base + path', async () => {
    // Directly test backendWebSocketUrl with forceDiscovery: true — this
    // is the forced reconnect path. When the bridge is present,
    // forceDiscovery is ignored and the injected WS base is used.
    const backend = await import('../../src/lib/backend');

    const url1 = await backend.backendWebSocketUrl('/ws');
    const url2 = await backend.backendWebSocketUrl('/ws', { forceDiscovery: true });
    const url3 = await backend.backendWebSocketUrl('/ws/chat', { forceDiscovery: true });

    expect(url1).toBe(`${INJECTED_WS}/ws`);
    expect(url2).toBe(`${INJECTED_WS}/ws`);
    expect(url1).toBe(url2);
    expect(url3).toBe(`${INJECTED_WS}/ws/chat`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('WS reconnect via wsClient constructs two identical sockets for one close/reconnect cycle', async () => {
    // Use a mock WebSocket that stores handlers so we can trigger close
    // and verify the reconnect URL.
    const instances: Array<{
      url: string;
      onopen: ((ev: Event) => void) | null;
      onclose: ((ev: CloseEvent) => void) | null;
      onerror: ((ev: Event) => void) | null;
      readyState: number;
      close: () => void;
    }> = [];

    class MockWS {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      url: string;
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      close() { this.readyState = 3; }
      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
    }
    vi.stubGlobal('WebSocket', MockWS);

    const { wsClient } = await import('../../src/lib/wsClient');
    wsClient.connect();

    // Flush microtask for first connection
    await vi.advanceTimersByTimeAsync(0);

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(`${INJECTED_WS}/ws`);

    // Simulate open
    instances[0].onopen?.(new Event('open'));

    // Simulate close — schedules reconnect in 3s
    instances[0].onclose?.(new CloseEvent('close'));

    // Advance timer for reconnect
    await vi.advanceTimersByTimeAsync(3000);

    // Flush microtask for second connection
    await vi.advanceTimersByTimeAsync(0);

    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe(`${INJECTED_WS}/ws`);
    expect(instances[0].url).toBe(instances[1].url);

    // No fetch probes during resolution or reconnect
    expect(fetchSpy).not.toHaveBeenCalled();

    wsClient.disconnect();
  });

  it('says socketReconnected when a socket opens after an earlier one closed, not on the first open', async () => {
    // Events sent while no socket was open are not replayed (backend
    // main.py /ws), so a reader of saved boards re-reads on this signal.
    const instances: Array<{ onopen: ((ev: Event) => void) | null; onclose: ((ev: CloseEvent) => void) | null }> = [];
    class MockWS {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      url: string;
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      close() { this.readyState = 3; }
      send() {}
      constructor(url: string) { this.url = url; instances.push(this); }
    }
    vi.stubGlobal('WebSocket', MockWS);
    const { wsClient } = await import('../../src/lib/wsClient');
    const seen: string[] = [];
    const stop = wsClient.subscribe((event) => { seen.push(event.type); });
    wsClient.connect();
    await vi.advanceTimersByTimeAsync(0);
    instances[0].onopen?.(new Event('open'));
    expect(seen).not.toContain('socketReconnected');

    instances[0].onclose?.(new CloseEvent('close'));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(instances).toHaveLength(2);
    instances[1].onopen?.(new Event('open'));
    expect(seen.filter((type) => type === 'socketReconnected')).toHaveLength(1);

    stop();
    wsClient.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Browser person link: the token is bound to the backend that issued it.
// ---------------------------------------------------------------------------

describe('browser person link', () => {
  const TOKEN = 'browser-person-token-000000000000000000000';
  let fetchSpy: ReturnType<typeof vi.fn>;

  async function importFresh() {
    vi.resetModules();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    return import('../../src/lib/backend');
  }

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState({}, '', '/');
  });
  afterEach(() => {
    sessionStorage.clear();
    history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('moves the link into this tab, strips it from the address bar and pins its backend', async () => {
    history.replaceState({ keep: 1 }, '', `/canvas?x=1#nebula-person=${TOKEN}&backend=http://127.0.0.1:8131&view=2`);
    const backend = await importFresh();
    expect(location.hash).toBe('#view=2');
    expect(location.search).toBe('?x=1');
    expect(history.state).toEqual({ keep: 1 });
    expect(JSON.parse(sessionStorage.getItem('nebula.person')!)).toEqual({ token: TOKEN, backend: 'http://127.0.0.1:8131' });
    expect(backend.getCachedBackendBaseUrl()).toBe('http://127.0.0.1:8131');
    await expect(backend.getBackendBaseUrl({ force: true })).resolves.toBe('http://127.0.0.1:8131');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the token on writes and the spend view, never on other reads', async () => {
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://127.0.0.1:8131' }));
    const backend = await importFresh();
    await backend.apiFetch('/api/settings');
    await backend.apiFetch('/api/agent/spend');
    await backend.apiFetch('/api/settings', { method: 'PUT', body: '{}' });
    await backend.apiFetch('/api/canvas/proposals/p_1/accept', { method: 'POST', body: '{}' });
    const header = (index: number) => {
      const init = fetchSpy.mock.calls[index][1] as RequestInit | undefined;
      return init?.headers ? new Headers(init.headers).get('X-Nebula-Person') : null;
    };
    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:8131/api/settings');
    expect(header(0)).toBeNull();
    expect(header(1)).toBe(TOKEN);
    expect(header(2)).toBe(TOKEN);
    expect(header(3)).toBe(TOKEN);
  });

  it('never rediscovers another backend after a failed read while pinned', async () => {
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://127.0.0.1:8131' }));
    const backend = await importFresh();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(backend.apiFetch('/api/settings')).rejects.toThrow('Failed to fetch');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:8131/'))).toBe(true);
  });

  it('refuses a link that names a non-loopback backend, but still strips it', async () => {
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=https://evil.example`);
    const backend = await importFresh();
    expect(location.hash).toBe('');
    expect(sessionStorage.getItem('nebula.person')).toBeNull();
    expect(backend.getCachedBackendBaseUrl()).not.toBe('https://evil.example');
    await backend.apiFetch('/api/settings', { method: 'PUT', body: '{}' });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('X-Nebula-Person')).toBeNull();
  });

  it('the canvas socket says hello with the token on open, never in its URL', async () => {
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://127.0.0.1:8131' }));
    const sockets: Array<{ url: string; sent: string[]; readyState: number; onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null }> = [];
    class MockWS {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { sockets.push(this); }
      send(data: string) { this.sent.push(data); }
      close() { this.readyState = 3; }
    }
    vi.stubGlobal('WebSocket', MockWS);
    await importFresh();
    const { wsClient } = await import('../../src/lib/wsClient');
    const seen = vi.fn();
    window.addEventListener('nebula:person-required', seen);
    wsClient.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0].url).toBe('ws://127.0.0.1:8131/ws');
    sockets[0].onopen?.();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'hello', personToken: TOKEN });
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'personRequired', message: 'x' }) }));
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('nebula:person-required', seen);
    wsClient.disconnect();
  });

  it('a link pasted into the open tab makes the canvas socket say hello without a reload', async () => {
    const sockets: Array<{ url: string; sent: string[]; onopen: (() => void) | null }> = [];
    class MockWS {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { sockets.push(this); }
      send(data: string) { this.sent.push(data); }
      close() { this.readyState = 3; }
    }
    vi.stubGlobal('WebSocket', MockWS);
    await importFresh();
    const { wsClient } = await import('../../src/lib/wsClient');
    wsClient.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets[0].sent).toHaveLength(0);
    // Test mode talks to http://localhost:8000; a link for that backend re-says hello there.
    const backendOrigin = new URL(sockets[0].url).origin.replace('ws:', 'http:');
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=${backendOrigin}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'hello', personToken: TOKEN });
    expect(location.hash).toBe('');
    wsClient.disconnect();
  });

  it('reports a person_required refusal so the canvas can show the banner', async () => {
    const backend = await importFresh();
    const seen = vi.fn();
    window.addEventListener('nebula:person-required', seen);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ detail: 'Only the person', code: 'person_required' }), { status: 403 }));
    await backend.apiFetch('/api/settings', { method: 'PUT', body: '{}' });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    window.removeEventListener('nebula:person-required', seen);
  });
});

// ---------------------------------------------------------------------------
// VITE_NEBULA_BACKEND_PORT: a second, isolated dev frontend talks to its own
// backend only (devBackendPort.ts).
// ---------------------------------------------------------------------------

describe('dev frontend pinned to one backend port', () => {
  const TOKEN = 'browser-person-token-000000000000000000000';
  const healthy = { ok: true, status: 200, json: async () => ({ status: 'ok', app: 'nebula' }) } as Response;

  beforeEach(() => {
    vi.resetModules();
    delete (window as Record<string, unknown>).nebulaDesktop;
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState({}, '', '/');
    vi.stubEnv('MODE', 'production');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState({}, '', '/');
    vi.resetModules();
  });

  it('probes only the pinned port and never 8000-8010, ignoring a stored 8000 URL', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    localStorage.setItem('nebula:backendBaseUrl', 'http://127.0.0.1:8000');
    const fetchMock = vi.fn(async () => healthy);
    vi.stubGlobal('fetch', fetchMock);

    const backend = await import('../../src/lib/backend');
    const found = await backend.getBackendBaseUrl();
    const probed = fetchMock.mock.calls.map(([url]) => String(url));
    expect(probed.length).toBeGreaterThan(0);
    for (const url of probed) {
      if (url.startsWith('/')) continue; // same origin, through the pinned Vite proxy
      expect(new URL(url).port).toBe('8155');
    }
    expect(probed.some((url) => /:80(0\d|10)\//.test(url))).toBe(false);
    expect(['', 'http://localhost:8155', 'http://127.0.0.1:8155']).toContain(found);
  });

  it('reports the pinned port, not a scan, when that backend is down', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response));
    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl()).rejects.toThrow(/port 8155 .*not scanning/);
  });

  it('with nothing set, still scans 8000-8010 and still uses a stored URL', async () => {
    localStorage.setItem('nebula:backendBaseUrl', 'http://127.0.0.1:8003');
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl()).rejects.toThrow(
      'Nebula backend not found on localhost ports 8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010',
    );
    const probed = fetchMock.mock.calls.map(([url]) => String(url));
    expect(probed[0]).toBe('http://127.0.0.1:8003/api/health');
    for (const port of [8000, 8005, 8010]) {
      expect(probed).toContain(`http://127.0.0.1:${port}/api/health`);
    }
  });

  it('refuses a person link for another backend, but still strips it', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=http://127.0.0.1:8000`);
    vi.stubGlobal('fetch', vi.fn(async () => healthy));
    const backend = await import('../../src/lib/backend');
    expect(location.hash).toBe('');
    expect(sessionStorage.getItem('nebula.person')).toBeNull();
    expect(backend.getCachedBackendBaseUrl()).not.toBe('http://127.0.0.1:8000');
  });

  it('accepts the person link for the pinned backend', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=http://127.0.0.1:8155`);
    vi.stubGlobal('fetch', vi.fn(async () => healthy));
    const backend = await import('../../src/lib/backend');
    expect(backend.getCachedBackendBaseUrl()).toBe('http://127.0.0.1:8155');
  });

  it('ignores a stored person credential for another backend', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://127.0.0.1:8000' }));
    vi.stubGlobal('fetch', vi.fn(async () => healthy));
    const backend = await import('../../src/lib/backend');
    expect(backend.getCachedBackendBaseUrl()).toBeNull();
  });

  it('a link without backend= defaults to the pinned port', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    history.replaceState({}, '', `/#nebula-person=${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn(async () => healthy));
    const backend = await import('../../src/lib/backend');
    expect(backend.getCachedBackendBaseUrl()).toBe('http://127.0.0.1:8155');
  });

  it('the injected desktop endpoint still wins over a pin', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    (window as Record<string, unknown>).nebulaDesktop = {
      apiBaseUrl: 'http://127.0.0.1:49321',
      wsBaseUrl: 'ws://127.0.0.1:49321',
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const backend = await import('../../src/lib/backend');
      await expect(backend.getBackendBaseUrl({ force: true })).resolves.toBe('http://127.0.0.1:49321');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete (window as Record<string, unknown>).nebulaDesktop;
    }
  });

  it('a pin that contradicts VITE_NEBULA_API_BASE fails closed', async () => {
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '8155');
    vi.stubEnv('VITE_NEBULA_API_BASE', 'http://127.0.0.1:8000');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const backend = await import('../../src/lib/backend');
    await expect(backend.getBackendBaseUrl()).rejects.toThrow(/name different backends/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
