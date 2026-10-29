import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 22 (GM r32), on graphStore.fix21stops' keyed backend:
 * - Answer 1: the run-lock line is not a failure, merged with the shared name
 *   list: "Your changes to “Opening” are kept. Nebula will save them when the
 *   run finishes."
 * - Answer 2: the "other" line gets [Try again], one try, like the other stop
 *   lines; its wording stands.
 * - Answer 3: both are state lines (no ×, never a toast); the run-lock line
 *   clears when the run ends, the other line on a try that saves or an edit;
 *   the merge-by-cause rule covers both.
 */
const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
const deliver = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const store = await import('../../src/store/graphStore');
const { useGraphStore } = store;
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { TAB_ID } = await import('../../src/lib/tabId');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Shot = { id: string; prompt?: string };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sceneOf = (shots: Shot[]) => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots });
const editNode = (id: string, label: string) => ({ id, type: 'model-node', position: { x: 900, y: 0 },
  data: { label, definitionId: 'gpt-image-2-5-edit', params: {}, state: 'idle', outputs: {} } });
let said: string[] = [];
const AGENT = { edit: { id: 'ed_agent', actor: { kind: 'agent', name: 'Codex' } } };
const OWN = () => ({ edit: { id: `ed_own${Math.random()}`, actor: { kind: 'person', name: 'You' }, tab: TAB_ID } });
const QUIET = 80;
let revisionCounter = 50_000;

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a', canvas: 'c1' } as never);
  useGraphStore.getState().resetExecution();
  store.clearCinemaScenePersistence();
  store.setSceneRetryDelaysForTests([5]);
  store.setSceneQuietRetryForTests(QUIET);
  said = [];
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [], unsavedScenes: {}, sceneClashes: {},
    stoppedScenes: {}, sceneStops: {}, scenePopover: null, isExecuting: false, backendFreshStartPending: false, undoNotice: null,
    messageNotice: null, lateNotice: null, isImportingGraph: false, runHistory: [], providerRecoveries: [], providerStartAmbiguities: [],
    uncertainWorldLabsRunId: null, notify: (text: string) => { said.push(text); } } as never);
});
afterEach(() => { store.setSceneQuietRetryForTests(null); store.setSceneTryTimeoutForTests(null); });

type SceneState = { label: string; shots: Shot[]; rev: number; deleted: boolean; fail: number;
  refuse: { status: number; body: Record<string, unknown> }[] };
const START: Shot[] = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }];

/** The keyed backend (main.py + services/scene_keys.py, in small) for
 * several scenes, with the person's DELETE /api/graph/node and POST
 * /api/graph/restore. Each scene's saves can fail (500) or be refused. */
