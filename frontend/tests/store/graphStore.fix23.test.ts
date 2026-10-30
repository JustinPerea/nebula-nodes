import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 23, on graphStore.fix22b's keyed backend:
 * - Review 21 LOW-1: the save after a run that is still the one try (GM r33
 *   answer 3) has the 15 s bound: hung, it goes back to stopped with its
 *   line and [Try again]; its late answer goes through GM r31's rule.
 * - Review 21 NIT-1: the run line gives way to a stop in one store update.
 * - GM r34 Q2: an "other" stop gets one quiet try when another writer
 *   changes the scene; then it waits for the person.
 * - GM r34 Q3: a reason the backend wrote stays one line per scene; only
 *   Nebula's own reason merges.
 * - GM r34: every state line (and the mark) reads the names live: a rename
 *   during a try, while stopped, and on a merged line.
 * - Review 21 NIT-5: the run line dropped by another refusal; "other"
 *   lines before the run line.
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
let revisionCounter = 90_000;

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

const SERVER = (names: string) => `Nebula couldn’t save your changes to ${names}. They’re kept, and Nebula will try again with your next change.`;

type Cause = 'server' | 400 | 413;
/** The person's edit to `id`, stopped by `cause` (500s past the timed
 * retries, or a 400 or 413). */
async function stopBy(h: ReturnType<typeof backend>, id: string, cause: Cause, prompt = `mine ${id}`) {
  if (cause === 'server') h.fail(id, 1000); else h.refuse(id, cause);
  typeIn(id, 's1', prompt);
  await vi.waitFor(() => expect(stopped()[id]).toBe(true), { timeout: 3000, interval: 5 });
  await sleep(20);
}


// GM r32 answer 1: the run's line is not a failure.
const RUN_LINE = 'Your changes to “Opening” are kept. Nebula will save them when the run finishes.';
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

type Outcome = 'ok' | 'fail';
/** The next `count` PUTs to `id` each wait for their own answer: 'ok' lets
 * the backend take it, 'fail' answers 500. */
function holdEachPut(h: ReturnType<typeof backend>, id: string, count: number) {
  const impl = fetchMock.getMockImplementation()!;
  const gates: ((outcome: Outcome) => void)[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (gates.length < count && init?.method === 'PUT' && String(url).includes(`/api/graph/node/${id}`)) {
      const outcome = await new Promise<Outcome>((resolve) => { gates.push(resolve); });
      if (outcome === 'fail') return json({ detail: 'boom' }, 500);
      h.fail(id, 0);
      return impl(url, init);
    }
    return impl(url, init);
  });
  return (index: number, outcome: Outcome) => gates[index](outcome);
}
const RUN_LOCK = { status: 409, body: { detail: 'A paid run is starting.', code: 'paid_start' } };

const OTHER_422 = { status: 422, body: {} };
const SHOT2 = { status: 422, body: { detail: 'Shot 2 has no model.' } };
const OTHER = (names: string) => `Nebula couldn’t save your changes to ${names}. Try again, or reload if it keeps happening.`;
const SHOT2_LINE = (name: string) => `Nebula couldn’t save your changes to “${name}”. Shot 2 has no model.`;
const refuseWith = (h: ReturnType<typeof backend>, id: string, refusal: { status: number; body: Record<string, unknown> }, times = 1) => {
  for (let i = 0; i < times; i += 1) h.scenes.get(id)!.refuse.push(clone(refusal));
};
/** Every stop line the store shows from now on, update by update, starting with what it shows now. */
function watchStopLines() {
  const seen: string[][] = [store.sceneStopLines(useGraphStore.getState()).map((line) => line.text)];
  const off = useGraphStore.subscribe((state) => {
    const now = store.sceneStopLines(state).map((line) => line.text);
    if (JSON.stringify(now) !== JSON.stringify(seen[seen.length - 1] ?? [])) seen.push(now);
  });
  return { seen, off };
}
const markLine = (id: string) => store.sceneMarkLine(useGraphStore.getState(), id);
/** Codex renames a scene (its sync carries the new label). */
async function rename(h: ReturnType<typeof backend>, id: string, label: string) {
  h.scenes.get(id)!.label = label;
  h.emit(AGENT);
  await vi.waitFor(() => expect(useGraphStore.getState().nodes.find((n) => n.id === id)?.data.label).toBe(label), { timeout: 3000, interval: 5 });
}
/** Stopped by a server error, then [Try again] refused by a run lock: the run's line shows; the save after the run is that one try. */
async function runLockedTry(h: ReturnType<typeof backend>) {
  await stopBy(h, 'n1', 'server');
  h.fail('n1', 0);
  refuseWith(h, 'n1', RUN_LOCK);
  store.setSceneRetryDelaysForTests([150]);
  useGraphStore.getState().retrySceneSave('n1');
  await vi.waitFor(() => expect(stopLines()).toEqual([RUN_LINE]), { timeout: 3000, interval: 5 });
}

