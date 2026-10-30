import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 22, on graphStore.fix21stops' keyed backend:
 * - Review 20 LOW-1: every one try let go past the 15 s bound is tracked;
 *   each late answer goes through GM r31's rule (a late success with that
 *   try's values unchanged clears the stop; a late failure changes nothing),
 *   for two tries in a row, in either order.
 * - GM r33 answer 1 (review 20 LOW-2): a clash answer's held prompt goes
 *   after 15 s; the answer stands and the save carries on as an ordinary
 *   save (its own stop line if it fails).
 * - GM r33 answer 3: a run-locked one try that still fails after the run
 *   is one try, then back to stopped with its line and [Try again].
 * - Review 20 NIT-1: nothing is sent before the answer to a clash Undo asks
 *   again; a run lock on a stopped scene's own quiet try; the 15 s bound on
 *   a clash answer's one try.
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
let revisionCounter = 70_000;

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


const tries = () => useGraphStore.getState().sceneTries;
const clashOf = (id: string) => (useGraphStore.getState().sceneClashes as Record<string, { sending?: string }>)[id] ?? null;
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
/** [Try again], held past the bound: stopped again, the try let go. */
async function tryPastBound(id: string) {
  const p = putCalls(id);
  useGraphStore.getState().retrySceneSave(id);
  await vi.waitFor(() => expect(putCalls(id)).toBe(p + 1), { timeout: 3000, interval: 5 });
  await vi.waitFor(() => { expect(stopped()[id]).toBe(true); expect(tries()[id]).toBeUndefined(); }, { timeout: 3000, interval: 5 });
}
const RUN_LOCK = { status: 409, body: { detail: 'A paid run is starting.', code: 'paid_start' } };

describe('review 20 LOW-1: two tries in a row past the 15 s bound; every late answer goes through GM’s rule', () => {
  it.each<[string, [number, Outcome], [number, Outcome]]>([
    ['the first try’s answer, then the second’s; both fail', [0, 'fail'], [1, 'fail']],
    ['the second try’s answer, then the first’s; both fail', [1, 'fail'], [0, 'fail']],
    ['the first try’s answer fails, then the second’s saves', [0, 'fail'], [1, 'ok']],
    ['the second try’s answer fails, then the first’s saves', [1, 'fail'], [0, 'ok']],
    ['the first try’s answer saves, then the second’s fails', [0, 'ok'], [1, 'fail']],
    ['the second try’s answer saves, then the first’s fails', [1, 'ok'], [0, 'fail']],
  ])('%s', async (_name, first, second) => {
    store.setSceneTryTimeoutForTests(80);
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    const answer = holdEachPut(h, 'n1', 2);
    await tryPastBound('n1');
    await tryPastBound('n1');
    const p0 = putCalls('n1');
    const before = said.length;
    answer(...first);
    await sleep(150);
    const firstSaved = first[1] === 'ok';
    expect(stopped().n1).toBe(firstSaved ? undefined : true);
    expect(stopLines()).toEqual(firstSaved ? [] : [SERVER('“Opening”')]);
    answer(...second);
    await sleep(300);
    const saved = firstSaved || second[1] === 'ok';
    expect(stopped().n1).toBe(saved ? undefined : true);
    expect(stopLines()).toEqual(saved ? [] : [SERVER('“Opening”')]);
    // A late failure changes nothing: no timed retries, nothing said, the mark keeps the stop's line.
    expect(unsaved('n1')).toBe(saved ? null : SERVER('“Opening”'));
    expect(said.slice(before)).toEqual([]);
    expect(putCalls('n1') - p0).toBe(0);
    expect(store.hasUnsavedSceneEdits()).toBe(!saved);
    if (saved) expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:b']);
  });

  it('after the person’s edit: the first try’s late success clears nothing while their edit’s save is out', async () => {
    store.setSceneTryTimeoutForTests(80);
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    const answer = holdEachPut(h, 'n1', 3);
    await tryPastBound('n1');
    await tryPastBound('n1');
    const p0 = putCalls('n1');
    const before = said.length;
    typeIn('n1', 's2', 'edited after');
    await vi.waitFor(() => expect(putCalls('n1')).toBe(p0 + 1), { timeout: 3000, interval: 5 });
    answer(0, 'ok');
    await sleep(150);
    expect(store.hasUnsavedSceneEdits(), 'the edit is still on its way').toBe(true);
    answer(1, 'fail');
    await sleep(150);
    expect(store.hasUnsavedSceneEdits()).toBe(true);
    expect(said.slice(before)).toEqual([]);
    answer(2, 'ok');
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
    expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:edited after']);
    expect(stopLines()).toEqual([]);
    expect(unsaved('n1')).toBeNull();
  });
});