function backend(labels: Record<string, string>, others = [editNode('e1', 'Edit A')], at: Record<string, { x: number; y: number }> = {}) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [], edges: [] } as never);
  const scenes = new Map<string, SceneState>(Object.entries(labels).map(([id, label]) => [id,
    { label, shots: clone(START), rev: (revisionCounter += 1), deleted: false, fail: 0, refuse: [] }]));
  let extra = [...others];
  let order: string[] | null = null;
  const keyOf = (id: string) => JSON.stringify(scenes.get(id)!.shots.map((s) => [s.id, s.prompt]));
  const snapshot = () => {
    const ids = [...scenes.keys()];
    const live = [...scenes].filter(([, scene]) => !scene.deleted)
      .sort(([a], [b]) => (order ? order.indexOf(a) - order.indexOf(b) : 0));
    return {
      nodes: [...live.map(([id, scene]) => ({ id, type: 'cinemaSceneNode', position: at[id] ?? { x: ids.indexOf(id) * 300, y: 0 },
        data: { label: scene.label, definitionId: 'cinema-scene', params: { scene: sceneOf(clone(scene.shots)) }, state: 'idle', outputs: {} } })),
      ...extra],
      edges: [],
      sceneKeys: Object.fromEntries(live.map(([id]) => [id, keyOf(id)])),
      sceneRevs: Object.fromEntries(live.map(([id, scene]) => [id, scene.rev])),
    };
  };
  const emit = (origin: object = {}) => deliver({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...snapshot(), ...origin });
  const puts: { id: string; status: number }[] = [];
  let restoreGate: Promise<void> | null = null;
  let putGate: Promise<void> | null = null;
  emit();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const nodeId = /\/api\/graph\/node\/([^/?]+)/.exec(path)?.[1];
    if (init?.method === 'PUT' && nodeId && scenes.has(nodeId)) {
      const scene = scenes.get(nodeId)!;
      const body = JSON.parse(String(init.body));
      const entry = { id: nodeId, status: 200 };
      puts.push(entry);
      if (putGate) await putGate;
      if (scene.deleted) { entry.status = 404; return json({ detail: 'gone', code: 'node_gone', deletedBy: null }, 404); }
      const refusal = scene.refuse.shift();
      if (refusal) { entry.status = refusal.status; return json(refusal.body, refusal.status); }
      if (scene.fail > 0) { scene.fail -= 1; entry.status = 500; return json({ detail: 'boom' }, 500); }
      if (body.ifSceneKey && body.ifSceneKey !== keyOf(nodeId)) {
        entry.status = 409;
        return json({ detail: 'changed', code: 'scene_changed', scene: sceneOf(clone(scene.shots)), sceneKey: keyOf(nodeId),
          sceneRev: scene.rev, changedBy: { kind: 'agent', name: 'Codex' } }, 409);
      }
      scene.shots = clone(body.params.scene.shots);
      scene.rev = (revisionCounter += 1);
      const key = keyOf(nodeId);
      const rev = scene.rev;
      await sleep(2);
      emit(OWN());
      await sleep(2);
      return json({ id: nodeId, sceneKey: key, sceneRev: rev });
    }
    if (init?.method === 'DELETE' && nodeId) {
      if (scenes.has(nodeId)) scenes.get(nodeId)!.deleted = true;
      else extra = extra.filter((node) => node.id !== nodeId);
      emit(OWN());
      await sleep(2);
      return json({ ok: true });
    }
    if (init?.method === 'POST' && path.includes('/api/graph/restore')) {
      const body = JSON.parse(String(init.body));
      if (restoreGate) await restoreGate;
      for (const item of body.nodes as { id: string; params?: { scene?: { shots: Shot[] } } }[]) {
        const scene = scenes.get(item.id);
        if (scene) {
          scene.deleted = false;
          if (item.params?.scene?.shots) scene.shots = clone(item.params.scene.shots);
          scene.rev = (revisionCounter += 1);
        } else if (!extra.some((node) => node.id === item.id)) extra = [...extra, editNode(item.id, 'Edit A')];
      }
      for (const id of (body.remove ?? []) as string[]) {
        if (scenes.has(id)) scenes.get(id)!.deleted = true;
        else extra = extra.filter((node) => node.id !== id);
      }
      emit(OWN());
      await sleep(2);
      return json({ ok: true });
    }
    if (path.includes('/api/graph/export')) return json({ ...base, canvasRevision: 'c1', empty: false, ...snapshot() });
    return json({});
  });
  return {
    scenes, puts, emit,
    putsOf: (id: string) => puts.filter((put) => put.id === id),
    /** The order the backend lists the scenes in (positions stay). */
    listIn: (ids: string[]) => { order = ids; emit(); },
    fail: (id: string, count: number) => { scenes.get(id)!.fail = count; },
    refuse: (id: string, status: number) => {
      scenes.get(id)!.refuse.push({ status, body: status === 413 ? { detail: 'too big', limit: 'size' } : { detail: 'bad', code: 'bad_params' } });
    },
    /** Codex's write: committed, then its sync. */
    codex: (id: string, shots: Shot[]) => {
      const scene = scenes.get(id)!;
      scene.shots = clone(shots);
      scene.rev = (revisionCounter += 1);
      emit(AGENT);
    },
    /** Codex's write to the other node only. */
    codexElsewhere: () => { extra = [editNode('e1', 'Edit B')]; emit(AGENT); },
    brief: (id: string) => scenes.get(id)!.shots.map((s) => `${s.id}:${s.prompt}`),
    /** Another writer puts a deleted scene back, with `shots`. */
    restoreAs: (id: string, shots: Shot[], origin: object) => {
      const scene = scenes.get(id)!;
      scene.deleted = false;
      scene.shots = clone(shots);
      scene.rev = (revisionCounter += 1);
      emit(origin);
    },
    /** Scene saves wait for `release()`. */
    holdPuts: () => { let release = () => {}; putGate = new Promise((resolve) => { release = () => { putGate = null; resolve(); }; }); return release; },
    /** Restores wait for `release()`. */
    holdRestores: () => { let release = () => {}; restoreGate = new Promise((resolve) => { release = () => { restoreGate = null; resolve(); }; }); return release; },
  };
}

