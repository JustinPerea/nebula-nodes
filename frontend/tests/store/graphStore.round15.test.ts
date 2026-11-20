import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #114's store behaviour and the design lines:
 * - Accept's undo step owns only the ids it added and the
 *   param keys it changed.
 * - each save request tracks its own keys; design's one, two and
 *   three-or-more lines, exact.
 * - a failed model change names the model the node is on, as
 *   the picker shows it (the id), in mono.
 * - offline mid-drag, the node springs back to where the drag started.
 * - The earlier held-delete lines, restored with the node's name and reason.
 * - Create's cluster line uses the backend's person line.
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  getCachedBackendBaseUrl: () => 'http://localhost:8000',
}));
const socketSends = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const graphStore = await import('../../src/store/graphStore');
const { useGraphStore } = graphStore;
const { useCanvasProposalsStore } = await import('../../src/store/canvasProposalsStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { noteBackendConnection, resetBackendConnectionForTests, subscribeOfflinePulse } = await import('../../src/lib/backendConnection');
const { failureMessage } = await import('../../src/lib/errorCopy');
const { heldDeleteText, deleteRefusalText } = await import('../../src/lib/worldLabsWaiting');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const text = (id: string, label = 'Text Input') => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label, definitionId: 'text-input', params: { value: 'saved' }, state: 'idle', outputs: {} } });
const banana = (params: Record<string, unknown>) => ({ id: 'n5', type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Banana', definitionId: 'nano-banana', params, state: 'idle', outputs: {} } });
const notices: { line: string; mono?: string }[] = [];
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const PUSH_WAIT = 350;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  notices.length = 0;
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  // Since the #195 merge: a save's answer lingers for its echo, with
  // the values it saved; a test's canvas starts with none of it.
  useGraphStore.getState().loadGraph([], [], { allowDuringExecution: true });
  useGraphStore.setState({ nodes: [text('n1')], edges: [], undoStack: [], redoStack: [], isExecuting: false,
    backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, providerRecoveries: [], providerStartAmbiguities: [],
    notify: (line: string, _tone?: string, options?: { mono?: string }) => { notices.push({ line, ...(options?.mono ? { mono: options.mono } : {}) }); } } as never);
});

describe('Accept on a stale-empty tab', () => {
  it('Undo removes only the node Accept added, never the agent\'s', async () => {
    useGraphStore.setState({ nodes: [], backendFreshStartPending: true } as never);
    const agentN1 = text('n1');
    const accepted = text('n2');
    useCanvasProposalsStore.getState().open({ id: 'p2', status: 'open', agent: { id: 'a', name: 'Codex', color: '#fff', verified: false },
      note: 'x', createdAt: Date.now(), expiresAt: Date.now() + 600000, nodes: [], edges: [], params: [], run: [] } as never, 'key', {});
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/accept')) {
        socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [agentN1, accepted], edit: { tab: TAB_ID, actor: { kind: 'person' } } });
        return json({ nodes: [accepted], edges: [], updatedNodes: [], runNodeIds: [], idMap: { '+a': 'n2' } });
      }
      return json({});
    });
    await useCanvasProposalsStore.getState().accept('p2');
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(json({}));
    useGraphStore.getState().undo();
    await settle(30);
    const removed = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/api/graph/restore'))
      .flatMap(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { remove?: string[] }).remove ?? []);
    expect(removed).not.toContain('n1');
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toContain('n1');
  });
});

