import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();

vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  rewriteBackendAssetUrls: vi.fn((value: unknown) => value),
}));

import {
  acknowledgeProviderStartAmbiguity,
  cancelExecution,
  deleteProviderRecovery,
  executeGraph,
  executeNode,
  ExecutionStartRejectedError,
  generateCinemaShot,
  getExecutionStatus,
} from '../../src/lib/api';

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

  it('reconciles the exact encoded run without accepting a cached status', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ runId: 'run / one', status: 'running' }),
    });

    await expect(getExecutionStatus('run / one')).resolves.toEqual({
      runId: 'run / one',
      status: 'running',
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/executions/run%20%2F%20one', {
      cache: 'no-store',
    });
  });

  it('marks a received HTTP start rejection as definite', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ detail: 'A paid start is already active.' }),
    });

    const rejection = executeGraph(nodes, edges, 'run-rejected');

    await expect(rejection).rejects.toBeInstanceOf(ExecutionStartRejectedError);
    await expect(rejection).rejects.toMatchObject({
      message: 'A paid start is already active.',
      status: 409,
    });
  });

  it.each([408, 500, 502])(
    'treats HTTP %s as an ambiguous start because a proxy may have forwarded it',
    async (status) => {
      apiFetchMock.mockResolvedValueOnce({
        ok: false,
        status,
        statusText: 'Gateway failure',
        json: async () => ({ detail: 'Upstream response was lost.' }),
      });

      const rejection = executeGraph(nodes, edges, `run-ambiguous-${status}`);

      await expect(rejection).rejects.toThrow('Upstream response was lost.');
      await expect(rejection).rejects.not.toBeInstanceOf(ExecutionStartRejectedError);
    },
  );

  it('treats the durable-safety HTTP 507 as a definite pre-provider rejection', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 507,
      statusText: 'Insufficient Storage',
      json: async () => ({ detail: 'Could not create a durable safety record.' }),
    });

    await expect(executeGraph(nodes, edges, 'run-no-journal')).rejects.toMatchObject({
      name: 'ExecutionStartRejectedError',
      status: 507,
    });
  });

  it('acknowledges only the exact encoded paid-start hold', async () => {
    await acknowledgeProviderStartAmbiguity(
      'worldlabs-world-export',
      'node / one',
      'run / one',
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/provider-start-ambiguities/worldlabs-world-export/node%20%2F%20one/run%20%2F%20one',
      { method: 'DELETE' },
    );
  });

  it('deletes only the exact encoded provider recovery checkpoint', async () => {
    await deleteProviderRecovery('run / one', 'node / one', {
      resumeOperationId: 'operation / one',
      existingWorldId: null,
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/provider-recoveries/run%20%2F%20one/node%20%2F%20one?resume_operation_id=operation+%2F+one',
      { method: 'DELETE' },
    );
  });

  it('deletes an exact world checkpoint and rejects an invalid identity', async () => {
    await deleteProviderRecovery('run', 'node', {
      resumeOperationId: null,
      existingWorldId: 'world/accepted',
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/provider-recoveries/run/node?existing_world_id=world%2Faccepted',
      { method: 'DELETE' },
    );
    await expect(deleteProviderRecovery('run', 'node', {
      resumeOperationId: null,
      existingWorldId: null,
    })).rejects.toThrow('requires exactly one recovery ID');
  });
});
