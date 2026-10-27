import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 16 of PR #114, review 15's store findings and GM's r16 lines:
 * - M1 (probe X1): Stop is sent while offline; a Stop that fails then says
 *   GM's line once and the intent is kept.
 * - M2 (probe X2): a 404 on the status check sends Stop before the run is
 *   freed, and the run is settled only once that Stop is answered.
 * - L2 (probe X4): a param push refused offline is an edit in flight: GM's
 *   failed-save line and the revert.
 * - M5 (probe X5): Undo of an accepted proposal leaves what an agent changed
 *   since, and says so in GM's words.
 * - M4 (probe X6): the boot id is noted with no project open.
 * - The 507 run line (GM, locked).
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

const { useGraphStore } = await import('../../src/store/graphStore');
const { useCanvasProposalsStore } = await import('../../src/store/canvasProposalsStore');
const { useAgentLogStore } = await import('../../src/store/agentLogStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { noteBackendConnection, resetBackendConnectionForTests, subscribeBlockedEdits } = await import('../../src/lib/backendConnection');
const { acceptUndoLine } = await import('../../src/lib/canvasUndo');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const text = (id: string, value = 'saved', label = id === 'n1' ? 'Brief' : 'Text Input') => ({ id, type: 'model-node',
  position: { x: 0, y: 0 }, data: { label, definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} } });
const sent = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
const notices: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let blocked = 0;
subscribeBlockedEdits(() => { blocked += 1; });

const STOP_LINE = "Couldn't stop the run. Nebula isn't answering, so it may still be going.";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  notices.length = 0;
  blocked = 0;
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useAgentLogStore.getState().clear();
  useGraphStore.setState({ nodes: [text('n1')], edges: [], undoStack: [], redoStack: [], isExecuting: false,
    backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [],
    notify: (line: string) => { if (line) notices.push(line); } } as never);
});

function runningBackend() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/api/execute')) {
      const body = JSON.parse(String(init.body)) as { runId: string };
      return json({ status: 'started', runId: body.runId });
    }
    if (init?.method === 'DELETE' && String(url).includes('/api/executions/')) return json({ runId: 'x', status: 'cancelling' });
    if (String(url).includes('/api/executions/')) return json({ status: 'running' });
    return json({});
  });
}

describe('M1 (probe X1): Stop while offline, a run going', () => {
  it('the DELETE is sent at once (a false offline: the backend answers), with no pulse', async () => {
    runningBackend();
    await useGraphStore.getState().executeNode('n1');
    fetchMock.mockClear();
    noteBackendConnection('offline');
    await useGraphStore.getState().cancelExecution();
    expect(sent().filter((line) => line.startsWith('DELETE /api/executions/'))).toHaveLength(1);
    expect(blocked).toBe(0);
    expect(useGraphStore.getState().isCancelling).toBe(true);
    expect(notices).toEqual([]);
  });

  it('a Stop that fails while offline says GM\'s line once and keeps the intent', async () => {
    runningBackend();
    await useGraphStore.getState().executeNode('n1');
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    noteBackendConnection('offline');
    await useGraphStore.getState().cancelExecution();
    await useGraphStore.getState().cancelExecution();
    expect(notices).toEqual([STOP_LINE]);
    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().isCancelling).toBe(true);
    // Back online, the same intent is sent again by itself.
    runningBackend();
    fetchMock.mockClear();
    noteBackendConnection('online');
    await sleep(2300);
    expect(sent().some((line) => line.startsWith('DELETE /api/executions/'))).toBe(true);
  }, 10000);

  it('online, a failed Stop says nothing (it retries quietly, as before)', async () => {
    runningBackend();
    await useGraphStore.getState().executeNode('n1');
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    await useGraphStore.getState().cancelExecution();
    expect(notices).toEqual([]);
  });
});

