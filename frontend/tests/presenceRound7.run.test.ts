/**
 * PR #204, a refused start's restore:
 * - the refusal marks and puts back the scope its start queued, not one read
 *   again when the refusal comes; a start Nebula took leaves no kept state behind; a node with no
 *   kept state (past the cap) goes back idle, never 'queued'.
 * - a refused shot goes back to the output it last settled with.
 * Harness from presenceRound6.run.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
import { beforeQueuedSizeForTests, resetDeletedSceneEditsForTests, useGraphStore } from '../src/store/graphStore';

// Scenes and the graph store: the per-node state a test left goes after each one (tests/sceneEditsResetRatchet).
afterEach(() => resetDeletedSceneEditsForTests());
import * as api from '../src/lib/api';
import { ExecutionStartRejectedError } from '../src/lib/api';
import { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } from '../src/lib/personSession';
import { PERSON_REQUIRED_CODE } from '../src/lib/errorCopy';
import { RUN_HISTORY_STORAGE_KEY } from '../src/lib/runHistory';

const gateStart = (heading: string) => new ExecutionStartRejectedError('needs the person', 403,
  { heading, detail: 'needs the person', code: PERSON_REQUIRED_CODE });
const text = (id: string, state = 'idle', extra: Record<string, unknown> = {}) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Brief', definitionId: 'text-input', params: { value: 'x' }, state, outputs: {}, ...extra } });
const fresh = (nodes: unknown[]) => useGraphStore.setState({ nodes: nodes as never, edges: [], runHistory: [], isExecuting: false,
  isCancelling: false, providerRecoveryWarning: null, uncertainWorldLabsRunId: null, providerRecoveries: [], providerStartAmbiguities: [] });

describe('a refused start restores the scope it queued', () => {
  beforeEach(() => {
    resetPersonSessionForTests();
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { notePersonPromoted(); vi.restoreAllMocks(); });

  it('a node that came onto the canvas while the start was out is not the refusal\'s', async () => {
    fresh([text('n1', 'complete')]);
    let refuse!: (error: unknown) => void;
    vi.spyOn(api, 'executeGraph').mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    reportPersonRequired();
    const run = useGraphStore.getState().executeGraph();
    await vi.waitFor(() => expect(refuse).toBeTypeOf('function'));
    // Added while the start was on its way (an agent's node, a paste): never queued by it.
    useGraphStore.setState((s) => ({ nodes: [...s.nodes, text('n2', 'complete', { outputs: { text: { type: 'Text', value: 'kept' } } })] as never }));
    refuse(gateStart("Couldn't run the graph."));
    await run;
    const byId = Object.fromEntries(useGraphStore.getState().nodes.map((n) => [n.id, n.data]));
    expect(byId.n1.state).toBe('error');
    expect([byId.n2.state, byId.n2.error]).toEqual(['complete', undefined]);
    notePersonPromoted();
    expect(useGraphStore.getState().nodes.map((n) => n.data.state)).toEqual(['complete', 'complete']);
  });

  it('a missing-key error goes back neutral, with its not-started heading, after a refused start', async () => {
    const keyLine = 'Add an OpenAI API key in Settings to run this node.';
    fresh([text('n1', 'error', { error: 'Missing API key: OPENAI_API_KEY', errorPerson: keyLine, errorNotStarted: true, errorMissingKey: true })]);
    vi.spyOn(api, 'executeGraph').mockImplementationOnce(() => Promise.reject(gateStart("Couldn't run the graph.")));
    reportPersonRequired();
    await useGraphStore.getState().executeGraph();
    // Marked by the refusal: the key's kind is cleared while its line shows.
    expect(useGraphStore.getState().nodes[0].data.errorMissingKey).toBeUndefined();
    notePersonPromoted();
    expect(useGraphStore.getState().nodes[0].data).toMatchObject({
      state: 'error', errorPerson: keyLine, errorNotStarted: true, errorMissingKey: true });
  });

  it('a start Nebula took leaves no kept state behind', async () => {
    fresh([text('n1', 'complete')]);
    vi.spyOn(api, 'executeNode').mockResolvedValueOnce({ status: 'started' } as never);
    await useGraphStore.getState().executeNode('n1');
    expect(beforeQueuedSizeForTests()).toBe(0);
  });

  it('a run of the whole canvas Nebula took leaves none either', async () => {
    fresh([text('n1', 'complete'), text('n2')]);
    vi.spyOn(api, 'executeGraph').mockResolvedValueOnce({ status: 'started' } as never);
    await useGraphStore.getState().executeGraph();
    expect(beforeQueuedSizeForTests()).toBe(0);
  });

  // A cluster start (Creator Studio's) queues with no resetExecution first.
  it('a cluster start Nebula took leaves none either', async () => {
    fresh([text('n1', 'complete'), text('n2')]);
    vi.spyOn(api, 'executeGraph').mockResolvedValueOnce({ status: 'started' } as never);
    await useGraphStore.getState().executeClusterConcurrent(['n1', 'n2']);
    expect(beforeQueuedSizeForTests()).toBe(0);
  });

  it('a node past the cap, with no kept state, goes back idle on the promote, never queued', async () => {
    fresh(Array.from({ length: 501 }, (_, i) => text(`t${i}`)));
    let refuse!: (error: unknown) => void;
    vi.spyOn(api, 'executeGraph').mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    reportPersonRequired();
    const run = useGraphStore.getState().executeGraph();
    await vi.waitFor(() => expect(refuse).toBeTypeOf('function'));
    expect(beforeQueuedSizeForTests()).toBe(500);
    refuse(gateStart("Couldn't run the graph."));
    await run;
    notePersonPromoted();
    const states = new Set(useGraphStore.getState().nodes.map((n) => n.data.state));
    expect([...states]).toEqual(['idle']);
  });
});

describe('a refused shot goes back to the output it last settled with', () => {
  const failedBefore = { status: 'error', error: 'The model said no.', errorPerson: 'The model said no.', seed: 7 };
  const sceneNode = (output: Record<string, unknown>) => ({ id: 'cine', type: 'cinema-scene', position: { x: 0, y: 0 },
    data: { definitionId: 'cinema-scene', label: 'Scene', state: 'idle', outputs: {},
      params: { scene: { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9', shots: [{ id: 's1', prompt: 'a cat', output }] } } } });
  const shotOutput = () => (useGraphStore.getState().nodes[0].data.params as { scene: { shots: { output?: unknown }[] } }).scene.shots[0].output;
  beforeEach(() => {
    resetPersonSessionForTests();
    useGraphStore.getState().resetExecution();
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { notePersonPromoted(); vi.restoreAllMocks(); });

  it('a shot that had failed for another reason shows that failure again, not idle', async () => {
    fresh([sceneNode(failedBefore)]);
    vi.spyOn(api, 'generateCinemaShot').mockRejectedValueOnce(gateStart("Couldn't start the shot."));
    reportPersonRequired();
    await useGraphStore.getState().executeShot('cine', 's1');
    expect(shotOutput()).toMatchObject({ status: 'error' });
    expect(shotOutput()).not.toMatchObject({ error: 'The model said no.' });
    notePersonPromoted();
    expect(shotOutput()).toEqual(failedBefore);
  });
});

describe('Generate\'s nodes added, their start refused for this tab (PR #204)', () => {
  const ADDED_NOT_STARTED_LINE = 'Nebula added the nodes to the canvas but couldn’t start the generation because this tab isn’t connected as you. Open the link Nebula printed when it started, then run them from the canvas.';
  const origin = { genId: 'g1', prompt: 'a lighthouse', ts: 1, sessionId: 's', modelNodeIds: ['n2'], allNodeIds: ['n1', 'n2'] };
  beforeEach(() => {
    resetPersonSessionForTests();
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { notePersonPromoted(); vi.restoreAllMocks(); });

  it('the result cards say design\'s line, whole, with no "try again"; the promote puts them back', async () => {
    fresh([text('n1'), text('n2')]);
    useGraphStore.setState({ createLaunchingIds: ['g1'], createCancelledLaunchIds: [] } as never);
    vi.spyOn(api, 'executeGraph').mockRejectedValueOnce(gateStart("Couldn't start the run."));
    await useGraphStore.getState().executeClusterConcurrent(['n1', 'n2'], origin as never);
    const cards = useGraphStore.getState().nodes.map((n) => n.data);
    expect(cards.map((d) => d.state)).toEqual(['error', 'error']);
    expect(cards.map((d) => d.error)).toEqual([ADDED_NOT_STARTED_LINE, ADDED_NOT_STARTED_LINE]);
    expect(cards.map((d) => d.errorPerson)).toEqual([undefined, undefined]);
    notePersonPromoted();
    expect(useGraphStore.getState().nodes.map((n) => n.data.state)).toEqual(['idle', 'idle']);
  });

  it('a start from the canvas (no Generate) keeps the run-start line', async () => {
    fresh([text('n1'), text('n2')]);
    vi.spyOn(api, 'executeGraph').mockRejectedValueOnce(gateStart("Couldn't start the run."));
    await useGraphStore.getState().executeClusterConcurrent(['n1', 'n2']);
    expect(useGraphStore.getState().nodes[0].data.error).not.toBe(ADDED_NOT_STARTED_LINE);
    expect(useGraphStore.getState().nodes[0].data.state).toBe('error');
  });
});