describe('a failed save names its own settings (design)', () => {
  // Design (2026-10-27) moved the count to four: two or three settings
  // on one node are named, four or more counted, the same as every
  // failed-save line (lib/savingCutOff, tests/round23Lines).
  it('the exact one, two-or-three and four-or-more lines', () => {
    expect(graphStore.paramSaveFailedLine('Seed', 'Banana', true))
      .toBe("Nebula couldn’t save “Seed” for “Banana”. It’s back to its last saved value.");
    expect(graphStore.paramSaveFailedLine(['Prompt', 'Seed'], 'Banana', true))
      .toBe("Nebula couldn’t save “Prompt” and “Seed” for “Banana”. They’re back to their last saved values.");
    expect(graphStore.paramSaveFailedLine(['Prompt', 'Seed', 'Size'], 'Banana', true))
      .toBe("Nebula couldn’t save “Prompt”, “Seed” and “Size” for “Banana”. They’re back to their last saved values.");
    expect(graphStore.paramSaveFailedLine(['Prompt', 'Seed', 'Size', 'Steps'], 'Banana', true))
      .toBe("Nebula couldn’t save 4 settings for “Banana”. They’re back to their last saved values.");
    expect(graphStore.paramSaveFailedLine(['Prompt', 'Seed'], 'Banana', false))
      .toBe("Nebula couldn’t save “Prompt” and “Seed” for “Banana”.");
    expect(graphStore.paramSaveFailedLine(['Prompt', 'Seed', 'Size'], 'Banana', false))
      .toBe("Nebula couldn’t save “Prompt”, “Seed” and “Size” for “Banana”.");
    expect(graphStore.paramSaveFailedLine(['Prompt', 'Seed', 'Size', 'Steps'], 'Banana', false))
      .toBe("Nebula couldn’t save 4 settings for “Banana”.");
  });

  it('two requests, the first saved and the second refused, names only the second\'s key and reverts only it', async () => {
    useGraphStore.setState({ nodes: [banana({ prompt: 'old prompt', seed: 1 })] } as never);
    const firstAnswer: { resolve?: (response: Response) => void } = {};
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise<Response>((resolve) => { firstAnswer.resolve = resolve; });
      return Promise.resolve(json({ detail: 'refused' }, 409));
    });
    useGraphStore.getState().updateNodeData('n5', { params: { prompt: 'new prompt', seed: 1 } });
    await settle(PUSH_WAIT);
    useGraphStore.getState().updateNodeData('n5', { params: { prompt: 'new prompt', seed: 7 } });
    await settle(PUSH_WAIT);
    firstAnswer.resolve?.(json({}));
    await settle(50);
    expect(notices.map((notice) => notice.line)).toEqual(
      ["Nebula couldn’t save a setting on “Banana”. It’s back to its last saved value."]);
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ prompt: 'new prompt', seed: 1 });
  });

  it('one request with two keys refused: both named, both back', async () => {
    useGraphStore.setState({ nodes: [banana({ prompt: 'old', seed: 1 })] } as never);
    fetchMock.mockImplementation(async () => json({ detail: 'refused' }, 409));
    useGraphStore.getState().updateNodeData('n5', { params: { prompt: 'new', seed: 7 } });
    await settle(PUSH_WAIT + 50);
    expect(notices.map((notice) => notice.line)).toEqual(
      ["Nebula couldn’t save 2 settings for “Banana”. They’re back to their last saved values."]);
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ prompt: 'old', seed: 1 });
  });

  // Merged with #198: "prompt" and "seed" have no card label on this node,
  // and #198 never shows a raw key (design ask 3), so the three are
  // counted, as #198's own line had it; labelled ones are named (above).
  it('one request with three keys refused, two unlabelled: counted', async () => {
    useGraphStore.setState({ nodes: [banana({ prompt: 'old', seed: 1, aspect_ratio: '1:1' })] } as never);
    fetchMock.mockImplementation(async () => json({ detail: 'refused' }, 409));
    useGraphStore.getState().updateNodeData('n5', { params: { prompt: 'new', seed: 7, aspect_ratio: '16:9' } });
    await settle(PUSH_WAIT + 50);
    expect(notices.map((notice) => notice.line)).toEqual(
      ["Nebula couldn’t save 3 settings for “Banana”. They’re back to their last saved values."]);
  });

  it('a key edited again while its save was out keeps the newer value, and the second sentence goes', async () => {
    useGraphStore.setState({ nodes: [banana({ prompt: 'old', seed: 1 })] } as never);
    const answer: { resolve?: (response: Response) => void } = {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer.resolve = resolve; }));
    useGraphStore.getState().updateNodeData('n5', { params: { prompt: 'new', seed: 7 } });
    await settle(PUSH_WAIT);
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    useGraphStore.getState().updateNodeData('n5', { params: { prompt: 'newer', seed: 7 } });
    answer.resolve?.(json({ detail: 'refused' }, 409));
    await settle(50);
    expect(notices.map((notice) => notice.line)).toEqual(
      ["Nebula couldn’t save 2 settings for “Banana”."]);
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ prompt: 'newer', seed: 1 });
  });
});

describe('a failed model change names the model the node is on, in mono', () => {
  it('OpenRouter: the configured model id, as the picker shows it', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n6', type: 'dynamic-node', position: { x: 0, y: 0 },
      data: { label: 'Router', definitionId: 'openrouter-universal', isDynamic: true, state: 'idle', outputs: {},
        params: { model: 'anthropic/claude-opus', _model_ports: { model: 'anthropic/claude-opus' } } } }] } as never);
    fetchMock.mockImplementation(async () => json({ detail: 'refused' }, 409));
    await useGraphStore.getState().configureOpenRouterModel('n6', 'openai/gpt-5');
    expect(notices).toEqual([{ line: "Nebula couldn’t change the model for “Router”. It’s still on anthropic/claude-opus.",
      mono: 'anthropic/claude-opus' }]);
  });

  it('Replicate: the model the backend configured, not the id typed in the field', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n7', type: 'dynamic-node', position: { x: 0, y: 0 },
      data: { label: 'Replicate', definitionId: 'replicate-universal', isDynamic: true, state: 'idle', outputs: {},
        params: { model_id: 'new/model', _model_ports: { model: 'old/model' } } } }] } as never);
    fetchMock.mockImplementation(async () => json({ detail: 'no such model' }, 404));
    await useGraphStore.getState().fetchReplicateSchemaAndConfigure('n7', 'new', 'model');
    expect(notices).toEqual([{ line: "Nebula couldn’t change the model for “Replicate”. It’s still on old/model.", mono: 'old/model' }]);
  });
});

