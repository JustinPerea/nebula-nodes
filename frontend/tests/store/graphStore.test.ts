import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

// Mock WebSocket for jsdom
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: {
    connect: vi.fn(),
    subscribe: vi.fn(),
    disconnect: vi.fn(),
  },
}));

const backendDiscovery = vi.hoisted(() => ({ baseUrl: null as string | null }));
vi.mock('../../src/lib/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/backend')>();
  return {
    ...actual,
    getCachedBackendBaseUrl: () => backendDiscovery.baseUrl,
  };
});

// Mock fetch for api.ts. Store tests exercise the frontend-only fallback path,
// so backend requests should fail at the transport boundary by default.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});

import { useGraphStore } from '../../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../../src/lib/wsClient';

function mockResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function resetStore() {
  useGraphStore.setState({
    nodes: [],
    edges: [],
    undoStack: [],
    redoStack: [],
    clipboard: null,
    isExecuting: false,
    isCancelling: false,
    providerRecoveryWarning: null,
    uncertainWorldLabsRunId: null,
    providerRecoveries: [],
    providerStartAmbiguities: [],
    backendFreshStartPending: false,
  });
}

async function addNode(definitionId: string, position: { x: number; y: number }) {
  const nodeId = await useGraphStore.getState().addNode(definitionId, position);
  expect(nodeId).toBeTruthy();
  return nodeId as string;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  alertMock.mockClear();
  backendDiscovery.baseUrl = null;
});