describe('review 21 LOW-1: the save after a run, still the one try, has the 15 s bound', () => {
  it('it hangs: past the bound, back to stopped with its line and [Try again]; the run line gives way in one update', async () => {
    store.setSceneTryTimeoutForTests(120);
    const h = backend({ n1: 'Opening' });
    await runLockedTry(h);
    const answer = holdEachPut(h, 'n1', 1);
    const w = watchStopLines();
    const p0 = putCalls('n1');
    await vi.waitFor(() => expect(putCalls('n1')).toBe(p0 + 1), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    w.off();
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    expect(stopLineOf('n1')).toMatchObject({ retry: true, trying: false });
    expect(unsaved('n1')).toBe(SERVER('“Opening”'));
    expect(useGraphStore.getState().sceneStops.n1).toEqual({ cause: 'server' });
    expect(w.seen, JSON.stringify(w.seen)).toEqual([[RUN_LINE], [SERVER('“Opening”')]]);
    await sleep(300);
    expect(putCalls('n1') - p0, 'no timed retries').toBe(1);
    answer(0, 'fail');
    await sleep(100);
  });

  it.each<Outcome>(['ok', 'fail'])('its late answer (%s) goes through GM’s rule: a success with the values unchanged clears the stop; a failure changes nothing', async (outcome) => {
    store.setSceneTryTimeoutForTests(120);
    const h = backend({ n1: 'Opening' });
    await runLockedTry(h);
    const answer = holdEachPut(h, 'n1', 1);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    const p0 = putCalls('n1');
    const before = said.length;
    answer(0, outcome);
    await sleep(300);
    expect(stopped().n1).toBe(outcome === 'ok' ? undefined : true);
    expect(stopLines()).toEqual(outcome === 'ok' ? [] : [SERVER('“Opening”')]);
    expect(unsaved('n1')).toBe(outcome === 'ok' ? null : SERVER('“Opening”'));
    expect(said.slice(before)).toEqual([]);
    expect(putCalls('n1') - p0).toBe(0);
    if (outcome === 'ok') expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:b']);
  });
});

describe('review 21 NIT-1: the run line gives way to a stop in one store update', () => {
  it.each<[string, { status: number; body: Record<string, unknown> }, string]>([
    ['a 400', { status: 400, body: { detail: 'bad', code: 'bad_params' } }, 'Nebula can’t save your changes to “Opening”.'],
    ['"other"', OTHER_422, OTHER('“Opening”')],
  ])('the save after the run refused %s: the run line, then the stop line, never neither', async (_name, refusal, line) => {
    const h = backend({ n1: 'Opening' });
    await runLockedTry(h);
    refuseWith(h, 'n1', refusal);
    const w = watchStopLines();
    await vi.waitFor(() => expect(stopLines()).toEqual([line]), { timeout: 3000, interval: 5 });
    w.off();
    expect(w.seen).toEqual([[RUN_LINE], [line]]);
    expect(stopped().n1).toBe(true);
  });
});

describe('GM r34 Q2: an "other" stop gets one quiet try when the scene changes elsewhere', () => {
  it.each<'[Try again]' | 'an edit'>(['[Try again]', 'an edit'])('one quiet try, it fails, a second change sends nothing; then the person’s %s sends', async (how) => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopLines()).toEqual([OTHER('“Opening”')]), { timeout: 3000, interval: 5 });
    refuseWith(h, 'n1', OTHER_422);
    const p0 = putCalls('n1');
    const before = said.length;
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2' }]);
    await vi.waitFor(() => expect(putCalls('n1')).toBe(p0 + 1), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await sleep(QUIET + 200);
    expect(stopLines()).toEqual([OTHER('“Opening”')]);
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2 again' }]);
    await sleep(QUIET * 4);
    expect(putCalls('n1') - p0, 'no second quiet try').toBe(1);
    expect(stopped().n1).toBe(true);
    expect(said.slice(before)).toEqual([]);
    if (how === '[Try again]') useGraphStore.getState().retrySceneSave('n1'); else typeIn('n1', 's1', 'mine, again');
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.brief('n1')).toEqual([how === '[Try again]' ? 's1:mine' : 's1:mine, again', 's2:codex s2 again']);
    expect(stopLines()).toEqual([]);
  });

  it('after the person acts and it stops again, the next change elsewhere buys one quiet try again', async () => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    refuseWith(h, 'n1', OTHER_422, 2);
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2' }]);
    await vi.waitFor(() => expect(h.scenes.get('n1')!.refuse.length).toBe(1), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(h.scenes.get('n1')!.refuse.length).toBe(0), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    const p0 = putCalls('n1');
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2 later' }]);
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(putCalls('n1') - p0).toBe(1);
  });
});