describe('offline mid-drag, the node springs back to where the drag started', () => {
  it('on the spring (not a jump), with one pulse and no line', async () => {
    let pulses = 0;
    const stop = subscribeOfflinePulse(() => { pulses += 1; });
    useGraphStore.setState({ nodes: [{ ...text('n1'), position: { x: 0, y: 0 } }] } as never);
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'position', position: { x: 300, y: 200 }, dragging: true }]);
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 300, y: 200 });
    const seen: { x: number; y: number }[] = [];
    const off = useGraphStore.subscribe((state) => { seen.push({ ...state.nodes[0].position }); });
    noteBackendConnection('offline');
    // The rest of the drag is refused quietly.
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'position', position: { x: 320, y: 210 }, dragging: true }]);
    await vi.waitFor(() => expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 }), { timeout: 3000 });
    off();
    stop();
    expect(seen.some((at) => at.x > 0 && at.x < 300)).toBe(true);
    expect(pulses).toBe(1);
    expect(notices).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('under reduced motion it moves at once', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    useGraphStore.setState({ nodes: [{ ...text('n1'), position: { x: 0, y: 0 } }] } as never);
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'position', position: { x: 300, y: 200 }, dragging: true }]);
    noteBackendConnection('offline');
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
    vi.unstubAllGlobals();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
});

describe('held-delete lines (design: "Couldn’t delete “<node>”. <reason line>")', () => {
  it('one node, unconfirmed start or recovery ID', () => {
    expect(heldDeleteText(1, true, 1, '“Harbor world”')).toBe(
      "Nebula couldn’t delete “Harbor world” because a World Labs run needs your check first. Use the notice at the top of the screen.");
    expect(heldDeleteText(1, false, 1, '“Harbor world”')).toBe(
      "Nebula couldn’t delete “Harbor world” because it has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in run history.");
  });

  it('the backend\'s recovery refusal is named from its own line', () => {
    expect(deleteRefusalText("Couldn't delete the node.", 1,
      ['“Harbor world” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run history.'])).toBe(
      "Nebula couldn’t delete “Harbor world” because it has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in run history.");
  });

  it('the canvas refuses a held node with its name', () => {
    useGraphStore.setState({ nodes: [text('n1', 'Harbor world')],
      providerStartAmbiguities: [{ runId: 'r', nodeId: 'n1', kind: 'worldlabs-environment' }],
      // Run r is this project's (PR #199).
      runHistory: [{ id: 'r', trigger: 'graph', startedAt: 1, status: 'complete', snapshot: { nodes: [], edges: [] } }], } as never);
    useGraphStore.getState().deleteNode('n1');
    expect(useGraphStore.getState().undoNotice?.text).toBe(
      "Nebula couldn’t delete “Harbor world” because a World Labs run needs your check first. Use the notice at the top of the screen.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Create\'s cluster line (design)', () => {
  const request = { definitionId: 'nano-banana', prompt: 'a harbor', refPaths: [], quantity: 1, params: {},
    layoutOrigin: { x: 0, y: 0 }, sessionId: 's', genId: 'g' } as never;
  async function failure() {
    return useGraphStore.getState().authorGenerationCluster(request).then(() => null, (error: unknown) => error);
  }

  it('a refusal with a person line: that line instead of "Try again."', async () => {
    fetchMock.mockImplementation(async () => json({ detail: 'A run is still going. Wait for it to finish or stop it first.' }, 409));
    expect(failureMessage(await failure(), 'Nebula couldn’t start the generation.')).toBe(
      "Nebula couldn’t start the generation because its nodes weren’t added to the canvas. A run is still going. Wait for it to finish or stop it first.");
  });

  it('a bare HTTP failure keeps "Try again."', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 500 }));
    expect(failureMessage(await failure(), 'Nebula couldn’t start the generation.')).toBe(
      "Nebula couldn’t start the generation because its nodes weren’t added to the canvas. Try again.");
  });
});
