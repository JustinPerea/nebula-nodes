import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 21, on graphStore.fix20's keyed backend:
 * - Review 19 LOW-1 (GM r31): a delete keeps the stop in every state: a
 *   save still out (Undo, Redo, Undo while the restore's save is out), a
 *   [Try again] out, a stopped scene with a clash waiting. Undo then sends
 *   GM's one save, for every cause; answering the clash Undo asks again is
 *   that one try (GM r31 answer 1).
 * - Review 19 LOW-2 (GM r31): a try with no answer in 15 s counts as failed;
 *   a late success while the card still holds what it sent clears the stop
 *   and the mark at once; after the person's edit the stop stays; a late
 *   failure changes nothing.
 * - GM r31 answer 2: a run lock refusing the one try shows the run's own
 *   line and saves when the run ends; it is not a server stop.
 * - GM r31 answer 3: the row tolerance is a quarter of the smaller card.
 * - Review 19 NIT-1: a try cleared by the person's edit, and by a clash.
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

const SERVER = (names: string) => `Nebula couldn’t save your changes to ${names}. They’re kept, and Nebula will try again with your next change.`;
const CANT = (names: string) => `Nebula can’t save your changes to ${names}.`;
const TOO_BIG_ONE = (name: string) => `“${name}” is too big to save. Remove something from it, then try again.`;

type Cause = 'server' | 400 | 413;
/** The person's edit to `id`, stopped by `cause` (500s past the timed
 * retries, or a 400 or 413). */
async function stopBy(h: ReturnType<typeof backend>, id: string, cause: Cause, prompt = `mine ${id}`) {
  if (cause === 'server') h.fail(id, 1000); else h.refuse(id, cause);
  typeIn(id, 's1', prompt);
  await vi.waitFor(() => expect(stopped()[id]).toBe(true), { timeout: 3000, interval: 5 });
  await sleep(20);
}
const lineFor = (cause: Cause, name: string) => (cause === 'server' ? SERVER(`“${name}”`) : cause === 400 ? CANT(`“${name}”`) : TOO_BIG_ONE(name));


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
const clashOf = (id: string) => (useGraphStore.getState().sceneClashes as Record<string, { sending?: string }>)[id] ?? null;
const RUN_LINE = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will save them when the run finishes.';
const CAUSES: Cause[] = ['server', 400, 413];
/** Queue the refusal `cause` keeps giving (a server error keeps failing by itself). */
const stillFailing = (h: ReturnType<typeof backend>, id: string, cause: Cause) => { if (cause !== 'server') h.refuse(id, cause); };
/** The next PUT to `id` only waits for `release()`; the others go. */
function holdNextPut(id: string) {
  const impl = fetchMock.getMockImplementation()!;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let taken = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!taken && init?.method === 'PUT' && String(url).includes(`/api/graph/node/${id}`)) {
      taken = true;
      await gate;
    }
    return impl(url, init);
  });
  return () => release();
}
/** PUTs to `id` as they are sent (a held one counts at once). */
const putCalls = (id: string) => fetchMock.mock.calls.filter(([url, init]) => (init as RequestInit | undefined)?.method === 'PUT'
  && String(url).includes(`/api/graph/node/${id}`)).length;
async function deleteAndWait(id: string) {
  useGraphStore.getState().deleteNode(id);
  await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
  await sleep(20);
}
/** After an Undo: the saves it sent, once nothing more goes. */
async function settled(h: ReturnType<typeof backend>, id: string, from: number) {
  await vi.waitFor(() => expect(stopped()[id]).toBe(true), { timeout: 3000, interval: 5 });
  await sleep(300);
  return h.putsOf(id).length - from;
}

