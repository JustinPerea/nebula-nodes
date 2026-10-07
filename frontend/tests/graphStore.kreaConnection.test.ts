import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../src/lib/runHistory';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(),
} }));

import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import * as api from '../src/lib/api';

const modelId = 'krea-image-openai-gpt-image-2';
const initialCache = useUIStore.getState().settingsCache;

describe('Krea authoring and saved billing choice', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [],
      runHistory: [], isExecuting: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [] });
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true,
      kreaConnectionMode: 'mcp', kreaConnection: { status: 'connected' } } });
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.clear();
  });

  afterEach(() => {
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: initialCache });
    vi.restoreAllMocks();
  });

  it('freezes the current default in a new Canvas node without executing it', async () => {
    const execute = vi.spyOn(api, 'executeNode');
    const id = await useGraphStore.getState().addNode(modelId, { x: 0, y: 0 });
    const node = useGraphStore.getState().nodes.find((n) => n.id === id);
    expect(node?.data.params._kreaAuth).toBe('mcp');
    expect(node?.data.keyStatus).toBeUndefined();
    useUIStore.getState().setKreaConnectionMode('api-token');
    useUIStore.getState().setKreaConnection({ status: 'disconnected' });
    expect(useGraphStore.getState().nodes.find((n) => n.id === id)?.data.params._kreaAuth).toBe('mcp');
    expect(execute).not.toHaveBeenCalled();
    expect(useGraphStore.getState().runHistory).toEqual([]);
  });

  it('posts the chosen mode when creating a connected Canvas node', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'n2' }) });
    await useGraphStore.getState().addNodeAndConnect(modelId, { x: 2, y: 3 }, {
      source: 'n1', target: '', sourceHandle: 'image', targetHandle: 'image_urls', newNodeIs: 'target',
    });
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe('/api/graph/node-and-connect');
    expect(JSON.parse(init.body).params._kreaAuth).toBe('mcp');
  });

  it.each([undefined, 'api-token'] as const)(
    'authors new Create nodes using the default unless the request freezes %s', async (choice) => {
      apiFetchMock.mockImplementation(async (_url, init) => {
        const body = JSON.parse(init.body);
        const idMap: Record<string, string> = {};
        const nodes = body.nodes.map((spec: { tempId: string; definitionId: string; params: Record<string, unknown> }, index: number) => {
          const id = `n${index + 1}`;
          idMap[spec.tempId] = id;
          return { id, type: 'model-node', position: { x: 0, y: 0 }, data: {
            label: spec.definitionId, definitionId: spec.definitionId, params: spec.params, state: 'idle', outputs: {},
          } };
        });
        return { ok: true, json: async () => ({ idMap, nodes, edges: [] }) };
      });
      const { modelNodeIds } = await useGraphStore.getState().authorGenerationCluster({
        definitionId: modelId, prompt: 'logo', params: choice ? { _kreaAuth: choice } : {},
        refPaths: [], quantity: 1, sessionId: 's', genId: 'g', layoutOrigin: { x: 0, y: 0 },
      });
      const authored = useGraphStore.getState().nodes.find((node) => modelNodeIds.includes(node.id));
      expect(authored?.data.params._kreaAuth).toBe(choice ?? 'mcp');
      expect(authored?.data.keyStatus).toBe(choice ? 'missing' : undefined);
      expect(useGraphStore.getState().runHistory).toEqual([]);
    },
  );

  it.each([{}, { _kreaAuth: 'api-token' }, { _kreaAuth: 'mcp' }])(
    'replays the exact saved billing params %j despite current defaults and live node edits', async (params) => {
      const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
      const source: RunRecord = { id: 'saved-run', trigger: 'graph', status: 'complete', startedAt: 1,
        snapshot: { nodes: [{ id: 'n1', definitionId: modelId, params: { prompt: 'old logo', ...params }, outputs: {} }], edges: [] } };
      useGraphStore.setState({ runHistory: [source], nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'Edited', definitionId: modelId, params: { prompt: 'new logo', _kreaAuth: 'api-token' }, state: 'idle', outputs: {} } }] });
      await useGraphStore.getState().rerunHistoryRecord(source.id);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0]).toEqual(source.snapshot.nodes);
      expect(useGraphStore.getState().runHistory.find((run) => run.id === source.id)?.snapshot).toEqual(source.snapshot);
      expect(useGraphStore.getState().runHistory[0].snapshot.nodes[0].params).toEqual({ prompt: 'old logo', ...params });
      expect(useGraphStore.getState().nodes[0].data.params).toEqual({ prompt: 'new logo', _kreaAuth: 'api-token' });
    },
  );
});
