import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 17 of PR #114, review 16's store findings and GM's r17 lines:
 * - M2 (probe Y5): Accept's undo compares values with asset links as the
 *   backend gave them, so an image the proposal set is put back.
 * - L3 (probes Y6, Y7e): a run's own param write-back is run output, not an
 *   agent's edit; the person's other window says "You"; a mixed or unknown
 *   source drops the actor. A kept node is named as one item.
 * - L2 (probe Y2): the 404 rule's Stop gives up after 15 s, says GM's Stop
 *   line, keeps the run "may still be going" and sends Stop again.
 * - L4: a paid World Labs start whose status check answers 404 gets the same
 *   Stop and keeps its uncertain state.
 * - L5: the run-safety line only for the run-safety store's 507.
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
const socketSends = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { useGraphStore, STOP_ANSWER_MS } = await import('../../src/store/graphStore');
const { useCanvasProposalsStore } = await import('../../src/store/canvasProposalsStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { acceptUndoLine, droppedRenameLine } = await import('../../src/lib/canvasUndo');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const node = (id: string, params: Record<string, unknown>, label = id, definitionId = 'text-input') => ({ id,
  type: 'model-node', position: { x: 0, y: 0 }, data: { label, definitionId, params, state: 'idle', outputs: {} } });
const sent = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
const notices: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STOP_LINE = "Couldn't stop the run. Nebula isn't answering, so it may still be going.";

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  // The base URL is known, so asset links rewrite as in the app (review 16's Y5 setup).
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  notices.length = 0;
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [node('n1', { value: 'saved' }, 'Brief')], edges: [], undoStack: [], redoStack: [],
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (line: string) => { if (line) notices.push(line); } } as never);
});
afterEach(() => { vi.useRealTimers(); });

const proposal = (id: string) => ({ id, status: 'open', agent: { id: 'a', name: 'Codex', color: '#fff', verified: false },
  note: 'x', createdAt: Date.now(), expiresAt: Date.now() + 600000, nodes: [], edges: [], params: [], run: [] });

async function acceptWith(reply: Record<string, unknown>, during?: () => void) {
  useCanvasProposalsStore.getState().open(proposal('p') as never, 'key', {});
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/accept')) { during?.(); return json(reply); }
    return json({});
  });
  await useCanvasProposalsStore.getState().accept('p');
}

async function undoAndRead() {
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(json({}));
  useGraphStore.getState().undo();
  await sleep(30);
  const bodies = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/graph/restore'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
  const notice = (useGraphStore.getState().undoNotice as { text?: string } | null)?.text ?? null;
  return { bodies, notice };
}

const own = (nodes: unknown[]) => socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes,
  edit: { tab: TAB_ID, actor: { kind: 'person' } } });
const agentSync = (nodes: unknown[], name = 'Claude Code') => socketSends({ type: 'graphSync', ...base, empty: false,
  edges: [], nodes, edit: { actor: { kind: 'agent', name, id: name } } });
const otherWindow = (nodes: unknown[]) => socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes,
  edit: { tab: 'other-tab', actor: { kind: 'person' } } });

describe('M2: Accept compares values with asset links as the backend gave them (probe Y5)', () => {
  it('an image link the proposal set, untouched since: Undo puts the old one back with no line', async () => {
    const img = (value: string) => node('n1', { filePath: value }, 'Photo', 'image-input');
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [img('/api/outputs/old.png')] });
    await sleep(10);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [img('/api/outputs/new.png')], runNodeIds: [], idMap: {} },
      () => own([img('/api/outputs/new.png')]));
    const { bodies, notice } = await undoAndRead();
    expect(JSON.stringify(bodies)).toContain('/api/outputs/old.png');
    expect(notice ?? '').not.toContain('changed');
  });

  it('links nested in a list, and an object whose keys come back in another order, compare equal', async () => {
    const value = (urls: string[], spec: Record<string, unknown>) => node('n1', { refs: urls, spec }, 'Board');
    useGraphStore.setState({ nodes: [value(['/api/outputs/a.png'], { w: 1, h: 2 })] } as never);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [value(['/api/outputs/b.png'], { w: 3, h: 4 })], runNodeIds: [], idMap: {} },
      () => own([value(['/api/outputs/b.png'], { h: 4, w: 3 })]));
    const { bodies, notice } = await undoAndRead();
    expect(JSON.stringify(bodies)).toContain('/api/outputs/a.png');
    expect(notice ?? '').not.toContain('changed');
  });
});