describe('graphStore', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({
      nodes: [],
      edges: [],
      runHistory: [],
      isExecuting: false,
      isCancelling: false,
      providerRecoveryWarning: null,
      uncertainWorldLabsRunId: null,
      providerRecoveries: [],
      providerStartAmbiguities: [],
      backendFreshStartPending: false,
    });
    window.localStorage.clear();
  });

  it('does not release the paid-run lock when recovery hydration triggers graph sync', () => {
    const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
      | ((event: ExecutionEvent) => void)
      | undefined;
    expect(subscribed).toBeTypeOf('function');
    useGraphStore.setState({ isExecuting: true, isCancelling: true });

    subscribed?.({
      type: 'providerRecovery',
      runId: 'world-in-flight',
      nodeId: 'world',
      resumeOperationId: 'operation-accepted',
      existingWorldId: null,
      durable: true,
      warning: null,
    });
    subscribed?.({
      type: 'graphSync',
      nodes: [],
      edges: [],
      empty: true,
      providerRecoveries: [{
        runId: 'world-in-flight',
        nodeId: 'world',
        resumeOperationId: 'operation-accepted',
        existingWorldId: null,
        durable: true,
        warning: null,
      }],
    });

    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: true,
    });
  });

  it('does not let a delayed empty snapshot erase newer live provider safety', () => {
    const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
      | ((event: ExecutionEvent) => void)
      | undefined;
    useGraphStore.setState({
      nodes: [
        {
          id: 'world-recovered',
          type: 'model-node',
          position: { x: 0, y: 0 },
          data: {
            label: 'Recovered World',
            definitionId: 'worldlabs-environment',
            params: {},
            state: 'idle',
            outputs: {},
          },
        },
        {
          id: 'world-ambiguous',
          type: 'model-node',
          position: { x: 300, y: 0 },
          data: {
            label: 'Ambiguous World',
            definitionId: 'worldlabs-environment',
            params: {},
            state: 'idle',
            outputs: {},
          },
        },
      ],
      edges: [],
    });

    subscribed?.({
      type: 'providerRecovery',
      runId: 'paid-run',
      nodeId: 'world-recovered',
      resumeOperationId: 'operation-accepted',
      existingWorldId: null,
      durable: true,
      warning: null,
    });
    subscribed?.({
      type: 'providerStartAmbiguous',
      runId: 'ambiguous-run',
      nodeId: 'world-ambiguous',
      kind: 'worldlabs-environment',
      message: 'The paid start may have been accepted.',
      durable: true,
    });

    subscribed?.({
      type: 'graphSync',
      nodes: [],
      edges: [],
      empty: true,
      providerRecoveries: [],
      providerStartAmbiguities: [],
    });

    expect(useGraphStore.getState()).toMatchObject({
      providerRecoveries: [expect.objectContaining({
        runId: 'paid-run',
        nodeId: 'world-recovered',
        resumeOperationId: 'operation-accepted',
      })],
      providerStartAmbiguities: [expect.objectContaining({
        runId: 'ambiguous-run',
        nodeId: 'world-ambiguous',
      })],
      nodes: [expect.objectContaining({
        id: 'world-recovered',
        data: expect.objectContaining({
          params: { resume_operation_id: 'operation-accepted' },
        }),
      }), expect.objectContaining({ id: 'world-ambiguous' })],
    });
  });

  it('overlays a reconnect checkpoint onto graphSync params used for serialization', () => {
    const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
      | ((event: ExecutionEvent) => void)
      | undefined;

    subscribed?.({
      type: 'graphSync',
      nodes: [{
        id: 'n1',
        type: 'model-node',
        position: { x: 10, y: 20 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: { model: 'marble-1.1' },
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
      empty: false,
      providerRecoveries: [{
        runId: 'paid-run',
        nodeId: 'n1',
        resumeOperationId: null,
        existingWorldId: 'world-accepted',
        durable: true,
      }],
    });

    expect(useGraphStore.getState().nodes).toEqual([
      expect.objectContaining({
        id: 'n1',
        data: expect.objectContaining({
          params: {
            model: 'marble-1.1',
            existing_world_id: 'world-accepted',
          },
        }),
      }),
    ]);
  });

  it.each([
    ['completed', 'complete'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'settles a reconnect snapshot whose tracked run is %s',
    async (backendStatus, historyStatus) => {
      const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
        | ((event: ExecutionEvent) => void)
        | undefined;
      fetchMock.mockResolvedValueOnce(mockResponse({ status: 'started' }));
      useGraphStore.setState({
        nodes: [{
          id: 'world',
          type: 'model-node',
          position: { x: 0, y: 0 },
          data: {
            label: 'World Labs Environment',
            definitionId: 'worldlabs-environment',
            params: {},
            state: 'idle',
            outputs: {},
          },
        }],
        edges: [],
      });
      await useGraphStore.getState().executeGraph();
      const runId = useGraphStore.getState().runHistory[0].id;

      subscribed?.({
        type: 'graphSync',
        nodes: [],
        edges: [],
        empty: true,
        executionStatuses: [{ runId, status: backendStatus }],
      });

      expect(useGraphStore.getState()).toMatchObject({
        isExecuting: false,
        isCancelling: false,
        runHistory: [expect.objectContaining({ id: runId, status: historyStatus })],
      });
    },
  );

  it('settles only the exact current run from a terminal executionStatus event', async () => {
    const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
      | ((event: ExecutionEvent) => void)
      | undefined;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 'started' }));
    useGraphStore.setState({
      nodes: [{
        id: 'world',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;

    subscribed?.({
      type: 'executionStatus',
      runId: 'unrelated-run',
      status: 'completed',
    });
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      runHistory: [expect.objectContaining({ id: runId, status: 'running' })],
    });

    subscribed?.({ type: 'executionStatus', runId, status: 'completed' });
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
      runHistory: [expect.objectContaining({ id: runId, status: 'complete' })],
    });
  });

  it('keeps the tracked lock for running and cancelling reconnect snapshots', async () => {
    const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
      | ((event: ExecutionEvent) => void)
      | undefined;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 'started' }));
    useGraphStore.setState({
      nodes: [{
        id: 'world',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;

    subscribed?.({
      type: 'graphSync',
      nodes: [],
      edges: [],
      empty: true,
      executionStatuses: [{ runId, status: 'cancelling' }],
    });
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: true,
    });

    subscribed?.({
      type: 'graphSync',
      nodes: [],
      edges: [],
      empty: true,
      executionStatuses: [{ runId, status: 'running' }],
    });
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: false,
      runHistory: [expect.objectContaining({ id: runId, status: 'running' })],
    });

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
  });

  it('marks a paid run uncertain when an authoritative reconnect snapshot omits it', async () => {
    const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
      | ((event: ExecutionEvent) => void)
      | undefined;
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 'started' }));
    useGraphStore.setState({
      nodes: [{
        id: 'world',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;

    subscribed?.({
      type: 'graphSync',
      nodes: [],
      edges: [],
      empty: true,
      executionStatuses: [{ runId: 'unrelated-run', status: 'running' }],
    });

    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: false,
      uncertainWorldLabsRunId: runId,
      providerRecoveryWarning: expect.stringContaining('Run remains locked'),
      runHistory: [expect.objectContaining({ id: runId, status: 'running' })],
    });

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
  });

  it.each([
    ['running', 'completed', 'complete'],
    ['cancelling', 'cancelled', 'cancelled'],
  ] as const)(
    'polls a reconnect snapshot from %s until the tracked run becomes %s',
    async (snapshotStatus, terminalStatus, historyStatus) => {
      vi.useFakeTimers();
      try {
        const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
          | ((event: ExecutionEvent) => void)
          | undefined;
        fetchMock.mockResolvedValueOnce(mockResponse({ status: 'started' }));
        useGraphStore.setState({
          nodes: [{
            id: 'world',
            type: 'model-node',
            position: { x: 0, y: 0 },
            data: {
              label: 'World Labs Environment',
              definitionId: 'worldlabs-environment',
              params: {},
              state: 'idle',
              outputs: {},
            },
          }],
          edges: [],
        });
        await useGraphStore.getState().executeGraph();
        const runId = useGraphStore.getState().runHistory[0].id;
        fetchMock.mockResolvedValueOnce(mockResponse({ runId, status: terminalStatus }));

        subscribed?.({
          type: 'graphSync',
          nodes: [],
          edges: [],
          empty: true,
          executionStatuses: [{ runId, status: snapshotStatus }],
        });
        expect(useGraphStore.getState()).toMatchObject({
          isExecuting: true,
          isCancelling: snapshotStatus === 'cancelling',
        });

        await vi.advanceTimersByTimeAsync(2_000);

        expect(useGraphStore.getState()).toMatchObject({
          isExecuting: false,
          isCancelling: false,
          uncertainWorldLabsRunId: null,
          runHistory: [expect.objectContaining({ id: runId, status: historyStatus })],
        });
      } finally {
        useGraphStore.getState().resetExecution();
        vi.useRealTimers();
      }
    },
  );

  it('starts with empty nodes and edges', () => {
    const state = useGraphStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
  });

  it('persists settled drag positions through the atomic layout endpoint', async () => {
    useGraphStore.setState({
      nodes: [{
        id: 'n1',
        type: 'model-node',
        position: { x: 10, y: 20 },
        data: {
          label: 'Text Input',
          definitionId: 'text-input',
          params: {},
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 'updated', count: 1 }));

    useGraphStore.getState().onNodesChange([{
      type: 'position',
      id: 'n1',
      position: { x: 125, y: 240 },
      dragging: false,
    }]);

    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 125, y: 240 });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8000/api/graph/layout',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ positions: { n1: { x: 125, y: 240 } } }),
        }),
      );
    });
  });

  it('adds a node', async () => {
    await addNode('gpt-image-1-generate', { x: 100, y: 200 });

    const { nodes } = useGraphStore.getState();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('model-node');
    expect(nodes[0].position).toEqual({ x: 100, y: 200 });
    expect(nodes[0].data.definitionId).toBe('gpt-image-1-generate');
    expect(nodes[0].data.label).toBe('GPT Image 1');
    expect(nodes[0].data.state).toBe('idle');
  });

  it('sends World Labs blank seed default to the backend without adding a local ghost on success', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ empty: true, nodes: [], edges: [] }))
      .mockResolvedValueOnce(mockResponse({ id: 'n1', definitionId: 'worldlabs-environment' }));

    const nodeId = await useGraphStore.getState().addNode(
      'worldlabs-environment',
      { x: 120, y: 80 },
    );

    expect(nodeId).toBe('n1');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8000/api/graph/node');
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as {
      definitionId: string;
      params: Record<string, unknown>;
    };
    expect(payload.definitionId).toBe('worldlabs-environment');
    expect(payload.params.seed).toBe('');
    // A successful backend create is hydrated by graphSync; addNode must not
    // independently append the fallback UUID that caused the visible ghost.
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('surfaces a World Labs 400 rejection without adding a local ghost', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ empty: true, nodes: [], edges: [] }))
      .mockResolvedValueOnce(mockResponse({
        detail: "Invalid value for param 'seed': expected integer or null",
      }, false, 400));

    const nodeId = await useGraphStore.getState().addNode(
      'worldlabs-environment',
      { x: 120, y: 80 },
    );

    expect(nodeId).toBeNull();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(alertMock).toHaveBeenCalledWith(
      expect.stringContaining("Invalid value for param 'seed'"),
    );
  });

  it('does not reinterpret a backend 503 node rejection as offline local mode', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ empty: true, nodes: [], edges: [] }))
      .mockResolvedValueOnce(mockResponse({ detail: 'Paid-start safety journal unavailable' }, false, 503));

    const nodeId = await useGraphStore.getState().addNode('worldlabs-environment', { x: 20, y: 40 });

    expect(nodeId).toBeNull();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
    expect(alertMock).toHaveBeenCalledWith(
      expect.stringContaining('Paid-start safety journal unavailable'),
    );
  });

  it('does not add a local node when the backend rejects the fresh-canvas clear', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ empty: false, nodes: [{ id: 'n9' }], edges: [] }))
      .mockResolvedValueOnce(mockResponse({ detail: 'Graph has protected provider state' }, false, 409));

    const nodeId = await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });

    expect(nodeId).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useGraphStore.getState().nodes).toHaveLength(0);
    expect(alertMock).toHaveBeenCalledWith(
      expect.stringContaining('Backend rejected graph clear (HTTP 409)'),
    );
  });

  it('clears stale backend graph before the first manual node on an empty canvas', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ empty: false, nodes: [{ id: 'n9' }], edges: [] }))
      .mockResolvedValueOnce(mockResponse({ status: 'ok' }))
      .mockResolvedValueOnce(mockResponse({ id: 'n1' }));

    const nodeId = await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });

    expect(nodeId).toBe('n1');
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:8000/api/graph/export');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:8000/api/graph', { method: 'DELETE' });
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8000/api/graph/node');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'POST' });
    expect(useGraphStore.getState().backendFreshStartPending).toBe(false);
  });

  it('does not clear backend graph when the local canvas already has nodes', async () => {
    useGraphStore.setState({
      nodes: [{
        id: 'local-1',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'Text Input',
          definitionId: 'text-input',
          params: {},
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
      backendFreshStartPending: false,
    });
    fetchMock.mockResolvedValueOnce(mockResponse({ id: 'n2' }));

    const nodeId = await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });

    expect(nodeId).toBe('n2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/api/graph/node');
  });

  it('keeps the first empty-canvas node local when no backend was discovered', async () => {
    backendDiscovery.baseUrl = null;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const nodeId = await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });

    expect(nodeId).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(useGraphStore.getState().backendFreshStartPending).toBe(true);
  });

  it('reconciles a committed backend node instead of adding a local duplicate when its response is lost', async () => {
    const committedNode: Node<NodeData> = {
      id: 'n1',
      type: 'model-node',
      position: { x: 10, y: 20 },
      data: {
        label: 'World Environment',
        definitionId: 'worldlabs-environment',
        params: { seed: null },
        state: 'idle',
        outputs: {},
      },
    };
    fetchMock
      .mockResolvedValueOnce(mockResponse({ empty: true, nodes: [], edges: [] }))
      .mockRejectedValueOnce(new TypeError('Response connection lost'))
      .mockResolvedValueOnce(mockResponse({
        empty: false,
        nodes: [committedNode],
        edges: [],
      }));

    const nodeId = await useGraphStore.getState().addNode('worldlabs-environment', { x: 10, y: 20 });

    expect(nodeId).toBe('n1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(useGraphStore.getState().nodes[0].id).toBe('n1');
    expect(useGraphStore.getState().nodes[0].data.definitionId).toBe('worldlabs-environment');
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('blocks another create while a sent node-create result remains uncertain', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ empty: true, nodes: [], edges: [] }))
      .mockRejectedValueOnce(new TypeError('Response connection lost'))
      .mockRejectedValueOnce(new TypeError('Reconciliation unavailable'));

    const firstNodeId = await useGraphStore.getState().addNode('worldlabs-environment', { x: 10, y: 20 });
    const secondNodeId = await useGraphStore.getState().addNode('worldlabs-environment', { x: 30, y: 40 });

    expect(firstNodeId).toBeNull();
    expect(secondNodeId).toBeNull();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
    const mutationCalls = fetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === 'POST');
    expect(mutationCalls).toHaveLength(1);
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('unknown result'));

    // Authoritative graphSync resolves the transient fence for subsequent tests.
    const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0]?.[0] as
      | ((event: ExecutionEvent) => void)
      | undefined;
    subscribed?.({
      type: 'graphSync',
      empty: false,
      nodes: [{
        id: 'n1',
        type: 'model-node',
        position: { x: 10, y: 20 },
        data: {
          label: 'World Environment',
          definitionId: 'worldlabs-environment',
          params: { seed: null },
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    } as ExecutionEvent);
  });

  it('does not enter local mode when a previously discovered backend drops before create', async () => {
    backendDiscovery.baseUrl = 'http://localhost:8000';
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const nodeId = await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });

    expect(nodeId).toBeNull();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('known backend'));
  });

  it('removes a node and cleans up connected edges', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    await addNode('gpt-image-1-generate', { x: 300, y: 0 });

    const { nodes } = useGraphStore.getState();
    const sourceId = nodes[0].id;
    const targetId = nodes[1].id;

    useGraphStore.setState((state) => ({
      edges: [
        ...state.edges,
        {
          id: 'test-edge',
          source: sourceId,
          sourceHandle: 'text',
          target: targetId,
          targetHandle: 'prompt',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
      ],
    }));

    expect(useGraphStore.getState().edges).toHaveLength(1);

    const { onNodesChange } = useGraphStore.getState();
    onNodesChange([{ type: 'remove', id: sourceId }]);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.edges).toHaveLength(0);
  });

  it('removes a node without affecting unrelated edges', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    await addNode('gpt-image-1-generate', { x: 300, y: 0 });
    await addNode('preview', { x: 600, y: 0 });

    const { nodes } = useGraphStore.getState();
    const [textNode, gptNode, previewNode] = nodes;

    useGraphStore.setState({
      edges: [
        {
          id: 'edge-1',
          source: textNode.id,
          sourceHandle: 'text',
          target: gptNode.id,
          targetHandle: 'prompt',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
        {
          id: 'edge-2',
          source: gptNode.id,
          sourceHandle: 'image',
          target: previewNode.id,
          targetHandle: 'input',
          type: 'typed-edge',
          data: { dataType: 'Image' },
        },
      ],
    });

    const { onNodesChange } = useGraphStore.getState();
    onNodesChange([{ type: 'remove', id: textNode.id }]);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].id).toBe('edge-2');
  });

  it('keeps a CLI node visible when the backend rejects its deletion', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const cliNode: Node<NodeData> = {
      id: 'n1',
      type: 'model-node',
      position: { x: 0, y: 0 },
      data: {
        definitionId: 'worldlabs-environment',
        label: 'World Labs Environment',
        params: {},
        state: 'idle',
        outputs: {},
      },
    };
    useGraphStore.setState({ nodes: [cliNode], edges: [] });
    fetchMock.mockResolvedValueOnce(mockResponse(
      { detail: 'Cannot delete while provider recovery is unresolved.' },
      false,
      409,
    ));

    useGraphStore.getState().onNodesChange([{ type: 'remove', id: cliNode.id }]);

    expect(useGraphStore.getState().nodes).toEqual([cliNode]);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining(
      'Cannot delete while provider recovery is unresolved.',
    )));
    expect(useGraphStore.getState().nodes).toEqual([cliNode]);
  });

  it('replaces an existing wire on non-multiple input handles', () => {
    useGraphStore.setState({
      nodes: [
        {
          id: 'source-a',
          type: 'model-node',
          position: { x: 0, y: 0 },
          data: { label: 'Text A', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} },
        },
        {
          id: 'source-b',
          type: 'model-node',
          position: { x: 0, y: 120 },
          data: { label: 'Image B', definitionId: 'image-input', params: {}, state: 'idle', outputs: {} },
        },
        {
          id: 'preview-1',
          type: 'model-node',
          position: { x: 320, y: 0 },
          data: { label: 'Preview', definitionId: 'preview', params: {}, state: 'idle', outputs: {} },
        },
      ],
      edges: [
        {
          id: 'old-edge',
          source: 'source-a',
          sourceHandle: 'text',
          target: 'preview-1',
          targetHandle: 'input',
          type: 'typed-edge',
        },
      ],
    });

    useGraphStore.getState().onConnect({
      source: 'source-b',
      sourceHandle: 'image',
      target: 'preview-1',
      targetHandle: 'input',
    });

    const edges = useGraphStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].id).not.toBe('old-edge');
    expect(edges[0]).toMatchObject({
      source: 'source-b',
      sourceHandle: 'image',
      target: 'preview-1',
      targetHandle: 'input',
    });
  });

  it('keeps multiple wires on multiple input handles', () => {
    useGraphStore.setState({
      nodes: [
        {
          id: 'image-a',
          type: 'model-node',
          position: { x: 0, y: 0 },
          data: { label: 'Image A', definitionId: 'image-input', params: {}, state: 'idle', outputs: {} },
        },
        {
          id: 'image-b',
          type: 'model-node',
          position: { x: 0, y: 120 },
          data: { label: 'Image B', definitionId: 'image-input', params: {}, state: 'idle', outputs: {} },
        },
        {
          id: 'gemini-1',
          type: 'model-node',
          position: { x: 320, y: 0 },
          data: { label: 'Gemini', definitionId: 'gemini-chat', params: {}, state: 'idle', outputs: {} },
        },
      ],
      edges: [
        {
          id: 'old-edge',
          source: 'image-a',
          sourceHandle: 'image',
          target: 'gemini-1',
          targetHandle: 'images',
          type: 'typed-edge',
        },
      ],
    });

    useGraphStore.getState().onConnect({
      source: 'image-b',
      sourceHandle: 'image',
      target: 'gemini-1',
      targetHandle: 'images',
    });

    const edges = useGraphStore.getState().edges;
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => edge.source)).toEqual(['image-a', 'image-b']);
  });
});