describe('review 19 LOW-1: a delete keeps the stop in every state; Undo sends GM’s one save', () => {
  it('A: Undo, Redo while the restore’s save is out, Undo again: one save, for every cause, back stopped with its line', async () => {
    for (const cause of CAUSES) {
      const h = backend({ n1: 'Opening' });
      await stopBy(h, 'n1', cause);
      await deleteAndWait('n1');
      stillFailing(h, 'n1', cause);
      const release = h.holdPuts();
      const p0 = h.putsOf('n1').length;
      useGraphStore.getState().undo();
      await vi.waitFor(() => expect(h.putsOf('n1').length).toBe(p0 + 1), { timeout: 3000, interval: 5 });
      useGraphStore.getState().redo();
      await vi.waitFor(() => expect(useGraphStore.getState().nodes.some((n) => n.id === 'n1')).toBe(false), { timeout: 3000, interval: 5 });
      release();
      await sleep(80);
      stillFailing(h, 'n1', cause);
      const p1 = h.putsOf('n1').length;
      const before = said.length;
      useGraphStore.getState().undo();
      expect(await settled(h, 'n1', p1), String(cause)).toBe(1);
      expect(stopLines(), String(cause)).toEqual([lineFor(cause, 'Opening')]);
      expect(said.slice(before).filter((line) => line.includes('trying again')), String(cause)).toEqual([]);
      useGraphStore.setState({ undoStack: [], redoStack: [] } as never);
    }
  });

  it('A2: a [Try again] out, the person deletes the scene, the try fails, Undo: one save, for every cause', async () => {
    for (const cause of CAUSES) {
      const h = backend({ n1: 'Opening' });
      await stopBy(h, 'n1', cause);
      stillFailing(h, 'n1', cause);
      const release = h.holdPuts();
      const p0 = h.putsOf('n1').length;
      useGraphStore.getState().retrySceneSave('n1');
      await vi.waitFor(() => expect(h.putsOf('n1').length).toBe(p0 + 1), { timeout: 3000, interval: 5 });
      useGraphStore.getState().deleteNode('n1');
      await sleep(60);
      release();
      await sleep(100);
      stillFailing(h, 'n1', cause);
      const p1 = h.putsOf('n1').length;
      const before = said.length;
      useGraphStore.getState().undo();
      expect(await settled(h, 'n1', p1), String(cause)).toBe(1);
      expect(stopLines(), String(cause)).toEqual([lineFor(cause, 'Opening')]);
      expect(said.slice(before).filter((line) => line.includes('trying again')), String(cause)).toEqual([]);
      useGraphStore.setState({ undoStack: [], redoStack: [] } as never);
    }
  });

  it('I: stopped with a clash waiting, deleted, Undo asks again; Keep mine is the one try, for every cause', async () => {
    for (const cause of CAUSES) {
      const h = backend({ n1: 'Opening' });
      await stopBy(h, 'n1', cause);
      h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }]);
      await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
      await deleteAndWait('n1');
      useGraphStore.getState().undo();
      await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
      await sleep(100);
      expect(h.putsOf('n1').length, String(cause)).toBeGreaterThan(0);
      stillFailing(h, 'n1', cause);
      const p1 = h.putsOf('n1').length;
      const before = said.length;
      useGraphStore.getState().resolveSceneClash('n1', 'mine');
      expect(await settled(h, 'n1', p1), String(cause)).toBe(1);
      expect(stopLines(), String(cause)).toEqual([lineFor(cause, 'Opening')]);
      expect(said.slice(before).filter((line) => line.includes('trying again')), String(cause)).toEqual([]);
      useGraphStore.setState({ undoStack: [], redoStack: [] } as never);
    }
  });
});

