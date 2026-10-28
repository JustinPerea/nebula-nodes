import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 4 (review 4; GM's r4 and r5 rulings):
 * - H1-new: a scene write the backend refuses (a shot removal while a run
 *   this tab doesn't own renders it) drops the pending authoring, puts the
 *   backend's scene back, reads the backend's own line, and no later edit
 *   sends the removal again: the shot and its paid image stay (review 4, R3).
 * - M1: the run lock is never silent. During the tab's own run (a real
 *   executeShot: isExecuting is true) the Delete key, the menu, deleteSelected
 *   and Undo/Redo say why: GM's scene and shot lines when that is the
 *   reason, else "… Wait for the active run to finish." (GM r5 item 2).
 * - M1: another window's run: one line, the backend's named one, never the
 *   generic "Couldn’t delete the node." in front (GM r5 item 3); a
 *   multi-select keeps "Deleted 2 nodes." with Undo and GM's kept line.
 * - M2: a shot run's upstream scene is held on the canvas too.
 * - GM r4 items 2 and 3: four or more kept scenes are counted; the several-
 *   scene tooltips.
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

const { useGraphStore, sceneDeleteDisabledTitle } = await import('../../src/store/graphStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { scenesKeptLine, shotRemovalBlock, RUN_LOCK_REASON, runLockedLine } = await import('../../src/lib/cinemaScene');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Shot = Record<string, unknown>;
const sceneOf = (...shots: Shot[]) => ({ scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots } });
const cinema = (id: string, shots: Shot[], label = 'Scene', outputs: Record<string, unknown> = {}) => ({ id, type: 'cinemaSceneNode',
  position: { x: 0, y: 0 }, data: { label, definitionId: 'cinema-scene', params: sceneOf(...shots), state: 'idle', outputs } });
const textNode = (id: string, label = id) => ({ id, type: 'model-node', position: { x: 300, y: 0 },
  data: { label, definitionId: 'text-input', params: { text: '' }, state: 'idle', outputs: {} } });
const shotsOf = (id = 'n1') => ((useGraphStore.getState().nodes.find((n) => n.id === id)?.data.params.scene as { shots: Shot[] } | undefined)?.shots ?? []);
const ids = () => useGraphStore.getState().nodes.map((node) => node.id);
const sent = (method: string, path = '') => fetchMock.mock.calls.filter(([url, init]) => (
  (init as RequestInit | undefined)?.method === method && String(url).includes(path)));
const restoresSent = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/graph/restore')).length;
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;
let said: string[] = [];

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  said = [];
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [],
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (text: string) => { said.push(text); } } as never);
});

// -- H1-new: a refused shot removal -------------------------------------------------------

const REMOVE_LINE = "Couldn't remove “Shot 2”. It's still running. Stop the run first.";
const PAID = '/api/outputs/paid-s2.png';

function backendGraph(s2: Shot = { id: 's2', prompt: 'b' }) {
  return {
    nodes: [cinema('n1', [{ id: 's1', prompt: 'a' }, s2], 'Opening',
      s2.output ? { shot_s2: { type: 'Image', value: PAID } } : {}), textNode('n2', 'Grade')],
    edges: [{ id: 'e1', type: 'typed-edge', source: 'n1', sourceHandle: 'shot_s2', target: 'n2', targetHandle: 'text',
      data: { dataType: 'Image' } }],
  };
}

