import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 3 (review 3, GM's r3 rulings and answers):
 * - M2 / GM 3: the person's Undo or Redo that would take off a shot still
 *   rendering is refused on the canvas before anything is sent, in GM's
 *   words; a restore the backend refuses anyway keeps the spinner and reads
 *   the backend's person line as is.
 * - H1: a scene save the backend refuses keeps the person's typing, and the
 *   next sync doesn't put the older scene over it; GM's save line says so.
 * - L2: a run of the graph holds the scene's shots only while it is on the
 *   scene (its node queued or executing).
 * - G1 / GM 1: a scene with a shot rendering can't be deleted: one toast for
 *   it alone, "Deleted 3 nodes. “Scene” wasn’t deleted because …" when the
 *   rest goes, and the disabled Delete's tooltip.
 * - GM r3 items 5 and 7: the unknown-actor reorder lines and the unnamed
 *   settings in "Nothing was undone".
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

const { useGraphStore, renderingScenes, sceneDeleteDisabledTitle, sceneStopLines } = await import('../../src/store/graphStore');
// GM r28 item 2 (round 19): the stop line is a state, in its own slot.
const stopLineOf = (nodeId: string) => sceneStopLines(useGraphStore.getState()).find((line) => line.nodeIds.includes(nodeId))?.text ?? null;
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { acceptUndoLine } = await import('../../src/lib/canvasUndo');
const { renderingRemovalLine, sceneDeleteRefusedLine, shotRemovalBlock } = await import('../../src/lib/cinemaScene');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Shot = Record<string, unknown>;
const sceneOf = (...shots: Shot[]) => ({ scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots } });
const cinema = (id: string, shots: Shot[], label = 'Scene', state = 'idle') => ({ id, type: 'cinemaSceneNode',
  position: { x: 0, y: 0 }, data: { label, definitionId: 'cinema-scene', params: sceneOf(...shots), state, outputs: {} } });
const textNode = (id: string, label = id) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label, definitionId: 'text-input', params: { text: '' }, state: 'idle', outputs: {} } });
const shotsOf = (id = 'n1') => ((useGraphStore.getState().nodes.find((n) => n.id === id)?.data.params.scene as { shots: Shot[] } | undefined)?.shots ?? []);
const shotRun = (shotId: string, nodeId = 'n1') => ({ id: `run-${shotId}`, kind: 'cinema-shot' as const, nodeId, shotId,
  nodeIds: [nodeId], status: 'running' as const });
const graphRun = (nodeIds: string[]) => ({ id: 'run-graph', kind: 'graph' as const, nodeIds, status: 'running' as const });
const restoresSent = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/graph/restore')).length;
const deletesSent = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE').length;
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [],
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: () => {} } as never);
});
afterEach(() => { vi.useRealTimers(); });

/** Shot 2 added (an undo step), then rendering. */
async function addedShotRendering(withRun: boolean) {
  useGraphStore.setState({ nodes: [cinema('n1', [{ id: 's1', prompt: 'a' }])] } as never);
  const added = useGraphStore.getState().addShot('n1') as string;
  await sleep(20);
  useGraphStore.setState((state) => ({
    activeRuns: withRun ? [shotRun(added)] : [],
    nodes: state.nodes.map((node) => ({ ...node, data: { ...node.data, params: sceneOf(...shotsOf().map((shot) => (
      shot.id === added ? { ...shot, prompt: 'typed', output: { status: 'running' } } : shot))) } })),
  }) as never);
  fetchMock.mockClear();
  return added;
}

// -- M2: Undo / Redo refused before it is sent ---------------------------------------

