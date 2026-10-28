import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 6 (GM's pr198 r8 and pr200 r2 rulings), the store side:
 * - Canvas order for every name list (GM, #200 r2 item 3): both multi-delete
 *   lines name their nodes in the order the canvas holds them, not the order
 *   they were removed in.
 * - (superseded by fix round 7, GM r9 decision 2: a clash asks) CHANGED_ELSEWHERE (GM r8): "Couldn't save your changes to “X”.
 *   It was changed in another window first, so your changes are kept on
 *   screen but not saved." The edits stay on screen, marked "Not saved", and
 *   nothing sends them by itself; the person's next edit saves the scene as
 *   they see it.
 * - SWITCHED_UNNAMED (GM r8): "…The canvas switched to another project first."
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

const store = await import('../../src/store/graphStore');
const { useGraphStore } = store;
const setSceneRetryDelaysForTests = (delays: number[]) => (store as { setSceneRetryDelaysForTests?: (d: number[]) => void }).setSceneRetryDelaysForTests?.(delays);
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Shot = Record<string, unknown>;
const sceneOf = (...shots: Shot[]) => ({ scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots } });
const cinema = (id: string, shots: Shot[], label = 'Opening', outputs: Record<string, unknown> = {}) => ({ id, type: 'cinemaSceneNode',
  position: { x: 0, y: 0 }, data: { label, definitionId: 'cinema-scene', params: sceneOf(...shots), state: 'idle', outputs } });
const textNode = (id: string, label = id, text = '') => ({ id, type: 'model-node', position: { x: 300, y: 0 },
  data: { label, definitionId: 'text-input', params: { text }, state: 'idle', outputs: {} } });
const nodeOf = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id);
const shotsOf = (id = 'n1') => ((nodeOf(id)?.data.params.scene as { shots: Shot[] } | undefined)?.shots ?? []);
const brief = (id = 'n1') => shotsOf(id).map((s) => `${s.id}:${s.prompt}${(s.output as { imageUrl?: string } | undefined)?.imageUrl ? '+img' : ''}`);
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;
const unsaved = (id = 'n1') => (useGraphStore.getState() as { unsavedScenes?: Record<string, string> }).unsavedScenes?.[id] ?? null;
let said: string[] = [];
let logged: string[] = [];

const REMOVE_LINE = "Couldn't remove “Shot 2”. It's still running. Stop the run first.";
const PAID = '/api/outputs/paid-s2.png';
const RENDERING_409 = { detail: REMOVE_LINE, code: 'rendering_shots', rendering: { shotIds: ['s2'], shots: [2], stoppable: true } };

function backendGraph(s1: Shot = { id: 's1', prompt: 'a' }, s2: Shot | null = { id: 's2', prompt: 'b' }) {
  const shots = s2 ? [s1, s2] : [s1];
  return {
    nodes: [cinema('n1', shots, 'Opening', s2?.output ? { shot_s2: { type: 'Image', value: PAID } } : {}), textNode('n2', 'Grade')],
    edges: s2 ? [{ id: 'e1', type: 'typed-edge', source: 'n1', sourceHandle: 'shot_s2', target: 'n2', targetHandle: 'text',
      data: { dataType: 'Image' } }] : [],
  };
}

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  store.clearCinemaScenePersistence();
  setSceneRetryDelaysForTests([30, 30, 30]);
  said = [];
  logged = [];
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [],
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (text: string) => { said.push(text); } } as never);
});
window.addEventListener('nebula:agent-log-entry', (event) => { logged.push((event as CustomEvent<{ message: string }>).detail.message); });

/**
 * A backend whose first n1 PUT waits until `release()`, then answers
 * `first` (default: the rendering 409). Later n1 PUTs answer `later` (default
 * 200). Restores, exports and every PUT's shots are recorded.
 */
/** The backend's graph reaches the tab as the app gets it: a graphSync. */
function syncs(graph: object) {
  socketSends({ type: 'graphSync', ...base, empty: false, ...graph });
}

function harness(options: { first?: () => Response; later?: () => Response; exportGraph?: () => object; start?: object } = {}) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [], edges: [] } as never);
  syncs(options.start ?? backendGraph());
  const puts: string[][] = [];
  const restores: string[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  let later = options.later ?? (() => json({ ok: true }));
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'PUT' && path.includes('/api/graph/node/n1')) {
      const body = JSON.parse(String(init.body));
      puts.push(body.params.scene.shots.map((s: Shot) => `${s.id}:${s.prompt}`));
      count += 1;
      if (count === 1) {
        await gate;
        return options.first ? options.first() : json(RENDERING_409, 409);
      }
      return later();
    }
    if (path.includes('/api/graph/restore')) {
      const body = JSON.parse(String(init?.body));
      const n1 = (body.nodes ?? []).find((n: { id: string }) => n.id === 'n1');
      const shots = n1?.data?.params?.scene?.shots ?? n1?.params?.scene?.shots;
      if (shots) restores.push(shots.map((s: Shot) => `${s.id}:${s.prompt}`));
      return json({ ok: true });
    }
    if (path.includes('/api/graph/export')) {
      return json({ ...base, ...(options.exportGraph ? options.exportGraph() : backendGraph()), empty: false });
    }
    return json({});
  });
  return { puts, restores, release: () => release(), answerLater: (answer: () => Response) => { later = answer; } };
}