describe('H1-new: a shot removal another window\'s run refuses (review 4, R3)', () => {
  function setUp(status = 409, detail = REMOVE_LINE) {
    const graph = backendGraph();
    useGraphStore.setState({ nodes: graph.nodes, edges: graph.edges } as never);
    const puts: string[][] = [];
    let refuse = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(url).includes('/api/graph/node/n1')) {
        const body = JSON.parse(String(init.body));
        const shots = body.params.scene.shots.map((shot: Shot) => shot.id);
        puts.push(shots);
        // Round 5: the backend's 409 names the rendering shot (rendering.shotIds),
        // so only a write that removes it is refused.
        if (refuse && status === 409) return shots.includes('s2') ? json({ ok: true })
          : json({ detail, code: 'rendering_shots', rendering: { shotIds: ['s2'], shots: [2], stoppable: true } }, 409);
        return refuse ? json({ detail }, status) : json({ ok: true });
      }
      if (String(url).includes('/api/graph/export')) return json({ ...base, ...backendGraph(), empty: false });
      return json({});
    });
    return { puts, accept: () => { refuse = false; } };
  }

  it('the shot comes back with its wire, the backend\'s line is the only line, and nothing re-sends the removal', async () => {
    const { puts, accept } = setUp();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(120);
    expect(shotsOf().map((shot) => shot.id)).toEqual(['s1', 's2']);
    expect(said).toEqual([REMOVE_LINE]);
    expect(notice() ?? '').not.toMatch(/Couldn’t save/);
    // Its wire was never sent away: the scene write alone removes a shot's wires.
    expect(sent('DELETE', '/api/graph/edge')).toHaveLength(0);
    expect(useGraphStore.getState().edges.map((edge) => edge.sourceHandle)).toEqual(['shot_s2']);
    // The refused removal isn't left as an undo step that does nothing.
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    // The run ends: its write-back gives Shot 2 its paid image.
    accept();
    const paid = backendGraph({ id: 's2', prompt: 'b', output: { imageUrl: PAID, status: 'done' } });
    socketSends({ type: 'graphSync', ...base, empty: false, ...paid, edit: { actor: { kind: 'run' } } });
    await sleep(40);
    expect(shotsOf().map((shot) => shot.id)).toEqual(['s1', 's2']);
    // The canvas reads the backend's graph again, which resolves the URL against the backend.
    expect((shotsOf()[1].output as { imageUrl?: string }).imageUrl).toMatch(/\/api\/outputs\/paid-s2\.png$/);
    // The person's next edit, anywhere in the scene, keeps Shot 2.
    useGraphStore.getState().updateScene('n1', (current) => ({ ...current,
      shots: current.shots.map((shot) => (shot.id === 's1' ? { ...shot, prompt: 'a2' } : shot)) }));
    await sleep(120);
    // Round 5 (GM r6 item 1): the rest of the save goes again at once without
    // the removal; the next edit keeps Shot 2 too.
    expect(puts).toEqual([['s1'], ['s1', 's2'], ['s1', 's2']]);
    expect(shotsOf().map((shot) => shot.id)).toEqual(['s1', 's2']);
    expect((shotsOf()[1].output as { imageUrl?: string }).imageUrl).toMatch(/\/api\/outputs\/paid-s2\.png$/);
  });

  it('a sync that brings the backend\'s older scene before the next edit never revives the removal', async () => {
    const { puts, accept } = setUp();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(120);
    socketSends({ type: 'graphSync', ...base, empty: false, ...backendGraph(), edit: { actor: { kind: 'run' } } });
    await sleep(20);
    accept();
    useGraphStore.getState().updateScene('n1', (current) => ({ ...current, aspectRatio: '1:1' }));
    await sleep(120);
    expect(puts.at(-1)).toEqual(['s1', 's2']);
  });

  it('a 413: the edits stay on screen, marked unsaved, with GM\'s line (round 5, GM r6 item 1)', async () => {
    setUp(413, 'Too large.');
    useGraphStore.getState().updateScene('n1', (current) => ({ ...current,
      shots: current.shots.map((shot) => (shot.id === 's1' ? { ...shot, prompt: 'very long' } : shot)) }));
    await sleep(120);
    expect(shotsOf()[0].prompt).toBe('very long');
    expect(said).toEqual(["Couldn’t save “Opening”. The project is too big to save. Remove something and Nebula will save your changes."]);
  });
});