describe('L3: who changed it (probes Y6, Y7e; GM r17)', () => {
  it("a run's own param write-back isn't anyone's edit: Undo still removes the node Accept added", async () => {
    const added = (params: Record<string, unknown>) => node('n2', params, 'Added');
    await acceptWith({ nodes: [added({ value: 'p' })], edges: [], updatedNodes: [], runNodeIds: ['n2'], idMap: {} },
      () => own([node('n1', { value: 'saved' }, 'Brief'), added({ value: 'p' })]));
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], runParams: 'run-1',
      nodes: [node('n1', { value: 'saved' }, 'Brief'), added({ value: 'p', seed: 42 })] });
    await sleep(10);
    const { bodies, notice } = await undoAndRead();
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1']);
    expect(JSON.stringify(bodies)).toContain('n2');
    expect(notice ?? '').not.toContain('changed');
  });

  it('a change with no source keeps the node and drops the actor (never "An agent")', async () => {
    const added = (params: Record<string, unknown>) => node('n2', params, 'Added');
    await acceptWith({ nodes: [added({ value: 'p' })], edges: [], updatedNodes: [], runNodeIds: [], idMap: {} },
      () => own([node('n1', { value: 'saved' }, 'Brief'), added({ value: 'p' })]));
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [],
      nodes: [node('n1', { value: 'saved' }, 'Brief'), added({ value: 'p', seed: 42 })] });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Nothing was undone. “seed” for “Added” was changed after you accepted.');
  });

  it("the person's other window: \"You … in another window\" (Y7e)", async () => {
    await acceptWith({ nodes: [], edges: [], updatedNodes: [node('n1', { value: 'b' }, 'Brief')], runNodeIds: [], idMap: {} },
      () => { own([node('n1', { value: 'b' }, 'Brief')]); otherWindow([node('n1', { value: 'c' }, 'Brief')]); });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Nothing was undone. You changed “Text” for “Brief” in another window after you accepted.');
  });

  it('the other window changed one of two settings: the rest is undone, and the line says "You"', async () => {
    useGraphStore.setState({ nodes: [node('n1', { value: 'a', x: 1 }, 'Brief')] } as never);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [node('n1', { value: 'b', x: 2 }, 'Brief')], runNodeIds: [], idMap: {} },
      () => { own([node('n1', { value: 'b', x: 2 }, 'Brief')]); otherWindow([node('n1', { value: 'b', x: 3 }, 'Brief')]); });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Undid the proposal except “x” for “Brief”. You changed it in another window after you accepted.');
  });

  it('an agent and the other window: mixed, so the actor goes (two settings on two nodes: counted, GM pr198 r1)', async () => {
    useGraphStore.setState({ nodes: [node('n1', { value: 'a' }, 'Brief'), node('n3', { value: 'a', y: 1 }, 'Other')] } as never);
    await acceptWith({ nodes: [], edges: [], updatedNodes: [node('n1', { value: 'b' }, 'Brief'), node('n3', { value: 'b', y: 2 }, 'Other')],
      runNodeIds: [], idMap: {} }, () => {
      own([node('n1', { value: 'b' }, 'Brief'), node('n3', { value: 'b', y: 2 }, 'Other')]);
      agentSync([node('n1', { value: 'c' }, 'Brief'), node('n3', { value: 'b', y: 2 }, 'Other')]);
      otherWindow([node('n1', { value: 'c' }, 'Brief'), node('n3', { value: 'b', y: 9 }, 'Other')]);
    });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Undid the proposal except 2 settings changed after you accepted.');
  });

  it('a kept node is named as one item', async () => {
    useGraphStore.setState({ nodes: [node('n1', { value: 'a' }, 'Brief')] } as never);
    await acceptWith({ nodes: [node('n2', { value: 'p' }, 'Added')], edges: [], updatedNodes: [node('n1', { value: 'b' }, 'Brief')],
      runNodeIds: [], idMap: {} }, () => {
      own([node('n1', { value: 'b' }, 'Brief'), node('n2', { value: 'p' }, 'Added')]);
      agentSync([node('n1', { value: 'b' }, 'Brief'), node('n2', { value: 'p' }, 'Renamed by agent')]);
    });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Undid the proposal except “Renamed by agent”. Claude Code changed it after you accepted.');
  });

  it('kept nodes and settings mixed: "<N> changes <agent> made"', async () => {
    useGraphStore.setState({ nodes: [node('n1', { value: 'a', x: 1 }, 'Brief')] } as never);
    await acceptWith({ nodes: [node('n2', { value: 'p' }, 'Added')], edges: [], updatedNodes: [node('n1', { value: 'b', x: 2 }, 'Brief')],
      runNodeIds: [], idMap: {} }, () => {
      own([node('n1', { value: 'b', x: 2 }, 'Brief'), node('n2', { value: 'p' }, 'Added')]);
      agentSync([node('n1', { value: 'b', x: 5 }, 'Brief'), node('n2', { value: 'p' }, 'Renamed')]);
    });
    await sleep(10);
    const { notice } = await undoAndRead();
    expect(notice).toBe('Undid the proposal except 2 changes Claude Code made after you accepted.');
  });
});

