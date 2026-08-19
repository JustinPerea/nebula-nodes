import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();

vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  rewriteBackendAssetUrls: vi.fn((value: unknown) => value),
}));

import { cancelExecution, executeGraph, executeNode, generateCinemaShot } from '../../src/lib/api';

const nodes = [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }];
const edges: Array<{
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}> = [];

describe('execution API run correlation', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'started' }),
    });
  });

  it('sends runId on graph, node, and Cinema-shot requests', async () => {
    await executeGraph(nodes, edges, 'run-graph');
    await executeNode(nodes, edges, 'n1', 'run-node');
    await generateCinemaShot(nodes, edges, 'n1', 'shot-a', 7, 2, 'run-shot');

    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body)).toMatchObject({ runId: 'run-graph' });
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body)).toMatchObject({
      targetNodeId: 'n1',
      runId: 'run-node',
    });
    expect(JSON.parse(apiFetchMock.mock.calls[2][1].body)).toMatchObject({
      nodeId: 'n1',
      shotId: 'shot-a',
      runId: 'run-shot',
    });
  });

  it('cancels the exact encoded backend run', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ runId: 'run / one', status: 'cancelled' }),
    });

    await expect(cancelExecution('run / one')).resolves.toEqual({
      runId: 'run / one',
      status: 'cancelled',
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/executions/run%20%2F%20one', {
      method: 'DELETE',
    });
  });
});
