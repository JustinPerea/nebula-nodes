import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import type { ExecutionEvent } from '../src/lib/wsClient';
import { setProjectContext } from '../src/lib/projectContext';

// Round 11 of PR #114 (review 10, item 6): a run's start that fails after the
// graph was replaced (an agent opened another project, a graph was loaded)
// must not mark the new graph's nodes that happen to share its node ids, and
// the replaced graph's run is no longer this tab's current run.

const transport = vi.hoisted(() => ({ fetch: vi.fn(), sync: null as ((event: ExecutionEvent) => void) | null }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), subscribe: vi.fn((handler) => { transport.sync = handler; }), disconnect: vi.fn(),
} }));
import * as api from '../src/lib/api';
import { useGraphStore } from '../src/store/graphStore';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const OUT_OF_DATE = 'This canvas is out of date. Open the current project before editing or running it.';

function node(value: string, id = 'n1'): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 100 },
    data: { label: 'Text', definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} } };
}
function response(body: unknown = {}) { return { ok: true, status: 200, json: async () => body } as Response; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The backend opened project B (an agent's switch): B's own n1 replaces A's. */
function switchToB(): void {
  setProjectContext({ id: 'B', revision: 'b' });
  transport.sync?.({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, workspaceRevision: 'b',
    graphReplaced: true, nodes: [node("B's own")], edges: [], empty: false } as ExecutionEvent);
}

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.setState({ isImportingGraph: false, providerStartAmbiguities: [], uncertainWorldLabsRunId: null });
  expect(useGraphStore.getState().loadProjectGraph([node("A's own")], [], [], { bootstrap: true })).toBe(true);
  localStorage.clear();
  transport.fetch.mockReset().mockResolvedValue(response());
  vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  setProjectContext(null);
});

describe('a run started on a graph that was replaced before its start answered', () => {
  it.each([
    ['executeNode', () => useGraphStore.getState().executeNode('n1'), 'executeNode'],
    ['executeGraph', () => useGraphStore.getState().executeGraph(), 'executeGraph'],
    ['executeCluster', () => useGraphStore.getState().executeCluster(['n1']), 'executeGraph'],
  ] as const)('%s: a refused start marks nothing on the new graph and still ends the run', async (_name, start, call) => {
    const answer = deferred<never>();
    vi.spyOn(api, call).mockReturnValue(answer.promise);
    const running = start();
    expect(useGraphStore.getState().isExecuting).toBe(true);
    switchToB();
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe("B's own");
    answer.reject(new api.ExecutionStartRejectedError(OUT_OF_DATE, 409));
    await running;
    const state = useGraphStore.getState();
    const b1 = state.nodes.find((candidate) => candidate.id === 'n1')!;
    expect(b1.data.params.value).toBe("B's own");
    expect(b1.data.state).not.toBe('error');
    expect(b1.data.error).toBeUndefined();
    // The run itself still closes, so Run isn't stuck.
    expect(state.isExecuting).toBe(false);
    expect(state.activeRuns).toEqual([]);
  });

  it('a refused start on the graph it started on still marks its nodes', async () => {
    const answer = deferred<never>();
    vi.spyOn(api, 'executeNode').mockReturnValue(answer.promise);
    const running = useGraphStore.getState().executeNode('n1');
    answer.reject(new api.ExecutionStartRejectedError('Nope.', 409));
    await running;
    const a1 = useGraphStore.getState().nodes.find((candidate) => candidate.id === 'n1')!;
    expect(a1.data.state).toBe('error');
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('the replaced graph\'s run is no longer the current run: an event without a run id is not its', async () => {
    const answer = deferred<api.ExecutionStartResult>();
    vi.spyOn(api, 'executeNode').mockReturnValue(answer.promise);
    const running = useGraphStore.getState().executeNode('n1');
    const runId = useGraphStore.getState().runHistory[0].id;
    switchToB();
    // An event from an older backend carries no runId: before, the open
    // run took it as its own and recorded B's output in A's run.
    transport.sync?.({ type: 'executed', workspaceRevision: 'b', nodeId: 'n1',
      outputs: { text: { type: 'Text', value: "B's output" } } } as unknown as ExecutionEvent);
    const record = useGraphStore.getState().runHistory.find((candidate) => candidate.id === runId)!;
    expect(record.resultOutputs?.n1).toBeUndefined();
    answer.reject(new api.ExecutionStartRejectedError(OUT_OF_DATE, 409));
    await running;
  });
});