describe("GM's partial-undo lines, every form (exact)", () => {
  const agent = { kind: 'agent' as const, name: 'Codex' };
  const you = { kind: 'you' as const };
  const unknown = { kind: 'unknown' as const };
  const one = (settings: string[], wholeNode = false) => [{ node: 'Brief', settings, wholeNode }];
  it('an agent', () => {
    expect(acceptUndoLine(one(['Text']), agent, false)).toBe('Undid the proposal except “Text” for “Brief”. Codex changed it after you accepted.');
    expect(acceptUndoLine(one(['a', 'b']), agent, false)).toBe('Undid the proposal except “a” and “b” for “Brief”. Codex changed them after you accepted.');
    expect(acceptUndoLine(one(['a', 'b', 'c']), agent, false)).toBe('Undid the proposal except “a”, “b” and “c” for “Brief”. Codex changed them after you accepted.');
    expect(acceptUndoLine(one(['a', 'b', 'c', 'd']), agent, false)).toBe('Undid the proposal except 4 settings Codex changed after you accepted.');
    expect(acceptUndoLine(one(['Name'], true), agent, false)).toBe('Undid the proposal except “Brief”. Codex changed it after you accepted.');
    expect(acceptUndoLine([...one(['Name'], true), { node: 'Other', settings: ['x'], wholeNode: false }], agent, false))
      .toBe('Undid the proposal except 2 changes Codex made after you accepted.');
    expect(acceptUndoLine(one(['Text']), agent, true)).toBe('Nothing was undone. Codex changed “Text” for “Brief” after you accepted.');
    expect(acceptUndoLine([{ node: 'A', settings: ['x'] }, { node: 'B', settings: ['y'] }], agent, true))
      .toBe('Nothing was undone. Codex changed every setting in the proposal after you accepted.');
    expect(acceptUndoLine(one(['Text']), { kind: 'agent', name: null }, false))
      .toBe('Undid the proposal except “Text” for “Brief”. An agent changed it after you accepted.');
    expect(acceptUndoLine(one(['a', 'b', 'c', 'd']), { kind: 'agent', name: null }, false))
      .toBe('Undid the proposal except 4 settings an agent changed after you accepted.');
  });
  it('you, in another window', () => {
    expect(acceptUndoLine(one(['Text']), you, false)).toBe('Undid the proposal except “Text” for “Brief”. You changed it in another window after you accepted.');
    expect(acceptUndoLine(one(['a', 'b']), you, false)).toBe('Undid the proposal except “a” and “b” for “Brief”. You changed them in another window after you accepted.');
    expect(acceptUndoLine(one(['Text']), you, true)).toBe('Nothing was undone. You changed “Text” for “Brief” in another window after you accepted.');
    expect(acceptUndoLine(one(['Name'], true), you, false)).toBe('Undid the proposal except “Brief”. You changed it in another window after you accepted.');
    expect(acceptUndoLine(one(['a', 'b', 'c', 'd']), you, false)).toBe('Undid the proposal except 4 settings you changed in another window after you accepted.');
    expect(acceptUndoLine([...one(['Name'], true), { node: 'Other', settings: ['x'] }], you, false))
      .toBe('Undid the proposal except 2 changes you made in another window after you accepted.');
    expect(acceptUndoLine([{ node: 'A', settings: ['x'] }, { node: 'B', settings: ['y'] }], you, true))
      .toBe('Nothing was undone. You changed every setting in the proposal in another window after you accepted.');
  });
  it('mixed or unknown: no actor', () => {
    // GM r18: never count 1; settings are counted from 4.
    expect(acceptUndoLine(one(['Text']), unknown, false)).toBe('Undid the proposal except “Text” for “Brief”. It was changed after you accepted.');
    expect(acceptUndoLine([{ node: 'A', settings: ['x'] }, { node: 'B', settings: ['y'] }], unknown, false))
      .toBe('Undid the proposal except 2 settings changed after you accepted.');
    expect(acceptUndoLine(one(['Text']), unknown, true)).toBe('Nothing was undone. “Text” for “Brief” was changed after you accepted.');
    expect(acceptUndoLine(one(['a', 'b']), unknown, true)).toBe('Nothing was undone. “a” and “b” for “Brief” were changed after you accepted.');
    expect(acceptUndoLine([{ node: 'A', settings: ['x'] }, { node: 'B', settings: ['y'] }], unknown, true))
      .toBe('Nothing was undone. Every setting in the proposal was changed after you accepted.');
  });
  it('the dropped rename, by who renamed it', () => {
    expect(droppedRenameLine({ kind: 'agent', name: 'Codex' }, 'Hero', 'Mine'))
      .toBe('Codex renamed this node “Hero” while Nebula was offline, so your rename to “Mine” wasn\'t saved.');
    expect(droppedRenameLine(you, 'Hero', 'Mine'))
      .toBe('You renamed this node “Hero” in another window while Nebula was offline, so your rename to “Mine” here wasn\'t saved.');
    expect(droppedRenameLine(unknown, 'Hero', 'Mine'))
      .toBe('This node was renamed “Hero” while Nebula was offline, so your rename to “Mine” wasn\'t saved.');
  });
});