describe('review 19 LOW-2 (GM r31): a try with no answer in 15 s counts as failed', () => {
  it('the bound is 15 s; past it the scene is stopped again, the same line, [Try again] live; a press sends', async () => {
    expect(store.SCENE_TRY_TIMEOUT_MS).toBe(15_000);
    store.setSceneTryTimeoutForTests(120);
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    const release = holdNextPut('n1');
    const p0 = putCalls('n1');
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(putCalls('n1')).toBe(p0 + 1), { timeout: 3000, interval: 5 });
    expect(tries().n1).toBeTruthy();
    expect(stopLineOf('n1')?.trying).toBe(true);
    await sleep(60);
    expect(stopLineOf('n1')?.trying, 'still within the bound').toBe(true);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(tries().n1).toBeUndefined();
    expect(stopLineOf('n1')).toMatchObject({ text: SERVER('“Opening”'), trying: false });
    expect(unsaved('n1')).toBe(SERVER('“Opening”'));
    // The button is live: the next press sends one save.
    const p1 = putCalls('n1');
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(putCalls('n1')).toBe(p1 + 1), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    release();
    await sleep(100);
  });

  it('a late success while the card still holds what that try sent: the stop and the mark go at once', async () => {
    store.setSceneTryTimeoutForTests(80);
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    const release = holdNextPut('n1');
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(20);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    h.fail('n1', 0);
    const p0 = putCalls('n1');
    const lines = watchStopLines();
    release();
    await vi.waitFor(() => expect(stopped().n1).toBeUndefined(), { timeout: 3000, interval: 5 });
    expect(unsaved('n1')).toBeNull();
    expect(stopLines()).toEqual([]);
    await sleep(200);
    lines.off();
    expect(putCalls('n1') - p0, 'nothing more sent').toBe(0);
    expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:b']);
    // The line went with the answer and never came back.
    expect(lines.seen.slice(lines.seen.findIndex((now) => now.length === 0))).toEqual([[]]);
    expect(stopped().n1).toBeUndefined();
  });

  it('a late success after the person edited: the stop stays (their next change sends it)', async () => {
    store.setSceneTryTimeoutForTests(80);
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    const release = holdNextPut('n1');
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(20);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    typeIn('n1', 's2', 'edited after');
    await sleep(40);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await sleep(200);
    h.fail('n1', 0);
    const p0 = putCalls('n1');
    release();
    await sleep(300);
    expect(stopped().n1).toBe(true);
    expect(unsaved('n1')).toBe(SERVER('“Opening”'));
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    expect(putCalls('n1') - p0, 'nothing more sent by the late answer').toBe(0);
  });

  it('a late failure changes nothing: no store update, nothing said, nothing sent', async () => {
    store.setSceneTryTimeoutForTests(80);
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    const release = holdNextPut('n1');
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(20);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await sleep(50);
    const p0 = putCalls('n1');
    const before = said.length;
    const seen = { stops: [] as unknown[], marks: [] as unknown[], tries: [] as unknown[] };
    const off = useGraphStore.subscribe((state, prior) => {
      if (state.stoppedScenes !== prior.stoppedScenes) seen.stops.push(state.stoppedScenes);
      if (state.unsavedScenes !== prior.unsavedScenes) seen.marks.push(state.unsavedScenes);
      if (state.sceneTries !== prior.sceneTries) seen.tries.push(state.sceneTries);
    });
    release();
    await sleep(300);
    off();
    expect(seen).toEqual({ stops: [], marks: [], tries: [] });
    expect(said.length - before).toBe(0);
    expect(putCalls('n1') - p0).toBe(0);
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
  });
});