// ---------------------------------------------------------------------------
// Undo/Redo tests
// ---------------------------------------------------------------------------

describe('undo/redo', () => {
  beforeEach(resetStore);

  it('undo restores previous state after addNode', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    expect(useGraphStore.getState().nodes).toHaveLength(1);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('redo restores the undone state', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);

    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('undo preserves node outputs', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    const nodeId = useGraphStore.getState().nodes[0].id;

    // Simulate execution producing an output (not a param change, won't push undo)
    useGraphStore.setState((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, state: 'complete', outputs: { text: { type: 'Text', value: 'hello world' } } } }
          : n
      ),
    }));

    // Change a param (this pushes undo)
    useGraphStore.getState().updateNodeData(nodeId, { params: { value: 'new text' } });

    // Undo should restore the old params but keep the output
    useGraphStore.getState().undo();
    const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
    expect(node?.data.outputs).toMatchObject({ text: { type: 'Text', value: 'hello world' } });
  });

  it('new mutation clears redo stack', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().redoStack).toHaveLength(1);

    await addNode('text-input', { x: 200, y: 200 });
    expect(useGraphStore.getState().redoStack).toHaveLength(0);
  });

  it('caps undo stack at 50 entries', async () => {
    for (let i = 0; i < 60; i++) {
      await addNode('text-input', { x: i * 10, y: 0 });
    }
    expect(useGraphStore.getState().undoStack.length).toBeLessThanOrEqual(50);
  });

  it('undo does nothing when stack is empty', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    useGraphStore.setState({ undoStack: [] });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('redo does nothing when stack is empty', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    expect(useGraphStore.getState().redoStack).toHaveLength(0);
    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('loadGraph clears both stacks', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    expect(useGraphStore.getState().undoStack.length).toBeGreaterThan(0);
    useGraphStore.setState({ backendFreshStartPending: true });

    useGraphStore.getState().loadGraph([], []);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(useGraphStore.getState().redoStack).toHaveLength(0);
    expect(useGraphStore.getState().backendFreshStartPending).toBe(false);
  });

  it('clearGraph is undoable', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    // Reset undo stack so only the clearGraph push is tracked
    useGraphStore.setState({ undoStack: [] });

    useGraphStore.getState().clearGraph();
    expect(useGraphStore.getState().nodes).toHaveLength(0);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Copy/paste tests
// ---------------------------------------------------------------------------

describe('copy/paste', () => {
  beforeEach(resetStore);

  it('paste creates nodes with new IDs', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    const originalId = useGraphStore.getState().nodes[0].id;

    // Select and copy
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].id).not.toBe(originalId);
  });

  it('paste offsets position by 20px', async () => {
    await addNode('text-input', { x: 100, y: 200 });
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const pasted = useGraphStore.getState().nodes[1];
    expect(pasted.position.x).toBe(120);
    expect(pasted.position.y).toBe(220);
  });

  it('paste clears outputs and resets state to idle', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    const nodeId = useGraphStore.getState().nodes[0].id;

    // Manually set outputs on the node
    useGraphStore.setState((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, state: 'complete', outputs: { text: { type: 'Text', value: 'hello' } } } }
          : n
      ),
    }));

    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const pasted = useGraphStore.getState().nodes[1];
    expect(pasted.data.state).toBe('idle');
    expect(Object.keys(pasted.data.outputs)).toHaveLength(0);
  });

  it('paste remaps internal edges to new IDs', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    await addNode('claude-chat', { x: 300, y: 100 });
    const nodes = useGraphStore.getState().nodes;

    // Manually create an edge between them
    const edge = {
      id: 'test-edge',
      source: nodes[0].id,
      sourceHandle: 'text',
      target: nodes[1].id,
      targetHandle: 'messages',
      type: 'typed-edge',
    };
    useGraphStore.setState({ edges: [edge] });

    // Select all
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });

    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const allEdges = useGraphStore.getState().edges;
    expect(allEdges).toHaveLength(2);

    const pastedEdge = allEdges[1];
    expect(pastedEdge.id).not.toBe('test-edge');
    expect(pastedEdge.source).not.toBe(nodes[0].id);
    expect(pastedEdge.target).not.toBe(nodes[1].id);
  });

  it('copySelected with no selection does not set clipboard', async () => {
    await addNode('text-input', { x: 100, y: 100 });
    // Nodes are not selected
    useGraphStore.getState().copySelected();
    expect(useGraphStore.getState().clipboard).toBeNull();
  });

  it('pasteClipboard with empty clipboard does nothing', () => {
    useGraphStore.setState({ clipboard: null });
    useGraphStore.getState().pasteClipboard();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectAll and duplicateSelected tests
// ---------------------------------------------------------------------------

describe('selectAll', () => {
  beforeEach(resetStore);

  it('selects all nodes', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    await addNode('text-input', { x: 100, y: 0 });

    useGraphStore.getState().selectAll();

    const { nodes } = useGraphStore.getState();
    expect(nodes.every((n) => n.selected)).toBe(true);
  });
});

describe('duplicateSelected', () => {
  beforeEach(resetStore);

  it('duplicates selected nodes with new IDs and 20px offset', async () => {
    await addNode('text-input', { x: 50, y: 50 });
    const originalId = useGraphStore.getState().nodes[0].id;

    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().duplicateSelected();

    const { nodes } = useGraphStore.getState();
    expect(nodes).toHaveLength(2);
    expect(nodes[1].id).not.toBe(originalId);
    expect(nodes[1].position).toEqual({ x: 70, y: 70 });
  });

  it('duplicates selected along with internal edges', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    await addNode('claude-chat', { x: 200, y: 0 });
    const [n1, n2] = useGraphStore.getState().nodes;

    useGraphStore.setState({
      edges: [{ id: 'e1', source: n1.id, sourceHandle: 'text', target: n2.id, targetHandle: 'messages', type: 'typed-edge' }],
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });

    useGraphStore.getState().duplicateSelected();

    const { edges } = useGraphStore.getState();
    expect(edges).toHaveLength(2);
    expect(edges[1].id).not.toBe('e1');
  });

  it('does nothing when nothing is selected', async () => {
    await addNode('text-input', { x: 0, y: 0 });
    const beforeCount = useGraphStore.getState().nodes.length;
    useGraphStore.getState().duplicateSelected();
    expect(useGraphStore.getState().nodes).toHaveLength(beforeCount);
  });
});