describe('M2 (probe X2): a 404 on the status check after a lost start answer', () => {
  it('sends Stop before the run is freed; the tombstone answer ends it', async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      order.push(`${method} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
      if (method === 'POST' && String(url).includes('/api/execute')) throw new TypeError('Failed to fetch');
      if (method === 'GET' && String(url).includes('/api/executions/')) return json({ detail: 'Unknown run' }, 404);
      if (method === 'DELETE') {
        expect(useGraphStore.getState().isExecuting).toBe(true);
        return json({ runId: 'x', status: 'cancelled', pendingAdmission: true });
      }
      return json({});
    });
    await useGraphStore.getState().executeNode('n1');
    await sleep(20);
    expect(order.map((line) => line.split(' ')[0])).toEqual(['POST', 'GET', 'DELETE']);
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().runHistory[0]?.status).toBe('failed');
  });

  it('a Stop that isn\'t answered keeps the run (uncertain) and is sent again', async () => {
    let deletes = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && String(url).includes('/api/execute')) throw new TypeError('Failed to fetch');
      if (method === 'GET' && String(url).includes('/api/executions/')) return json({ detail: 'Unknown run' }, 404);
      if (method === 'DELETE') { deletes += 1; throw new TypeError('Failed to fetch'); }
      return json({});
    });
    await useGraphStore.getState().executeNode('n1');
    await sleep(20);
    expect(useGraphStore.getState().isExecuting).toBe(true);
    await sleep(2200);
    expect(deletes).toBeGreaterThanOrEqual(2);
    expect(useGraphStore.getState().isExecuting).toBe(true);
  }, 10000);

  it('a run that registered meanwhile is stopped and tracked to its end', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && String(url).includes('/api/execute')) throw new TypeError('Failed to fetch');
      if (method === 'GET' && String(url).includes('/api/executions/')) return json({ detail: 'Unknown run' }, 404);
      if (method === 'DELETE') return json({ runId: 'x', status: 'cancelling' });
      return json({});
    });
    await useGraphStore.getState().executeNode('n1');
    await sleep(20);
    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().isCancelling).toBe(true);
  });
});

describe('L2 (probe X4): a param push refused just after the offline flip', () => {
  it('reads GM\'s failed-save line and reverts, never lost without a word', async () => {
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'typed' } });
    noteBackendConnection('offline');
    await sleep(400);
    expect(sent().filter((line) => line.startsWith('PUT'))).toEqual([]);
    expect(notices).toEqual(["Couldn't save “Text” for “Brief”. It's back to its last saved value."]);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('saved');
  });
});

describe('M5 (probe X5): Undo of an accepted proposal an agent changed since', () => {
  const openProposal = (id: string) => useCanvasProposalsStore.getState().open({ id, status: 'open',
    agent: { id: 'a', name: 'Codex', color: '#fff', verified: false }, note: 'x', createdAt: Date.now(),
    expiresAt: Date.now() + 600000, nodes: [], edges: [], params: [], run: [] } as never, 'key', {});
  const agentEdit = { actor: { kind: 'agent', name: 'Claude Code', id: 'cc' } };

  it('the agent\'s value stays on the canvas and on the backend; nothing is undone, in GM\'s words', async () => {
    openProposal('p5');
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/accept')) {
        socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [text('n1', 'proposal')], edit: { tab: TAB_ID, actor: { kind: 'person' } } });
        socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [text('n1', 'agent')], edit: agentEdit });
        return json({ nodes: [], edges: [], updatedNodes: [text('n1', 'proposal')], runNodeIds: [], idMap: {} });
      }
      return json({});
    });
    await useCanvasProposalsStore.getState().accept('p5');
    // The reply is older than the agent's sync: the canvas keeps "agent".
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('agent');
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(json({}));
    useGraphStore.getState().undo();
    await sleep(30);
    const restores = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/graph/restore'));
    expect(restores).toHaveLength(0);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('agent');
    const line = 'Nothing was undone. Claude Code changed “Text” for “Brief” after you accepted.';
    expect(useGraphStore.getState().undoNotice?.text).toBe(line);
    expect(useAgentLogStore.getState().entries.map((entry) => entry.message)).toContain(line);
  });

  it('a partial undo puts back only the keys still as Accept set them', async () => {
    openProposal('p6');
    const two = (value: string, prompt: string) => ({ ...text('n1', value), data: { ...text('n1', value).data,
      params: { value, prompt } } });
    useGraphStore.setState({ nodes: [two('saved', 'old')] } as never);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/accept')) {
        socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [two('proposal', 'new')], edit: { tab: TAB_ID, actor: { kind: 'person' } } });
        socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [two('agent', 'new')], edit: agentEdit });
        return json({ nodes: [], edges: [], updatedNodes: [two('proposal', 'new')], runNodeIds: [], idMap: {} });
      }
      return json({});
    });
    await useCanvasProposalsStore.getState().accept('p6');
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(json({}));
    useGraphStore.getState().undo();
    await sleep(30);
    const bodies = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/graph/restore'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { nodes: { params: Record<string, unknown> }[] });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].nodes[0].params).toEqual({ value: 'agent', prompt: 'old' });
    expect(useGraphStore.getState().undoNotice?.text)
      .toBe('Undid the proposal except “Text” for “Brief”. Claude Code changed it after you accepted.');
  });

  it('a node Accept added that an agent edited since is kept; one nobody touched goes', async () => {
    openProposal('p7');
    const added = [text('n2', 'fresh', 'Kept'), text('n3', 'fresh', 'Gone')];
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/accept')) {
        return json({ nodes: added, edges: [], updatedNodes: [], runNodeIds: [], idMap: { '+a': 'n2', '+b': 'n3' } });
      }
      return json({});
    });
    await useCanvasProposalsStore.getState().accept('p7');
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [],
      nodes: [text('n1'), text('n2', 'agent wrote', 'Kept'), text('n3', 'fresh', 'Gone')], edit: agentEdit });
    // The agent's edit is its own step on top: Undo takes it first, then the
    // agent edits again so the Accept is next with the node changed since.
    useGraphStore.setState((state) => ({ undoStack: state.undoStack.filter((entry) => (entry as { kind?: string }).kind !== 'foreign') }) as never);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(json({}));
    useGraphStore.getState().undo();
    await sleep(30);
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().undoNotice?.text)
      // Round 17 (GM): a node the Accept added and the agent changed is kept whole.
      .toBe('Undid the proposal except “Kept”. Claude Code changed it after you accepted.');
  });

  it('GM\'s forms, exactly', () => {
    expect(acceptUndoLine([{ node: 'Hero', settings: ['Prompt'] }], { kind: 'agent', name: 'Codex' }, false))
      .toBe('Undid the proposal except “Prompt” for “Hero”. Codex changed it after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['Prompt', 'Seed'] }], { kind: 'agent', name: 'Codex' }, false))
      .toBe('Undid the proposal except “Prompt” and “Seed” for “Hero”. Codex changed them after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['Prompt', 'Seed', 'Steps'] }], { kind: 'agent', name: 'Codex' }, false))
      .toBe('Undid the proposal except “Prompt”, “Seed” and “Steps” for “Hero”. Codex changed them after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B', 'C', 'D'] }], { kind: 'agent', name: 'Codex' }, false))
      .toBe('Undid the proposal except 4 settings Codex changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A'] }, { node: 'Logo', settings: ['B'] }], { kind: 'agent', name: 'Codex' }, false))
      // GM pr198 r1: settings across nodes are counted, from 2.
      .toBe('Undid the proposal except 2 settings Codex changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A'] }, { node: 'Logo', settings: ['B'] }], { kind: 'agent', name: null }, false))
      .toBe('Undid the proposal except 2 settings an agent changed after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['Prompt'] }], { kind: 'agent', name: null }, false))
      .toBe('Undid the proposal except “Prompt” for “Hero”. An agent changed it after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['Prompt'] }], { kind: 'agent', name: 'Codex' }, true))
      .toBe('Nothing was undone. Codex changed “Prompt” for “Hero” after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['Prompt', 'Seed'] }], { kind: 'agent', name: null }, true))
      .toBe('Nothing was undone. An agent changed “Prompt” and “Seed” for “Hero” after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A', 'B', 'C', 'D'] }], { kind: 'agent', name: 'Codex' }, true))
      .toBe('Nothing was undone. Codex changed every setting in the proposal after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero', settings: ['A'] }, { node: 'Logo', settings: ['B'] }], { kind: 'agent', name: null }, true))
      .toBe('Nothing was undone. An agent changed every setting in the proposal after you accepted.');
  });
});

describe('M4 (probe X6): the boot id is learned with no project open', () => {
  it('a restarted backend releases the held create', async () => {
    const banana = { id: 'n3', type: 'model-node', position: { x: 0, y: 300 },
      data: { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} } };
    const connect = { source: 'n3', sourceHandle: 'image', target: '', targetHandle: 'image', newNodeIs: 'target' as const };
    setProjectContext(null as never);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-1' });
    setProjectContext({ id: 'A', revision: 'a' });
    useGraphStore.setState({ nodes: [banana], edges: [] } as never);
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect);
    fetchMock.mockReset(); fetchMock.mockResolvedValue(json({}));
    socketSends({ type: 'socketReconnected' });
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-2' });
    fetchMock.mockReset(); fetchMock.mockResolvedValueOnce(json({ detail: 'nope' }, 409));
    await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect);
    expect(sent().some((line) => line.includes('/api/graph/node-and-connect'))).toBe(true);
  });

  it('the same process after a reconnect keeps holding it', async () => {
    const banana = { id: 'n3', type: 'model-node', position: { x: 0, y: 300 },
      data: { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} } };
    const connect = { source: 'n3', sourceHandle: 'image', target: '', targetHandle: 'image', newNodeIs: 'target' as const };
    setProjectContext(null as never);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-9' });
    setProjectContext({ id: 'A', revision: 'a' });
    useGraphStore.setState({ nodes: [banana], edges: [] } as never);
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect);
    fetchMock.mockReset(); fetchMock.mockResolvedValue(json({}));
    socketSends({ type: 'socketReconnected' });
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-9' });
    fetchMock.mockReset(); fetchMock.mockResolvedValue(json({}));
    await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect);
    expect(sent().some((line) => line.includes('/api/graph/node-and-connect'))).toBe(false);
  });
});

describe('the 507 run line (GM, locked)', () => {
  it('names the node and says nothing was started', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/api/execute-node')) {
        // The agents' words; the person reads GM's line for a run-safety
        // store's 507 (round 17: the answer's code says which store).
        return json({ detail: 'Nebula cannot verify durable pre-admission Stop state; no provider request was sent',
          code: 'run_safeguards' }, 507);
      }
      return json({});
    });
    await useGraphStore.getState().executeNode('n1');
    expect(notices).toEqual([
      "Couldn't run “Brief”. Nebula couldn't save its run safeguards, so nothing was started. Restart Nebula, then try again.",
    ]);
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });
});

describe('held-delete reason lines (GM, round 16)', () => {
  it('the node being deleted holds the ID: "It", and the button in curly quotes', async () => {
    const { heldDeleteText } = await import('../../src/lib/worldLabsWaiting');
    expect(heldDeleteText(1, false, 1, '“Lighthouse world”')).toBe(
      "Couldn't delete “Lighthouse world”. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.");
  });

  it("the backend's own refusal of a node is that node's: \"It\"", async () => {
    const { deleteRefusalText } = await import('../../src/lib/worldLabsWaiting');
    expect(deleteRefusalText("Couldn't delete the node.", 1,
      ['“World Labs Environment” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History.'],
      '“Lighthouse world”')).toBe(
      "Couldn't delete “Lighthouse world”. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.");
  });
});

describe('L7 (pre-existing): a freshly loaded project shows its missing-key warning at once', () => {
  it('loadProjectGraph computes keyStatus from the credential cache', async () => {
    const { useUIStore } = await import('../../src/store/uiStore');
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true, kreaConnectionMode: 'api-token' } } as never);
    // Earlier cases leave runs this file doesn't settle; the switch check
    // isn't what this case is about.
    const canSwitchProject = useGraphStore.getState().canSwitchProject;
    useGraphStore.setState({ canSwitchProject: () => true });
    const banana = { id: 'n7', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} } };
    expect(useGraphStore.getState().loadProjectGraph([banana as never, text('n1') as never], [], [])).toBe(true);
    const nodes = useGraphStore.getState().nodes;
    expect(nodes.find((node) => node.id === 'n7')?.data.keyStatus).toBe('missing');
    // A node that needs no key gets none.
    expect(nodes.find((node) => node.id === 'n1')?.data.keyStatus).toBeUndefined();
    useGraphStore.setState({ canSwitchProject });
  });
});

describe('nit: a reconnect while the mouse is still down keeps a put-back drag ended', () => {
  const at = () => useGraphStore.getState().nodes.find((node) => node.id === 'n1')!.position;
  const move = (x: number, dragging: boolean) => useGraphStore.getState().onNodesChange(
    [{ type: 'position', id: 'n1', position: { x, y: 0 }, dragging }] as never);

  it('moves after the reconnect are dropped until the pointer is released, the drop included', async () => {
    noteBackendConnection('online');
    move(40, true);
    expect(at().x).toBe(40);
    noteBackendConnection('offline');
    // Put back on the spring (or at once, with reduced motion); let it land.
    await sleep(600);
    expect(at().x).toBe(0);
    noteBackendConnection('online');
    move(120, true);
    expect(at().x).toBe(0);
    move(130, false);
    expect(at().x).toBe(0);
    window.dispatchEvent(new Event('pointerup'));
    await sleep(5);
    // A new drag after the release moves as usual.
    move(60, true);
    expect(at().x).toBe(60);
    move(60, false);
  });
});

describe('L3: Cinema "Send to motion" offline', () => {
  it('sends nothing and shows no error line; the shot keeps what it showed', async () => {
    const { sendCinemaShotToMotion } = await import('../../src/lib/cinemaMotion');
    const { useCinemaMotionStore } = await import('../../src/store/cinemaMotionStore');
    useCinemaMotionStore.getState().clear();
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, data: {
      label: 'Scene', definitionId: 'cinema-scene', state: 'complete',
      params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
        shots: [{ id: 'a', prompt: 'Logo', output: { status: 'done', imageUrl: '/api/outputs/a.png' } }] } },
      outputs: { shot_a: { type: 'Image', value: '/api/outputs/a.png' } } } }] } as never);
    noteBackendConnection('offline');
    fetchMock.mockReset();
    await sendCinemaShotToMotion('n1', 'a');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useCinemaMotionStore.getState().handoffs).toEqual([]);
    expect(blocked).toBe(1);
  });
});

describe('L3: a Settings field saved while offline says nothing and keeps its draft', () => {
  it('saveField refused by the offline gate sets no error line', async () => {
    const { saveField, resetSettingsWrites } = await import('../../src/lib/settingsWrites');
    const { useSettingsDraftStore } = await import('../../src/store/settingsDraftStore');
    resetSettingsWrites();
    useSettingsDraftStore.setState({ errors: {}, fieldDrafts: { outputPath: '/tmp/out' } } as never);
    noteBackendConnection('offline');
    expect(await saveField('outputPath', '/tmp/out')).toBe(false);
    expect(useSettingsDraftStore.getState().errors).toEqual({});
    expect(useSettingsDraftStore.getState().fieldDrafts.outputPath).toBe('/tmp/out');
    expect(sent().filter((line) => line.startsWith('PUT'))).toEqual([]);
  });

  it('a key save offline writes neither the Keychain nor the backend', async () => {
    const { saveKey, resetSettingsWrites } = await import('../../src/lib/settingsWrites');
    resetSettingsWrites();
    const set = vi.fn(async () => ({ ok: true }));
    (window as unknown as { nebulaDesktop?: unknown }).nebulaDesktop = { credentials: { set, clear: vi.fn() } };
    noteBackendConnection('offline');
    fetchMock.mockReset();
    expect(await saveKey('OPENAI_API_KEY', 'placeholder-value')).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    delete (window as unknown as { nebulaDesktop?: unknown }).nebulaDesktop;
  });
});