describe('GM r34 Q3: a reason the backend wrote stays one line per scene; only Nebula’s own merges', () => {
  it('two scenes, the same backend reason: two lines, in reading order, each [Try again]', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    refuseWith(h, 'n1', SHOT2);
    refuseWith(h, 'n2', SHOT2);
    for (const id of ['n1', 'n2']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(Object.keys(stopped()).sort()).toEqual(['n1', 'n2']), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([SHOT2_LINE('Opening'), SHOT2_LINE('Ref scene')]);
    expect(stopLineOf('n1')).toMatchObject({ nodeIds: ['n1'], retry: true });
    expect(useGraphStore.getState().sceneStops.n1).toMatchObject({ cause: 'other', reason: 'Shot 2 has no model.', nebula: false });
  });

  it('two scenes refused with no detail (Nebula’s reason): one line', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    refuseWith(h, 'n1', OTHER_422);
    refuseWith(h, 'n2', OTHER_422);
    for (const id of ['n1', 'n2']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(Object.keys(stopped()).sort()).toEqual(['n1', 'n2']), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([OTHER('“Opening” and “Ref scene”')]);
  });
});

describe('GM r34: state lines read the names live', () => {
  it('a rename while stopped: the line and the mark say the new name at once', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    await rename(h, 'n1', 'Renamed');
    expect(stopLines()).toEqual([SERVER('“Renamed”')]);
    expect(markLine('n1')).toBe(SERVER('“Renamed”'));
  });

  it('a rename during a try (a reason the backend wrote): the new name at once, never the old one after it; refused again, still the new one', async () => {
    const h = backend({ n1: 'Opening' });
    refuseWith(h, 'n1', SHOT2);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    refuseWith(h, 'n1', SHOT2);
    const release = holdNextPut('n1');
    useGraphStore.getState().retrySceneSave('n1');
    expect(stopLineOf('n1')?.trying).toBe(true);
    // A flash: any store update where the card already says the new name and a line still the old one.
    const flashes: string[] = [];
    const offFlash = useGraphStore.subscribe((state) => {
      if (state.nodes.find((n) => n.id === 'n1')?.data.label !== 'Renamed') return;
      for (const line of store.sceneStopLines(state)) if (line.text.includes('“Opening”')) flashes.push(line.text);
      const mark = store.sceneMarkLine(state, 'n1');
      if (mark?.includes('“Opening”')) flashes.push(`mark: ${mark}`);
    });
    await rename(h, 'n1', 'Renamed');
    expect(stopLines()).toEqual([SHOT2_LINE('Renamed')]);
    expect(stopLineOf('n1')?.trying).toBe(true);
    expect(markLine('n1')).toBe(SHOT2_LINE('Renamed'));
    release();
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await sleep(50);
    offFlash();
    expect(stopLines()).toEqual([SHOT2_LINE('Renamed')]);
    expect(flashes).toEqual([]);
  });

  it('a rename on a merged line: the merged line names the new name', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    refuseWith(h, 'n1', OTHER_422);
    refuseWith(h, 'n2', OTHER_422);
    for (const id of ['n1', 'n2']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(stopLines()).toEqual([OTHER('“Opening” and “Ref scene”')]), { timeout: 3000, interval: 5 });
    await rename(h, 'n2', 'Finale');
    expect(stopLines()).toEqual([OTHER('“Opening” and “Finale”')]);
    expect(markLine('n2')).toBe(OTHER('“Finale”'));
  });
});

describe('review 21 NIT-5: the run line and other refusals', () => {
  // GM r36 Q1: the retries' line is a state, so it takes the run line's
  // place in the state slot (never a toast).
  it('an ordinary save the run held, refused another way after the run (a server error): the run line goes', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([150]);
    refuseWith(h, 'n1', RUN_LOCK);
    typeIn('n1', 's1', 'during the run');
    await vi.waitFor(() => expect(stopLines()).toEqual([RUN_LINE]), { timeout: 3000, interval: 5 });
    h.fail('n1', 1);
    const RETRYING = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula is trying again.';
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING]), { timeout: 3000, interval: 5 });
    expect(said.some((line) => line.includes('trying again'))).toBe(false);
    expect(useGraphStore.getState().sceneStops.n1).toEqual({ cause: 'retrying' });
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.brief('n1')).toEqual(['s1:during the run', 's2:b']);
  });

  it('"other" lines come before the run line, whatever the reading order', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    store.setSceneRetryDelaysForTests([150]);
    refuseWith(h, 'n1', RUN_LOCK, 40);
    refuseWith(h, 'n2', OTHER_422);
    for (const id of ['n1', 'n2']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(stopLines()).toEqual([OTHER('“Ref scene”'), RUN_LINE]), { timeout: 3000, interval: 5 });
    h.scenes.get('n1')!.refuse = [];
  });
});
