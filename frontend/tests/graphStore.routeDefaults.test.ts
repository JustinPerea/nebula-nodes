import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import routeCases from '../../backend/tests/fixtures/route_cases.json';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(),
} }));

import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { ModelNodeDefinition } from '../src/types';

/** A route-table node starts on `_provider: 'auto'` with every route's own
 * defaults, whichever way it is added (graphStore buildDefaultParams), so
 * the router sends what the estimate and the switcher describe. */
const definition = (routeCases.definitions as unknown as Record<string, ModelNodeDefinition>)['routes-image'];
const expected = {
  _provider: 'auto', _kreaAuth: 'api-token', aspect_ratio: 'auto', resolution: '1k', safety_tolerance: 2, grounding: false,
};
const initialCache = useUIStore.getState().settingsCache;

describe('route-table node defaults', () => {
  beforeAll(() => { NODE_DEFINITIONS[definition.id] = definition; });
  afterAll(() => { delete NODE_DEFINITIONS[definition.id]; });

  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [],
      runHistory: [], isExecuting: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [] });
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true, kreaConnectionMode: 'mcp' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.clear();
  });

  afterEach(() => {
    useUIStore.setState({ settingsCache: initialCache });
    vi.restoreAllMocks();
  });

  it('addNode sends the provider choice and each route\'s defaults', async () => {
    // Round 13 of PR #114: an add always goes through the backend (a tab
    // with no backend refuses it), so the defaults are what the create sends.
    apiFetchMock.mockReset().mockImplementation(async (url: string) => (url === '/api/graph/export'
      ? { ok: true, json: async () => ({ empty: true }) }
      : { ok: true, json: async () => ({ id: 'n1' }) }));
    await useGraphStore.getState().addNode(definition.id, { x: 0, y: 0 });
    const create = apiFetchMock.mock.calls.find(([url]) => url === '/api/graph/node');
    expect(JSON.parse(create?.[1].body).params).toEqual(expected);
  });

  it('addNodeAndConnect sends the same defaults', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'nano-banana', label: 'Logo', params: {}, state: 'complete',
        outputs: { image: { type: 'Image', value: '/outputs/logo.png' } } } }] });
    apiFetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ id: 'n2', definitionId: definition.id,
      connected: true, edge: { id: 'e1', source: 'n1', sourceHandle: 'image', target: 'n2', targetHandle: 'images',
        type: 'typed-edge', data: { dataType: 'Image' } } }) });
    await useGraphStore.getState().addNodeAndConnect(definition.id, { x: 2, y: 3 }, {
      source: 'n1', target: '', sourceHandle: 'image', targetHandle: 'images', newNodeIs: 'target',
    });
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe('/api/graph/node-and-connect');
    expect(JSON.parse(init.body).params).toEqual(expected);
  });
});