const lostStart = (onDelete: (init?: RequestInit) => Promise<Response>, onStatus?: () => Promise<Response>) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/api/execute')) throw new TypeError('Failed to fetch');
    if (String(url).includes('/api/executions/') && init?.method === 'DELETE') return onDelete(init);
    if (String(url).includes('/api/executions/')) return onStatus ? onStatus() : json({ detail: 'Unknown run' }, 404);
    return json({});
  });
};
/** A DELETE the backend took but never answers; it gives up when aborted. */
const stalls = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});

describe('L2: the 404 rule\'s Stop has a time limit (probe Y2)', () => {
  it('15 s with no answer: "may still be going", GM\'s Stop line once, and Stop goes again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    expect(STOP_ANSWER_MS).toBe(15_000);
    lostStart(stalls);
    const started = useGraphStore.getState().executeNode('n1');
    await vi.advanceTimersByTimeAsync(STOP_ANSWER_MS - 1);
    expect(useGraphStore.getState().activeRuns.map((run: { status: string }) => run.status)).not.toContain('uncertain');
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await started;
    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().activeRuns.map((run: { status: string }) => run.status)).toEqual(['uncertain']);
    expect(notices).toEqual([STOP_LINE]);
    // The next check finds no run again and sends Stop again; the line isn't repeated.
    await vi.advanceTimersByTimeAsync(2_000 + STOP_ANSWER_MS + 10);
    expect(sent().filter((line) => line.startsWith('DELETE /api/executions/')).length).toBe(2);
    expect(notices).toEqual([STOP_LINE]);
  });
});

describe('L4: a paid World Labs start whose status check answers 404', () => {
  it('gets the same Stop, once, and keeps its uncertain state and unlock', async () => {
    useGraphStore.setState({ nodes: [node('world', {}, 'World Labs Environment', 'worldlabs-environment')] } as never);
    lostStart(async () => json({ runId: 'x', status: 'cancelled', pendingAdmission: true }));
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    await sleep(20);
    expect(sent().filter((line) => line === `DELETE /api/executions/${runId}`)).toHaveLength(1);
    expect(useGraphStore.getState().uncertainWorldLabsRunId).toBe(runId);
    expect(useGraphStore.getState().isExecuting).toBe(true);
  });
});

describe('L5: the run-safety line only for the run-safety store\'s 507', () => {
  const refuseWith = (body: Record<string, unknown>) => fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/api/execute-node')) return json(body, 507);
    return json({});
  });
  it('run_safeguards: GM\'s locked line', async () => {
    refuseWith({ detail: 'Nebula cannot verify durable paid-start safety storage; no World Labs request was sent', code: 'run_safeguards' });
    await useGraphStore.getState().executeNode('n1');
    expect(notices).toEqual([
      "Couldn't run “Brief”. Nebula couldn't save its run safeguards, so nothing was started. Restart Nebula, then try again.",
    ]);
  });
  it('project_store: not the run-safety line (a restart does not clear it), and nothing is started', async () => {
    refuseWith({ detail: 'Project catalog could not be read; the existing file was preserved', code: 'project_store' });
    await useGraphStore.getState().executeNode('n1');
    expect(notices.join(' ')).not.toContain('run safeguards');
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().runHistory[0]?.status).toBe('failed');
  });
  it('a 507 with no store named: not the run-safety line', async () => {
    refuseWith({ detail: 'Insufficient storage' });
    await useGraphStore.getState().executeNode('n1');
    expect(notices.join(' ')).not.toContain('run safeguards');
  });
});