/** The person types s1 while saves keep failing (not yet stopped); Codex changes s1: the prompt asks. */
async function clashNotStopped(h: ReturnType<typeof backend>) {
  store.setSceneRetryDelaysForTests([400]);
  h.fail('n1', 1000);
  typeIn('n1', 's1', 'mine');
  await vi.waitFor(() => expect(h.putsOf('n1').length).toBeGreaterThan(0), { timeout: 3000, interval: 5 });
  h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }]);
  await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
  expect(stopped().n1).toBeUndefined();
}

describe('GM r33 answer 1 (review 20 LOW-2): a clash answer’s held prompt waits 15 s at most', () => {
  it('past the bound the prompt goes; the answer stands and its save carries on; a late success saves it, nothing more shows', async () => {
    store.setSceneTryTimeoutForTests(120);
    const h = backend({ n1: 'Opening' });
    await clashNotStopped(h);
    const answer = holdEachPut(h, 'n1', 1);
    const p0 = putCalls('n1');
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    expect(clashOf('n1')?.sending).toBe('mine');
    await vi.waitFor(() => expect(putCalls('n1')).toBe(p0 + 1), { timeout: 3000, interval: 5 });
    await sleep(50);
    expect(clashOf('n1')?.sending, 'within the bound').toBe('mine');
    await vi.waitFor(() => expect(clashOf('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    // The answer stands: the card keeps the person's value, and the save is still out (no stop, no line).
    expect(stopLines()).toEqual([]);
    expect(stopped().n1).toBeUndefined();
    expect(store.hasUnsavedSceneEdits()).toBe(true);
    expect(putCalls('n1') - p0, 'nothing more sent').toBe(1);
    answer(0, 'ok');
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
    expect(h.brief('n1')).toEqual(['s1:mine', 's2:b']);
    expect(clashOf('n1')).toBeNull();
    expect(stopLines()).toEqual([]);
    expect(unsaved('n1')).toBeNull();
  });

  it.each<[string, Cause]>([['a server error', 'server'], ['a 400', 400]])(
    'past the bound, then a late failure (%s): an ordinary save’s failure, with its own stop line', async (_name, cause) => {
      store.setSceneTryTimeoutForTests(120);
      const h = backend({ n1: 'Opening' });
      await clashNotStopped(h);
      store.setSceneRetryDelaysForTests([5]);
      const answer = holdEachPut(h, 'n1', 1);
      useGraphStore.getState().resolveSceneClash('n1', 'mine');
      await vi.waitFor(() => expect(clashOf('n1')).toBeNull(), { timeout: 3000, interval: 5 });
      expect(stopLines()).toEqual([]);
      if (cause === 400) { h.fail('n1', 0); h.refuse('n1', 400); answer(0, 'ok'); } else answer(0, 'fail');
      await vi.waitFor(() => expect(stopLines()).toEqual([lineFor(cause, 'Opening')]), { timeout: 5000, interval: 5 });
      expect(stopped().n1).toBe(true);
      expect(clashOf('n1')).toBeNull();
      expect(store.sceneStopLines(useGraphStore.getState())[0]?.retry).toBe(true);
    });

  it('NIT-1: a clash answer’s one try out of a stop keeps its own bound: the prompt gives way to the stop line in one update', async () => {
    store.setSceneTryTimeoutForTests(120);
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }]);
    await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
    const release = holdNextPut('n1');
    const seen: { prompt: string | null; stops: string[] }[] = [];
    const off = useGraphStore.subscribe((state) => {
      const p = (state.sceneClashes as Record<string, { sending?: string }>).n1;
      const now = { prompt: p ? (p.sending ?? '-') : null, stops: store.sceneStopLines(state).map((line) => line.text) };
      if (JSON.stringify(now) !== JSON.stringify(seen[seen.length - 1])) seen.push(now);
    });
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(clashOf('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    off();
    expect(seen).toEqual([{ prompt: 'mine', stops: [] }, { prompt: null, stops: [SERVER('“Opening”')] }]);
    expect(stopped().n1).toBe(true);
    release();
    await sleep(100);
  });
});

describe('GM r33 answer 3: a run-locked one try that still fails after the run', () => {
  it.each<[string, Cause]>([['[Try again] (stopped by server), a server error after the run', 'server'],
    ['[Try again] (stopped by 400), a 400 after the run', 400]])('%s: one try, then back to stopped with its line and [Try again]', async (_name, cause) => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', cause);
    h.fail('n1', 0);
    for (let i = 0; i < 3; i += 1) h.scenes.get('n1')!.refuse.push(clone(RUN_LOCK));
    const before = said.length;
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([RUN_LINE]), { timeout: 3000, interval: 5 });
    expect(stopped().n1).toBeUndefined();
    // The run ends; the save still fails.
    if (cause === 'server') h.fail('n1', 1000); else h.refuse('n1', 400);
    await vi.waitFor(() => expect(h.scenes.get('n1')!.refuse.filter((r) => r.status === 409).length).toBe(0), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    const after = putCalls('n1');
    await sleep(300);
    expect(putCalls('n1') - after, 'no timed retries').toBe(0);
    expect(stopLines()).toEqual([lineFor(cause, 'Opening')]);
    expect(stopLineOf('n1')?.retry).toBe(true);
    expect(unsaved('n1')).toBe(lineFor(cause, 'Opening'));
    expect(said.slice(before).filter((line) => line.includes('trying again'))).toEqual([]);
    expect(useGraphStore.getState().sceneStops.n1?.cause).not.toBe('run-lock');
  });

  it('the run ends and the save lands: no line, the one-try mark gone (a later failure retries as usual)', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    h.fail('n1', 0);
    h.scenes.get('n1')!.refuse.push(clone(RUN_LOCK));
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([]);
    // An ordinary save now: a server error goes to the timed retries, not straight back to stopped.
    h.fail('n1', 2);
    const p0 = putCalls('n1');
    typeIn('n1', 's2', 'later');
    await vi.waitFor(() => expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:later']), { timeout: 3000, interval: 5 });
    expect(putCalls('n1') - p0).toBe(3);
    expect(stopped().n1).toBeUndefined();
  });
});

describe('review 20 NIT-1: untested branches', () => {
  it('GM r31 answer 1: when Undo asks a stopped scene’s clash again, nothing is sent before the answer; the answer sends one', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }]);
    await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
    await deleteAndWait('n1');
    const p0 = putCalls('n1');
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
    await sleep(300);
    expect(putCalls('n1') - p0, 'nothing sent before the answer').toBe(0);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await settled(h, 'n1', 0);
    expect(putCalls('n1') - p0, 'the answer is the one try').toBe(1);
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
  });

  it('a run lock on a stopped scene’s own quiet try: the stop goes, the run’s line shows; it saves when the run ends', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    h.fail('n1', 0);
    h.scenes.get('n1')!.refuse.push(clone(RUN_LOCK));
    const before = said.length;
    // Codex's change elsewhere in the scene is evidence saving works: the quiet try goes.
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2' }]);
    await vi.waitFor(() => expect(stopLines()).toEqual([RUN_LINE]), { timeout: 3000, interval: 5 });
    expect(stopped().n1).toBeUndefined();
    expect(useGraphStore.getState().sceneStops.n1).toEqual({ cause: 'run-lock' });
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:codex s2']);
    expect(stopLines()).toEqual([]);
    expect(said.slice(before)).toEqual([]);
  });
});