// -- M1: the tab's own run (a real executeShot) --------------------------------------------

/** n4 "Opening" (s1, s2) with s2 rendering in this tab's own shot run,
 * started through executeShot as the app does; n5-n7 text nodes. */
async function ownShotRun(extraShot = false) {
  useGraphStore.setState({ nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }], 'Opening'),
    textNode('n5', 'Brief'), textNode('n6', 'Note'), textNode('n7', 'Logo')] } as never);
  let added: string | null = null;
  if (extraShot) {
    added = useGraphStore.getState().addShot('n4');
    await sleep(30);
  }
  fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/cinema/generate-shot')
    ? json({ status: 'started', runId: 'own-run' }) : json({})));
  void useGraphStore.getState().executeShot('n4', added ?? 's2');
  await sleep(60);
  expect(useGraphStore.getState().isExecuting).toBe(true);
  fetchMock.mockClear();
  return added;
}

const select = (...which: string[]) => useGraphStore.setState((state) => ({
  nodes: state.nodes.map((node) => ({ ...node, selected: which.includes(node.id) })) }) as never);

describe('M1: during the tab\'s own run, every delete and undo path says why', () => {
  it('the scene, by the menu, the Delete key or deleteSelected: GM\'s scene line', async () => {
    await ownShotRun();
    const line = "Couldn’t delete “Opening”. “Shot 2” is still running. Stop the run first.";
    useGraphStore.getState().deleteNode('n4');
    expect(notice()).toBe(line);
    useGraphStore.setState({ undoNotice: null } as never);
    useGraphStore.getState().onNodesChange([{ id: 'n4', type: 'remove' }]);
    expect(notice()).toBe(line);
    useGraphStore.setState({ undoNotice: null } as never);
    select('n4');
    useGraphStore.getState().deleteSelected();
    expect(notice()).toBe(line);
    useGraphStore.setState({ undoNotice: null } as never);
    expect(useGraphStore.getState().allowCanvasDelete(['n4'])).toBe(false);
    expect(notice()).toBe(line);
    await sleep(20);
    expect(sent('DELETE')).toHaveLength(0);
    expect(ids()).toEqual(['n4', 'n5', 'n6', 'n7']);
  });

  it('another node: "Couldn’t delete “Brief”. Wait for the active run to finish."', async () => {
    await ownShotRun();
    useGraphStore.getState().deleteNode('n5');
    expect(notice()).toBe("Couldn’t delete “Brief”. Wait for the active run to finish.");
    useGraphStore.setState({ undoNotice: null } as never);
    expect(useGraphStore.getState().allowCanvasDelete(['n5'])).toBe(false);
    expect(notice()).toBe("Couldn’t delete “Brief”. Wait for the active run to finish.");
    expect(ids()).toContain('n5');
  });

  it('a multi-select with the scene: "Couldn’t delete 4 nodes. Wait for the active run to finish."', async () => {
    await ownShotRun();
    select('n4', 'n5', 'n6', 'n7');
    useGraphStore.getState().deleteSelected();
    expect(notice()).toBe("Couldn’t delete 4 nodes. Wait for the active run to finish.");
    useGraphStore.setState({ undoNotice: null } as never);
    useGraphStore.getState().onNodesChange(['n5', 'n6'].map((id) => ({ id, type: 'remove' as const })));
    // GM r6: several nodes are named.
    expect(notice()).toBe("Couldn’t delete “Brief” and “Note”. Wait for the active run to finish.");
    await sleep(20);
    expect(sent('DELETE')).toHaveLength(0);
    expect(ids()).toEqual(['n4', 'n5', 'n6', 'n7']);
    expect(said).toEqual([]);
  });

  it('Undo of the step that added the rendering shot: GM\'s undo line, nothing sent', async () => {
    const added = await ownShotRun(true);
    useGraphStore.getState().undo();
    await sleep(20);
    expect(notice()).toBe("Couldn’t undo. It would remove “Shot 3”, which is still running. Stop the run first.");
    expect(restoresSent()).toBe(0);
    expect(shotsOf('n4').map((shot) => shot.id)).toEqual(['s1', 's2', added]);
  });

  it('Undo or Redo of anything else: "Couldn’t undo. Wait for the active run to finish."', async () => {
    useGraphStore.setState({ nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }], 'Opening'),
      textNode('n5', 'Brief')] } as never);
    useGraphStore.getState().duplicateNode('n5');
    useGraphStore.getState().duplicateNode('n5');
    await sleep(20);
    useGraphStore.getState().undo();
    await sleep(40);
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/cinema/generate-shot')
      ? json({ status: 'started', runId: 'own-run' }) : json({})));
    void useGraphStore.getState().executeShot('n4', 's2');
    await sleep(60);
    fetchMock.mockClear();
    const stacks = [useGraphStore.getState().undoStack.length, useGraphStore.getState().redoStack.length];
    expect(stacks[0]).toBeGreaterThan(0);
    expect(stacks[1]).toBeGreaterThan(0);
    useGraphStore.getState().redo();
    expect(notice()).toBe("Couldn’t redo. Wait for the active run to finish.");
    useGraphStore.getState().undo();
    expect(notice()).toBe("Couldn’t undo. Wait for the active run to finish.");
    await sleep(20);
    expect(restoresSent()).toBe(0);
    expect([useGraphStore.getState().undoStack.length, useGraphStore.getState().redoStack.length]).toEqual(stacks);
  });

  it('nothing to undo stays quiet', async () => {
    await ownShotRun();
    useGraphStore.setState({ undoStack: [], redoStack: [], undoNotice: null } as never);
    useGraphStore.getState().undo();
    expect(notice()).toBeNull();
  });

  it('the line\'s parts are GM\'s (r5 item 2)', () => {
    expect(RUN_LOCK_REASON).toBe('Wait for the active run to finish.');
    expect(runLockedLine('delete', 1, '“X”')).toBe("Couldn’t delete “X”. Wait for the active run to finish.");
    expect(runLockedLine('delete', 1)).toBe("Couldn’t delete the node. Wait for the active run to finish.");
    expect(runLockedLine('delete', 3)).toBe("Couldn’t delete 3 nodes. Wait for the active run to finish.");
    expect(runLockedLine('undo')).toBe("Couldn’t undo. Wait for the active run to finish.");
    expect(runLockedLine('redo')).toBe("Couldn’t redo. Wait for the active run to finish.");
  });
});