describe('M2 / GM 3: an undo or redo that would remove a rendering shot is refused before it is sent', () => {
  it('Undo, with a Stop for the shot: GM\'s line, nothing sent, nothing changed', async () => {
    const added = await addedShotRendering(true);
    const stacks = { undo: useGraphStore.getState().undoStack.length, redo: useGraphStore.getState().redoStack.length };
    useGraphStore.getState().undo();
    await sleep(30);
    expect(restoresSent()).toBe(0);
    expect(notice()).toBe("Couldn’t undo. It would remove “Shot 2”, which is still running. Stop the run first.");
    expect(shotsOf().map((shot) => shot.id)).toEqual(['s1', added]);
    expect((shotsOf()[1].output as { status: string }).status).toBe('running');
    expect(useGraphStore.getState().undoStack).toHaveLength(stacks.undo);
    expect(useGraphStore.getState().redoStack).toHaveLength(stacks.redo);
    expect(notice()).not.toMatch(/run-|cancel_run|nebula cancel/);
  });

  it('Undo with no Stop here (its run still starting): "…Wait for it to finish."', async () => {
    await addedShotRendering(false);
    useGraphStore.getState().undo();
    await sleep(30);
    expect(restoresSent()).toBe(0);
    expect(notice()).toBe("Couldn’t undo. It would remove “Shot 2”, which is still running. Wait for it to finish.");
  });

  it('Redo of a remove-shot step after the shot is regenerated: "Couldn’t redo. …"', async () => {
    useGraphStore.setState({ nodes: [cinema('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }])] } as never);
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(20);
    useGraphStore.getState().undo();
    await sleep(40);
    expect(shotsOf().map((shot) => shot.id)).toEqual(['s1', 's2']);
    useGraphStore.setState({ activeRuns: [shotRun('s2')] } as never);
    fetchMock.mockClear();
    useGraphStore.getState().redo();
    await sleep(30);
    expect(restoresSent()).toBe(0);
    expect(notice()).toBe("Couldn’t redo. It would remove “Shot 2”, which is still running. Stop the run first.");
    expect(shotsOf().map((shot) => shot.id)).toEqual(['s1', 's2']);
  });

  it('several shots: named up to three, counted from four', () => {
    expect(renderingRemovalLine('undo', { numbers: [2, 3], stoppable: true }))
      .toBe("Couldn’t undo. It would remove “Shot 2” and “Shot 3”, which are still running. Stop the run first.");
    expect(renderingRemovalLine('redo', { numbers: [1, 2, 3, 4], stoppable: false }))
      .toBe("Couldn’t redo. It would remove 4 shots that are still running. Wait for it to finish.");
  });

  it('an undo that takes nothing rendering away is still sent', async () => {
    useGraphStore.setState({ nodes: [cinema('n1', [{ id: 's1', prompt: 'a' }])] } as never);
    useGraphStore.getState().addShot('n1');
    await sleep(20);
    useGraphStore.setState({ activeRuns: [shotRun('s1')] } as never);
    fetchMock.mockClear();
    useGraphStore.getState().undo();
    await sleep(30);
    expect(restoresSent()).toBe(1);
  });
});

describe('M2: a restore the backend refuses keeps the spinner and reads the backend\'s person line', () => {
  it('a shot run that started while the undo was on its way: the shot comes back still rendering', async () => {
    useGraphStore.setState({ nodes: [cinema('n1', [{ id: 's1', prompt: 'a' }])] } as never);
    const added = useGraphStore.getState().addShot('n1') as string;
    await sleep(20);
    const line = "Couldn’t undo. It would remove “Shot 2”, which is still running. Stop the run first.";
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/graph/restore')) {
        // The shot's run starts in this tab before the answer comes.
        useGraphStore.setState({ activeRuns: [shotRun(added)] } as never);
        return json({ detail: line }, 409);
      }
      return json({});
    });
    useGraphStore.getState().undo();
    await sleep(60);
    expect(restoresSent()).toBe(1);
    expect(notice()).toBe(line);
    const back = shotsOf().find((shot) => shot.id === added);
    expect(back).toBeTruthy();
    expect((back!.output as { status: string }).status).toBe('running');
  });

  it('any other refusal keeps "Couldn’t undo that." before the reason', async () => {
    useGraphStore.setState({ nodes: [cinema('n1', [{ id: 's1', prompt: 'a' }])] } as never);
    useGraphStore.getState().addShot('n1');
    await sleep(20);
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/graph/restore')
      ? json({ detail: 'The project changed.' }, 409) : json({})));
    useGraphStore.getState().undo();
    await sleep(60);
    expect(notice()).toMatch(/^Couldn’t undo that\. /);
  });
});

// -- H1: a refused scene save keeps the typing ------------------------------------------