describe('cinema shot variation promotion', () => {
  beforeEach(resetStore);

  function seedCinemaNode(id: string) {
    const node: Node<NodeData> = {
      id,
      type: 'cinemaSceneNode',
      position: { x: 0, y: 0 },
      data: {
        label: 'Cinema Scene',
        definitionId: 'cinema-scene',
        params: {
          scene: {
            version: 1,
            base: { model: 'seedream-4-5' },
            aspectRatio: '16:9',
            shots: [
              { id: 'a', prompt: 'A', output: { imageUrl: 'URL_A', status: 'done' } },
              {
                id: 'b',
                prompt: 'B',
                output: { imageUrl: 'URL_B_v0', status: 'done' },
                variations: [
                  { url: 'URL_B_v0', seed: 10 },
                  { url: 'URL_B_v1', seed: 11 },
                ],
                selectedVariation: 0,
              },
            ],
          },
        },
        state: 'idle',
        outputs: {
          shot_a: { type: 'Image', value: 'URL_A' },
          shot_b: { type: 'Image', value: 'URL_B_v0' },
        },
      },
    };
    useGraphStore.setState({ nodes: [node], edges: [] });
  }

  it('persists CLI promotion and updates the local dynamic output port', async () => {
    seedCinemaNode('n1');
    fetchMock.mockResolvedValueOnce(mockResponse({
      status: 'promoted',
      shotId: 'b',
      selectedVariation: 1,
      imageUrl: 'URL_B_v1',
    }));

    await useGraphStore.getState().promoteShotVariation('n1', 'b', 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/api/cinema/promote-shot-variation');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      nodeId: 'n1',
      shotId: 'b',
      index: 1,
    });
    const node = useGraphStore.getState().nodes[0];
    const scene = node.data.params.scene as {
      shots: Array<{ id: string; selectedVariation?: number; output?: { imageUrl?: string } }>;
    };
    const shotB = scene.shots.find((shot) => shot.id === 'b');
    expect(shotB?.selectedVariation).toBe(1);
    expect(shotB?.output).toEqual({ imageUrl: 'URL_B_v1', status: 'done' });
    expect(node.data.outputs.shot_a.value).toBe('URL_A');
    expect(node.data.outputs.shot_b).toEqual({ type: 'Image', value: 'URL_B_v1' });
  });

  it('updates both fields locally for a frontend-only Cinema node', async () => {
    seedCinemaNode('frontend-cinema');

    await useGraphStore.getState().promoteShotVariation('frontend-cinema', 'b', 1);

    expect(fetchMock).not.toHaveBeenCalled();
    const node = useGraphStore.getState().nodes[0];
    const scene = node.data.params.scene as {
      shots: Array<{ id: string; selectedVariation?: number; output?: { imageUrl?: string } }>;
    };
    expect(scene.shots.find((shot) => shot.id === 'b')?.selectedVariation).toBe(1);
    expect(node.data.outputs.shot_b.value).toBe('URL_B_v1');
  });
});

describe('graphStore streamPartialImage', () => {
  beforeEach(() => {
    const executingNode: Node<NodeData> = {
      id: 'n1',
      type: 'default',
      position: { x: 0, y: 0 },
      data: {
        label: 'GPT Image 2',
        definitionId: 'gpt-image-2-generate',
        params: {},
        state: 'executing',
        outputs: {},
      },
    };

    useGraphStore.setState({
      nodes: [executingNode],
      edges: [],
    });
  });

  it('appends partials in index order', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 1, src: '/b.png', isFinal: false });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toEqual([
      { index: 0, src: '/a.png' },
      { index: 1, src: '/b.png' },
    ]);
  });

  it('replaces partial at same index instead of appending duplicate', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a2.png', isFinal: false });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toEqual([{ index: 0, src: '/a2.png' }]);
  });

  it('clears partials on executed event', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'executed', nodeId: 'n1', outputs: { image: { type: 'Image', value: '/final.png' } } });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toBeUndefined();
  });

  it('sorts out-of-order partials by index', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 2, src: '/c.png', isFinal: false });
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials?.map(p => p.index)).toEqual([0, 2]);
  });

  it('clears partials on error event', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'error', nodeId: 'n1', error: 'test error' });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toBeUndefined();
  });
});