describe('GM r31 answer 2: a run lock refusing the one try', () => {
  it.each<['Undo’s save first' | '[Try again]', Cause]>([['Undo’s save first', 400], ['[Try again]', 'server'], ['[Try again]', 413]])(
    '%s (stopped by %s): the run’s own line, not a stop; it saves when the run ends', async (path, cause) => {
      const h = backend({ n1: 'Opening' });
      await stopBy(h, 'n1', cause);
      if (path === 'Undo’s save first') await deleteAndWait('n1');
      h.fail('n1', 0);
      h.scenes.get('n1')!.refuse.push({ status: 409, body: { detail: 'A paid run is starting.', code: 'paid_start' } });
      const before = said.length;
      const p0 = h.putsOf('n1').length;
      const release = h.holdPuts();
      if (path === 'Undo’s save first') useGraphStore.getState().undo(); else useGraphStore.getState().retrySceneSave('n1');
      await vi.waitFor(() => expect(h.putsOf('n1').length).toBe(p0 + 1), { timeout: 3000, interval: 5 });
      // The run goes on: the next sends are refused the same way.
      for (let i = 0; i < 3; i += 1) h.scenes.get('n1')!.refuse.push({ status: 409, body: { detail: 'A paid run is starting.', code: 'paid_start' } });
      release();
      await vi.waitFor(() => expect(said.slice(before)).toContain(RUN_LINE), { timeout: 3000, interval: 5 });
      expect(stopped().n1).toBeUndefined();
      expect(useGraphStore.getState().sceneStops.n1).toBeUndefined();
      expect(stopLines()).toEqual([]);
      expect(unsaved('n1')).toBe(RUN_LINE);
      expect(said.slice(before).filter((line) => line !== RUN_LINE)).toEqual([]);
      // The run ends: the save goes and lands.
      await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
      expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:b']);
      expect(stopped().n1).toBeUndefined();
    });
});

describe('GM r31 answer 3: the row tolerance is a quarter of the smaller card', () => {
  const measure = (heights: Record<string, number>, at: Record<string, { x: number; y: number }>) => useGraphStore.setState((s) => ({
    nodes: s.nodes.map((n) => (heights[n.id] ? { ...n, position: at[n.id], measured: { width: 280, height: heights[n.id] } } : n)) }));

  it('a mirrored pair reads the same either way round: past a quarter of the smaller card, the higher one first', async () => {
    const h = backend({ n1: 'Tall', n2: 'Short' });
    await stopBy(h, 'n1', 400);
    await stopBy(h, 'n2', 400);
    // 40 px apart; the smaller card is 120 px (tolerance 30), the higher card on the right.
    measure({ n1: 400, n2: 120 }, { n1: { x: 600, y: 0 }, n2: { x: 0, y: 40 } });
    expect(stopLines()).toEqual([CANT('“Tall” and “Short”')]);
    measure({ n1: 400, n2: 120 }, { n1: { x: 0, y: 40 }, n2: { x: 600, y: 0 } });
    expect(stopLines()).toEqual([CANT('“Short” and “Tall”')]);
  });

  it('within a quarter of the smaller card they are one row either way round: left to right', async () => {
    const h = backend({ n1: 'Tall', n2: 'Short' });
    await stopBy(h, 'n1', 400);
    await stopBy(h, 'n2', 400);
    measure({ n1: 400, n2: 120 }, { n1: { x: 600, y: 0 }, n2: { x: 0, y: 30 } });
    expect(stopLines()).toEqual([CANT('“Short” and “Tall”')]);
    measure({ n1: 400, n2: 120 }, { n1: { x: 0, y: 30 }, n2: { x: 600, y: 0 } });
    expect(stopLines()).toEqual([CANT('“Tall” and “Short”')]);
  });
});

describe('review 19 NIT-1: what ends a try', () => {
  it('the person’s own edit during a try: the try ends at once (the line is no longer held)', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    const release = h.holdPuts();
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(tries().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    typeIn('n1', 's2', 'edited during the try');
    expect(tries().n1).toBeUndefined();
    expect(stopLineOf('n1')?.trying ?? false).toBe(false);
    release();
    await sleep(200);
  });

  it('a clash during a try (Codex changed it while the try was out): the try ends as the prompt comes, never both', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    h.fail('n1', 0);
    const release = h.holdPuts();
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(tries().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    const both: unknown[] = [];
    const off = useGraphStore.subscribe((state) => { if (state.sceneClashes.n1 && 'n1' in state.sceneTries) both.push(state.sceneTries.n1); });
    h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }]);
    release();
    await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
    off();
    expect(both).toEqual([]);
    expect(tries().n1).toBeUndefined();
    expect(stopLineOf('n1')?.trying ?? false).toBe(false);
  });
});