const typeIn = (shotId: string, prompt: string) => useGraphStore.getState().updateScene('n1', (current) => ({ ...current,
  shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, prompt } : shot)) }));


async function ownRun(nodes: unknown[]) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }], 'Opening'), ...nodes] } as never);
  fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/cinema/generate-shot')
    ? json({ status: 'started', runId: 'own-run' }) : json({})));
  void useGraphStore.getState().executeShot('n4', 's2');
  await sleep(60);
  expect(useGraphStore.getState().isExecuting).toBe(true);
}

describe('GM (#200 r2 item 3): the multi-delete lines read in canvas order', () => {
  it('a plain multi-delete: the canvas\'s order, whatever order they went in', async () => {
    useGraphStore.setState({ nodes: [textNode('n5', 'A'), textNode('n6', 'B'), textNode('n7', 'C')] } as never);
    fetchMock.mockImplementation(async () => json({ removal: null }));
    useGraphStore.getState().onNodesChange(['n7', 'n5'].map((id) => ({ id, type: 'remove' as const })));
    await sleep(80);
    expect(notice()).toBe('Deleted “A” and “C”.');
  });

  it('own run: "Couldn\'t delete “A” and “B”." in canvas order', async () => {
    await ownRun([textNode('n5', 'A'), textNode('n6', 'B')]);
    useGraphStore.getState().onNodesChange(['n6', 'n5'].map((id) => ({ id, type: 'remove' as const })));
    expect(notice()).toBe("Couldn't delete “A” and “B”. Wait for the active run to finish.");
  });

  it('another window\'s run: the deleted names and the kept scenes, both in canvas order', async () => {
    useGraphStore.setState({ nodes: [cinema('n3', [{ id: 's1', prompt: 'a' }], 'First scene'), cinema('n4', [{ id: 's1', prompt: 'a' }], 'Ref scene'),
      textNode('n5', 'A'), textNode('n6', 'B')] } as never);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const id = String(url).split('/').pop();
      if (init?.method === 'DELETE' && (id === 'n3' || id === 'n4')) {
        return json({ detail: `Couldn't delete “${id === 'n3' ? 'First scene' : 'Ref scene'}”. “Shot 1” is still running. Stop the run first.`,
          rendering: { shots: [1], shotIds: ['s1'], stoppable: true } }, 409);
      }
      if (init?.method === 'DELETE') return json({ removal: null });
      return json({});
    });
    useGraphStore.getState().onNodesChange(['n6', 'n4', 'n5', 'n3'].map((id) => ({ id, type: 'remove' as const })));
    await sleep(120);
    expect(notice()).toBe("Deleted “A” and “B”. “First scene” and “Ref scene” weren't deleted because their shots are still running.");
  });
});

describe('GM r9 decision 2: a clash with another window waits for the person', () => {
  const LINE = '“Opening” was changed in another window while you were editing it.';

  it('kept edits, then another window changes the same shot: mine stay on screen, saves send theirs for it, Keep mine saves mine', async () => {
    setSceneRetryDelaysForTests([400, 400, 400]);
    const h = harness({ first: () => json({ detail: 'boom' }, 500), later: () => json({ detail: 'boom' }, 500) });
    typeIn('s1', 'mine');
    await sleep(20);
    h.release();
    await sleep(60);
    expect(unsaved()).toBe("Couldn't save your changes to “Opening”. They're kept and Nebula will try again.");
    h.answerLater(() => json({ ok: true }));
    syncs(backendGraph({ id: 's1', prompt: 'from another window' }));
    await sleep(60);
    expect(brief()).toEqual(['s1:mine', 's2:b']);
    expect(useGraphStore.getState().sceneClashes.n1?.line).toBe(LINE);
    expect(unsaved()).toBe(LINE);
    // The person's next edit elsewhere saves, with Shot 1 as the other window left it.
    typeIn('s2', 'and more');
    await sleep(120);
    expect(h.puts.at(-1)).toEqual(['s1:from another window', 's2:and more']);
    expect(brief()).toEqual(['s1:mine', 's2:and more']);
    expect(unsaved()).toBe(LINE);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(120);
    expect(h.puts.at(-1)).toEqual(['s1:mine', 's2:and more']);
    expect(unsaved()).toBeNull();
    expect(useGraphStore.getState().sceneClashes.n1).toBeUndefined();
  });

  it('SWITCHED_UNNAMED: the canvas switched and the backend named no project', async () => {
    const h = harness({ first: () => json({ detail: 'This canvas is out of date.', code: 'workspace_moved', project: null, switchedBy: null }, 409) });
    typeIn('s1', 'moved');
    await sleep(20);
    h.release();
    await sleep(120);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. The canvas switched to another project first."]);
  });
});