// -- M1: another window's run ---------------------------------------------------------------

const SCENE_LINE = "Couldn’t delete “Opening”. “Shot 2” is still running. Stop the run first.";

describe('M1: a run this tab doesn\'t own: the backend\'s named line, once', () => {
  function otherWindowRun() {
    useGraphStore.setState({ nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }], 'Opening'),
      textNode('n5', 'Brief'), textNode('n6', 'Note')] } as never);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE' && String(url).endsWith('/api/graph/node/n4')) {
        return json({ detail: SCENE_LINE, rendering: { shots: [2], stoppable: true } }, 409);
      }
      if (init?.method === 'DELETE') return json({ removal: null });
      return json({});
    });
  }

  it('the scene alone: only the backend\'s line', async () => {
    otherWindowRun();
    useGraphStore.getState().deleteNode('n4');
    await sleep(60);
    expect(said).toEqual([SCENE_LINE]);
    expect(ids()).toContain('n4');
  });

  it('a multi-select: "Deleted 2 nodes." with Undo, then GM\'s kept line', async () => {
    otherWindowRun();
    useGraphStore.getState().onNodesChange(['n4', 'n5', 'n6'].map((id) => ({ id, type: 'remove' as const })));
    await sleep(80);
    expect(ids()).toEqual(['n4']);
    const shown = useGraphStore.getState().undoNotice;
    // GM r6: the deleted nodes are named.
    expect(shown?.text).toBe("Deleted “Brief” and “Note”. “Opening” wasn’t deleted because “Shot 2” is still running.");
    expect(shown?.offer).toBe('undo');
    expect(said).toEqual([]);
  });

  it('a refusal with no shots named still reads its own line alone', async () => {
    useGraphStore.setState({ nodes: [textNode('n5', 'Brief')] } as never);
    fetchMock.mockImplementation(async () => json({ detail: "Couldn’t delete “Brief”. It's locked." }, 409));
    useGraphStore.getState().deleteNode('n5');
    await sleep(60);
    expect(said).toEqual(["Couldn’t delete “Brief”. It's locked."]);
  });
});