const typeIn = (nodeId: string, shotId: string, prompt: string) => useGraphStore.getState().updateScene(nodeId,
  (current: { shots: Shot[] }) => ({ ...current, shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, prompt } : shot)) }));
const stopped = () => useGraphStore.getState().stoppedScenes;
const unsaved = (id: string) => useGraphStore.getState().unsavedScenes[id] ?? null;
const stopLines = () => store.sceneStopLines(useGraphStore.getState()).map((line) => line.text);
const stopLineOf = (id: string) => store.sceneStopLines(useGraphStore.getState()).find((line) => line.nodeIds.includes(id)) ?? null;
const toast = () => (useGraphStore.getState() as unknown as { undoNotice: { text: string; offer?: string | null } | null }).undoNotice;




/** Every stop line the store shows from now on, update by update. */
function watchStopLines() {
  const seen: string[][] = [];
  const off = useGraphStore.subscribe((state) => {
    const now = store.sceneStopLines(state).map((line) => line.text);
    if (JSON.stringify(now) !== JSON.stringify(seen[seen.length - 1] ?? [])) seen.push(now);
  });
  return { seen, off };
}


const tries = () => useGraphStore.getState().sceneTries;
async function deleteAndWait(id: string) {
  useGraphStore.getState().deleteNode(id);
  await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
  await sleep(20);
}

const RUN = (names: string) => `Your changes to ${names} are kept. Nebula will save them when the run finishes.`;
const OTHER = (names: string) => `Nebula couldn’t save your changes to ${names}. Try again, or reload if it keeps happening.`;
const PAID = { status: 409, body: { detail: 'A paid run is starting.', code: 'paid_start' } };
const OTHER_422 = { status: 422, body: {} };
const refuseWith = (h: ReturnType<typeof backend>, id: string, refusal: { status: number; body: Record<string, unknown> }, times = 1) => {
  for (let i = 0; i < times; i += 1) h.scenes.get(id)!.refuse.push(clone(refusal));
};

describe('GM r32 answers 1 and 3: the run-lock line, a state line that is not a failure', () => {
  it('one scene: GM’s line in the state slot, no toast, no [Try again], not stopped; it clears when the run ends', async () => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', PAID, 3);
    const lines = watchStopLines();
    typeIn('n1', 's1', 'during the run');
    await vi.waitFor(() => expect(stopLines()).toEqual([RUN('“Opening”')]), { timeout: 3000, interval: 5 });
    expect(said).toEqual([]);
    expect(stopLineOf('n1')).toMatchObject({ key: 'run-lock', retry: false, trying: false });
    expect(stopped().n1).toBeUndefined();
    expect(unsaved('n1')).toBe(RUN('“Opening”'));
    // The run ends: the save goes, and the line and the mark go with it.
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    lines.off();
    expect(stopLines()).toEqual([]);
    expect(h.brief('n1')).toEqual(['s1:during the run', 's2:b']);
    expect(lines.seen).toEqual([[RUN('“Opening”')], []]);
    expect(said).toEqual([]);
  });

  it('merged by cause with the shared name list: two scenes in one line, from 4 a count', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    refuseWith(h, 'n1', PAID, 50);
    refuseWith(h, 'n2', PAID, 50);
    typeIn('n1', 's1', 'run a');
    typeIn('n2', 's1', 'run b');
    await vi.waitFor(() => expect(stopLines()).toEqual([RUN('“Opening” and “Ref scene”')]), { timeout: 3000, interval: 5 });
    expect(stopLineOf('n2')).toMatchObject({ nodeIds: ['n1', 'n2'], retry: false });
    expect(said).toEqual([]);
    const four = ['A', 'B', 'C', 'D'].map((label, i) => ({ id: `m${i}`, type: 'cinemaSceneNode', position: { x: i * 300, y: 0 },
      data: { label, definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } }));
    const state = { nodes: four, stoppedScenes: {}, sceneStops: Object.fromEntries(four.map((n) => [n.id, { cause: 'run-lock' }])),
      scenePopover: null } as never;
    expect(store.sceneStopLines(state).map((line) => line.text)).toEqual([RUN('4 scenes')]);
    expect(store.sceneStopLines({ ...(state as object), nodes: four.slice(0, 3) } as never).map((line) => line.text))
      .toEqual([RUN('“A”, “B” and “C”')]);
  });

  it('a clash on the scene asks instead: its run-lock line gives way to the prompt', async () => {
    const node = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
      data: { label: 'Opening', definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } };
    const state = { nodes: [node], stoppedScenes: {}, sceneStops: { n1: { cause: 'run-lock' } }, scenePopover: null };
    expect(store.sceneStopLines(state as never).map((line) => line.text)).toEqual([RUN('“Opening”')]);
    expect(store.sceneStopLines({ ...state, sceneClashes: { n1: { id: 1, line: 'x', agent: 'Codex' } } } as never)).toEqual([]);
  });
});