describe('H1: a scene save the backend refuses keeps the person\'s typing', () => {
  // Fix round 4 (review 4, HIGH): any refusal of a scene write puts the scene
  // back as the backend has it, so a later edit never re-sends what was
  // refused; GM's save line says it went back. This replaces round 3's "the
  // typing stays" (kept typing re-sent a refused shot removal with the next edit).
  it('a refused scene save (400) keeps the typing on screen, and GM\'s line says so', async () => {
    const said: string[] = [];
    useGraphStore.setState({ nodes: [cinema('n31', [{ id: 's1', prompt: 'old' }], 'Opening')],
      notify: (text: string) => said.push(text) } as never);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (
      String(url).includes('/api/graph/node/n31') && init?.method === 'PUT'
        ? json({ detail: 'scene.shots[0].prompt must be text' }, 400) : json({})));
    useGraphStore.getState().updateScene('n31', (current) => ({ ...current,
      shots: current.shots.map((shot) => ({ ...shot, prompt: 'typed by the person' })) }));
    await sleep(80);
    // Round 5 (GM r7 item 1): a 400 is Nebula's bug; the typing stays on
    // screen, unsaved, and GM's line says so.
    // GM r22 Q3: the one 400 line, with [Try again]; GM r28: in the state slot.
    expect(stopLineOf('n31')).toBe('Nebula can’t save your changes to “Opening”.');
    expect(said).toEqual([]);
    expect(shotsOf('n31')[0].prompt).toBe('typed by the person');
  });

  it('a newer edit from someone else after the refusal: the person\'s edits stay on screen, and a clash asks (GM r9)', async () => {
    const said: string[] = [];
    useGraphStore.setState({ nodes: [cinema('n32', [{ id: 's1', prompt: 'old' }], 'Opening')],
      notify: (text: string) => said.push(text) } as never);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (
      String(url).includes('/api/graph/node/n32') && init?.method === 'PUT'
        ? json({ detail: 'refused' }, 400) : json({})));
    useGraphStore.getState().updateScene('n32', (current) => ({ ...current,
      shots: current.shots.map((shot) => ({ ...shot, prompt: 'typed' })) }));
    await sleep(80);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [cinema('n32', [{ id: 's1', prompt: 'an agent\'s fix' }], 'Opening')],
      edit: { actor: { kind: 'agent', name: 'Codex', id: 'cx' } } });
    await sleep(10);
    // PR #198 round 7 (GM r9 decision 2): the same field on both sides is a
    // clash: kept on screen, and the person is asked which to keep.
    expect(shotsOf('n32')[0].prompt).toBe('typed');
    expect(useGraphStore.getState().sceneClashes.n32?.line)
      .toBe('Codex changed “Opening” while you were editing it.');
  });
});

// -- L2: a graph run holds the shots only while it is on the scene ---------------------------

describe('L2: a run of the graph holds the scene\'s shots only while it is on the scene', () => {
  const shot = { id: 's1', output: { imageUrl: '/x.png', status: 'done' as const } };
  it.each([
    [undefined, 'stop'], ['queued', 'stop'], ['executing', 'stop'], ['complete', null], ['error', null], ['idle', null],
  ] as const)('scene state %s: %s', (state, block) => {
    expect(shotRemovalBlock([graphRun(['n1', 'n2'])], 'n1', shot, state as never)).toBe(block);
  });

  it('removeShot and Undo go once the run has moved past the scene', async () => {
    useGraphStore.setState({ nodes: [cinema('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }], 'Scene', 'complete')],
      activeRuns: [graphRun(['n1', 'n2'])] } as never);
    useGraphStore.getState().removeShot('n1', 's2');
    expect(shotsOf().map((s) => s.id)).toEqual(['s1']);
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, data: { ...node.data, state: 'executing' } })) }) as never);
    useGraphStore.getState().removeShot('n1', 's1');
    expect(shotsOf().map((s) => s.id)).toEqual(['s1']);
  });
});

// -- G1: a scene with a shot rendering can't be deleted ----------------------------------------