// -- M2 on the canvas: a shot run's upstream scene ---------------------------------------

describe('M2: a shot run holds its upstream scene on the canvas too', () => {
  it('the upstream scene\'s shots can\'t be removed and its Delete is disabled', async () => {
    useGraphStore.setState({
      nodes: [cinema('n1', [{ id: 'u1', prompt: 'u' }, { id: 'u2', prompt: 'v' }], 'Upstream'),
        cinema('n4', [{ id: 's1', prompt: 'a' }], 'Opening')],
      edges: [{ id: 'e1', type: 'typed-edge', source: 'n1', sourceHandle: 'shot_u1', target: 'n4',
        targetHandle: 'character_refs', data: { dataType: 'Image' } }],
    } as never);
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/cinema/generate-shot')
      ? json({ status: 'started', runId: 'own-run' }) : json({})));
    void useGraphStore.getState().executeShot('n4', 's1', undefined, 2);
    await sleep(60);
    const state = useGraphStore.getState();
    expect(shotRemovalBlock(state.activeRuns, 'n1', { id: 'u2', output: undefined })).toBe('stop');
    expect(sceneDeleteDisabledTitle(state, ['n1'])).toBe('Stop the run first.');
    fetchMock.mockClear();
    useGraphStore.getState().removeShot('n1', 'u2');
    await sleep(20);
    expect(shotsOf('n1').map((shot) => shot.id)).toEqual(['u1', 'u2']);
    expect(sent('PUT')).toHaveLength(0);
  });
});

// -- GM r4 items 2 and 3 ------------------------------------------------------------------

describe('GM r4: several scenes', () => {
  const kept = (count: number) => Array.from({ length: count }, (_, index) => ({
    scene: `Scene ${index + 1}`, shots: { numbers: [1], stoppable: true } }));

  it('item 2: two or three are named; four or more are counted', () => {
    expect(scenesKeptLine(kept(2))).toBe("“Scene 1” and “Scene 2” weren’t deleted because their shots are still running.");
    expect(scenesKeptLine(kept(4))).toBe("4 scenes weren’t deleted because their shots are still running.");
  });

  it('item 3: the tooltip over several rendering scenes', () => {
    const scenes = [cinema('n1', [{ id: 's1', prompt: 'a', output: { status: 'running' } }], 'A'),
      cinema('n2', [{ id: 's1', prompt: 'a', output: { status: 'running' } }], 'B')];
    expect(sceneDeleteDisabledTitle({ nodes: scenes, activeRuns: [] } as never, ['n1', 'n2']))
      .toBe('Wait for the running shots to finish.');
    // A run of the graph still on the scenes (their nodes rendering): the canvas's Stop ends it.
    const run = { id: 'r', kind: 'graph' as const, nodeIds: ['n1', 'n2'], status: 'running' as const };
    const rendering = scenes.map((node) => ({ ...node, data: { ...node.data, state: 'executing' } }));
    expect(sceneDeleteDisabledTitle({ nodes: rendering, activeRuns: [run] } as never, ['n1', 'n2']))
      .toBe('Stop the runs first.');
  });
});