describe('GM r32 answers 2 and 3: the "other" line, a stop line with [Try again]', () => {
  it('a 422: GM’s line as it stood, in the state slot with [Try again]; no toast; stopped, nothing more sent', async () => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopLines()).toEqual([OTHER('“Opening”')]), { timeout: 3000, interval: 5 });
    expect(stopLineOf('n1')).toMatchObject({ retry: true, trying: false });
    expect(stopped().n1).toBe(true);
    expect(useGraphStore.getState().sceneStops.n1).toEqual({ cause: 'other', reason: 'Try again, or reload if it keeps happening.',
      line: OTHER('“Opening”') });
    expect(said).toEqual([]);
    expect(unsaved('n1')).toBe(OTHER('“Opening”'));
    const p0 = h.putsOf('n1').length;
    await sleep(300);
    expect(h.putsOf('n1').length).toBe(p0);
  });

  it('[Try again] is one try: refused again, stopped again with its line and one save; then a try that saves clears it', async () => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    refuseWith(h, 'n1', OTHER_422);
    const p0 = h.putsOf('n1').length;
    const lines = watchStopLines();
    useGraphStore.getState().retrySceneSave('n1');
    expect(stopLineOf('n1')?.trying).toBe(true);
    await vi.waitFor(() => expect(h.putsOf('n1').length).toBe(p0 + 1), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(tries().n1).toBeUndefined(), { timeout: 3000, interval: 5 });
    await sleep(300);
    expect(h.putsOf('n1').length).toBe(p0 + 1);
    expect(stopped().n1).toBe(true);
    expect(stopLines()).toEqual([OTHER('“Opening”')]);
    expect(lines.seen.every((now) => now.length === 1 && now[0] === OTHER('“Opening”'))).toBe(true);
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([]), { timeout: 3000, interval: 5 });
    lines.off();
    expect(unsaved('n1')).toBeNull();
    expect(stopped().n1).toBeUndefined();
    expect(h.brief('n1')).toEqual(['s1:mine', 's2:b']);
    expect(said).toEqual([]);
  });

  it('the person’s next change clears it (and saves)', async () => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    typeIn('n1', 's2', 'and more');
    expect(stopLines()).toEqual([]);
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([]);
    expect(h.brief('n1')).toEqual(['s1:mine', 's2:and more']);
  });

  it('merged by cause: the same reason in one line; a line of the backend’s own stays alone; with the other causes, in order', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale' });
    refuseWith(h, 'n1', OTHER_422);
    refuseWith(h, 'n2', OTHER_422);
    refuseWith(h, 'n3', { status: 409, body: { detail: 'Couldn’t save “Finale”. It’s locked by the review.' } });
    for (const id of ['n1', 'n2', 'n3']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(Object.keys(stopped()).sort()).toEqual(['n1', 'n2', 'n3']), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([OTHER('“Opening” and “Ref scene”'), 'Couldn’t save “Finale”. It’s locked by the review.']);
    expect(stopLineOf('n3')).toMatchObject({ nodeIds: ['n3'], retry: true });
    expect(said).toEqual([]);
  });

  it('a delete keeps the other stop: Undo sends one save, and still refused it is stopped again with its line', async () => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await deleteAndWait('n1');
    refuseWith(h, 'n1', OTHER_422, 5);
    const p0 = h.putsOf('n1').length;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await sleep(300);
    expect(h.putsOf('n1').length - p0).toBe(1);
    expect(stopLines()).toEqual([OTHER('“Opening”')]);
  });
});