describe('G1 / GM 1: a scene with a shot rendering can\'t be deleted', () => {
  const renderingScene = (stoppable = true) => {
    useGraphStore.setState({
      nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b', output: { status: 'running' } }], 'Opening'),
        textNode('n5', 'Brief'), textNode('n6', 'Note'), textNode('n7', 'Logo')],
      activeRuns: stoppable ? [shotRun('s2', 'n4')] : [],
    } as never);
  };

  it('alone, by the Delete key or the menu: GM\'s toast, nothing sent, the scene stays', async () => {
    renderingScene();
    useGraphStore.getState().deleteNode('n4');
    await sleep(20);
    expect(deletesSent()).toBe(0);
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toContain('n4');
    expect(notice()).toBe("Couldn’t delete “Opening”. “Shot 2” is still running. Stop the run first.");
    // The same through React Flow's own removal.
    useGraphStore.setState({ undoNotice: null } as never);
    useGraphStore.getState().onNodesChange([{ id: 'n4', type: 'remove' }]);
    expect(notice()).toBe("Couldn’t delete “Opening”. “Shot 2” is still running. Stop the run first.");
  });

  it('no Stop here: "…Wait for it to finish."', () => {
    renderingScene(false);
    useGraphStore.getState().deleteNode('n4');
    expect(notice()).toBe("Couldn’t delete “Opening”. “Shot 2” is still running. Wait for it to finish.");
  });

  it('several shots: named, and counted from four', () => {
    expect(sceneDeleteRefusedLine('Opening', { numbers: [2, 3], stoppable: true }))
      .toBe("Couldn’t delete “Opening”. “Shot 2” and “Shot 3” are still running. Stop the run first.");
    expect(sceneDeleteRefusedLine('Opening', { numbers: [1, 2, 3, 4], stoppable: false }))
      .toBe("Couldn’t delete “Opening”. 4 shots are still running. Wait for it to finish.");
  });

  it('multi-select: the rest is deleted, the scene stays, and the line says why', async () => {
    renderingScene();
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: true })) }) as never);
    useGraphStore.getState().deleteSelected();
    await sleep(40);
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n4']);
    // GM r6: the deleted nodes are named (up to 3).
    expect(notice()).toBe("Deleted “Brief”, “Note” and “Logo”. “Opening” wasn’t deleted because “Shot 2” is still running.");
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/n4') && (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('the disabled Delete\'s tooltip', () => {
    renderingScene();
    const state = useGraphStore.getState();
    expect(sceneDeleteDisabledTitle(state, ['n4'])).toBe('Stop the run first.');
    expect(sceneDeleteDisabledTitle(state, ['n4', 'n5'])).toBeNull();
    expect(sceneDeleteDisabledTitle(state, ['n5'])).toBeNull();
    renderingScene(false);
    expect(sceneDeleteDisabledTitle(useGraphStore.getState(), ['n4'])).toBe('Wait for “Opening” to finish.');
  });

  it('a scene whose graph run has moved on can be deleted', () => {
    useGraphStore.setState({ nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }], 'Opening', 'complete')],
      activeRuns: [graphRun(['n4', 'n5'])] } as never);
    expect(renderingScenes(useGraphStore.getState(), ['n4'])).toEqual([]);
  });
});

// -- GM r3 items 5 and 7 -------------------------------------------------------------------

describe('GM r3 items 2, 5 and 7: the Accept undo lines', () => {
  const agent = { kind: 'agent' as const, name: 'Codex' };
  const you = { kind: 'you' as const };
  const unknown = { kind: 'unknown' as const };

  it('item 5: an unknown source\'s reorder', () => {
    expect(acceptUndoLine([{ node: 'X', settings: [], order: 'shots' }], unknown, false))
      .toBe('Undid the proposal except the shot order in “X”. The shots were reordered after you accepted.');
    expect(acceptUndoLine([{ node: 'X', settings: [], order: 'clips' }], unknown, false))
      .toBe('Undid the proposal except the clip order in “X”. The clips were reordered after you accepted.');
    expect(acceptUndoLine([{ node: 'X', settings: [], order: 'shots' }], unknown, true))
      .toBe('Nothing was undone. The shots were reordered after you accepted.');
  });

  it('item 2: "You reordered them in another window after you accepted."', () => {
    expect(acceptUndoLine([{ node: 'X', settings: [], order: 'shots' }], you, false))
      .toBe('Undid the proposal except the shot order in “X”. You reordered them in another window after you accepted.');
  });

  it('item 7: unnamed settings in "Nothing was undone"', () => {
    expect(acceptUndoLine([{ node: 'Hero still', settings: [null] }], agent, true))
      .toBe('Nothing was undone. Codex changed a setting on “Hero still” after you accepted.');
    expect(acceptUndoLine([{ node: 'Hero still', settings: [null, 'Seed', null] }], agent, true))
      .toBe('Nothing was undone. Codex changed 3 settings on “Hero still” after you accepted.');
    expect(acceptUndoLine([{ node: 'A', settings: [null] }, { node: 'B', settings: ['Seed'] }], agent, true))
      .toBe('Nothing was undone. Codex changed settings on “A” and “B” after you accepted.');
    expect(acceptUndoLine(['A', 'B', 'C', 'D'].map((node) => ({ node, settings: [null] })), agent, true))
      .toBe('Nothing was undone. Codex changed settings on 4 nodes after you accepted.');
  });
});

void TAB_ID;
