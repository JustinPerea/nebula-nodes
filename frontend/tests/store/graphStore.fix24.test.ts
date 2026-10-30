import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 24, on graphStore.fix22b's keyed backend:
 * - Review 22 LOW-1 (GM r35): a one try with no answer past the bound, the
 *   save after a run too, goes back to the stop it came out of, with that
 *   stop's own line and rule: 400 and 413 wait, an "other" stop's quiet try
 *   stays as it was, a server stop gets its quiet try.
 * - Review 22 LOW-2: a stop put back with its scene (asked again, or Undo's
 *   save first) keeps its reason and its spent quiet try.
 * - Review 22 LOW-3: the "Unsaved" mark reads the name live while timed
 *   retries go.
 * - Review 22 NIT-1: a stopped scene's quiet try that a run holds: the stop
 *   line gives way to the run's in one update.
 * - GM r35 Q1 (review 22 NIT-2): a stop of another kind starts without the
 *   "other" stop's spent quiet try.
 * - Review 22 NIT-5: the resets of the spent quiet try, one by one.
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
let revisionCounter = 100_000;

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

const CANT = (name: string) => `Nebula can’t save your changes to “${name}”.`;
const TOO_BIG = (name: string) => `“${name}” is too big to save. Remove something from it, then try again.`;
const RETRYING = (name: string) => `Nebula couldn’t save your changes to “${name}”. They’re kept, and Nebula is trying again.`;
/** A line the backend wrote whole (it names the scene itself). */
const WHOLE = 'Couldn’t save “Opening”. It’s locked by the review.';
const WHOLE_422 = { status: 422, body: { detail: WHOLE } };
const clashOf = (id: string) => useGraphStore.getState().sceneClashes[id] ?? null;
type Kind = 'server' | 400 | 413 | 'other';
const LINE: Record<string, (name: string) => string> = {
  server: (name) => SERVER(`“${name}”`), 400: CANT, 413: TOO_BIG, other: (name) => OTHER(`“${name}”`),
};
/** The person's edit to n1, stopped by `kind`. */
async function stopN1(h: ReturnType<typeof backend>, kind: Kind) {
  if (kind === 'other') {
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await sleep(20);
  } else await stopBy(h, 'n1', kind);
}
/** Codex changes n1's second shot (the first as Nebula has it); how many saves go for n1 in the quiet window after it. */
async function codexSends(h: ReturnType<typeof backend>, prompt: string) {
  const p0 = putCalls('n1');
  h.codex('n1', [clone(h.scenes.get('n1')!.shots[0]), { id: 's2', prompt }]);
  await sleep(QUIET * 4);
  return putCalls('n1') - p0;
}

describe('review 22 LOW-1: a one try with no answer goes back to the stop it came out of', () => {
  it.each<Kind>([400, 413, 'other', 'server'])('stopped by %s; [Try again] held by a run; the save after it hangs: back with its own line, under its own rule', async (kind) => {
    store.setSceneTryTimeoutForTests(120);
    const h = backend({ n1: 'Opening' });
    await stopN1(h, kind);
    expect(stopLines()).toEqual([LINE[kind]('Opening')]);
    h.fail('n1', 0);
    refuseWith(h, 'n1', RUN_LOCK);
    store.setSceneRetryDelaysForTests([150]);
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([RUN_LINE]), { timeout: 3000, interval: 5 });
    const answer = holdEachPut(h, 'n1', 1);
    const w = watchStopLines();
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    w.off();
    expect(w.seen, JSON.stringify(w.seen)).toEqual([[RUN_LINE], [LINE[kind]('Opening')]]);
    expect(stopLineOf('n1')).toMatchObject({ retry: true, trying: false });
    expect(markLine('n1')).toBe(LINE[kind]('Opening'));
    expect(useGraphStore.getState().sceneStops.n1).toMatchObject({ cause: kind === 400 ? 'bad-save' : kind === 413 ? 'too-big' : kind });
    // The late answer fails: nothing changes.
    answer(0, 'fail');
    await sleep(100);
    expect(stopLines()).toEqual([LINE[kind]('Opening')]);
    // GM r34 Q2, r35: 400 and 413 wait for the person; the person pressed
    // [Try again], so an "other" stop has its one quiet try; a server stop
    // gets one on each change.
    expect(await codexSends(h, 'codex s2')).toBe(kind === 400 || kind === 413 ? 0 : 1);
  });

  it('an "other" stop whose quiet try a run held, spent: the save after the run hangs; back with its line, and the next change sends nothing', async () => {
    store.setSceneTryTimeoutForTests(120);
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    refuseWith(h, 'n1', OTHER_422);
    refuseWith(h, 'n2', OTHER_422);
    for (const id of ['n1', 'n2']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(Object.keys(stopped()).sort()).toEqual(['n1', 'n2']), { timeout: 3000, interval: 5 });
    refuseWith(h, 'n1', RUN_LOCK);
    store.setSceneRetryDelaysForTests([150]);
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2' }]);
    await vi.waitFor(() => expect(stopLines()).toEqual([OTHER('“Ref scene”'), RUN_LINE]), { timeout: 3000, interval: 5 });
    const answer = holdEachPut(h, 'n1', 1);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    // Its Nebula reason kept: one line with n2's again.
    expect(stopLines()).toEqual([OTHER('“Opening” and “Ref scene”')]);
    answer(0, 'fail');
    await sleep(100);
    expect(await codexSends(h, 'codex s2 again'), 'its one quiet try was spent').toBe(0);
    expect(stopped().n1).toBe(true);
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(stopped().n1).toBeUndefined(), { timeout: 3000, interval: 5 });
  });
});

describe('review 22 LOW-2: a stop put back with its scene keeps its reason and its quiet try', () => {
  it.each<[string, { status: number; body: Record<string, unknown> }, string[]]>([
    ['Nebula’s own reason (merged with another scene’s)', OTHER_422, [OTHER('“Opening” and “Ref scene”')]],
    ['a reason the backend wrote', SHOT2, [SHOT2_LINE('Opening'), SHOT2_LINE('Ref scene')]],
    ['a line the backend wrote whole (as written: one line per scene)', WHOLE_422, [WHOLE, WHOLE]],
  ])('asked again after Undo (%s); Keep mine’s save hangs past the bound: its own line, never an empty one', async (_name, refusal, lines) => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    refuseWith(h, 'n1', refusal);
    refuseWith(h, 'n2', refusal);
    for (const id of ['n1', 'n2']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(Object.keys(stopped()).sort()).toEqual(['n1', 'n2']), { timeout: 3000, interval: 5 });
    const before = useGraphStore.getState().sceneStops.n1;
    h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }]);
    await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
    useGraphStore.getState().deleteNode('n1');
    await sleep(300);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
    // The stop behind the prompt is the one it had, reason and all.
    expect(useGraphStore.getState().sceneStops.n1).toEqual(before);
    store.setSceneTryTimeoutForTests(120);
    const release = holdNextPut('n1');
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    await sleep(50);
    expect(useGraphStore.getState().sceneStops.n1).toEqual(before);
    expect(stopLines()).toEqual(lines);
    expect(stopLines().every(Boolean)).toBe(true);
    release();
    await sleep(50);
  });

  it('Undo’s save first hangs past the bound: back with its Nebula reason (one line with another scene’s), its quiet try still spent', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    refuseWith(h, 'n1', OTHER_422, 2);
    refuseWith(h, 'n2', OTHER_422);
    for (const id of ['n1', 'n2']) typeIn(id, 's1', `mine ${id}`);
    await vi.waitFor(() => expect(Object.keys(stopped()).sort()).toEqual(['n1', 'n2']), { timeout: 3000, interval: 5 });
    // Its one quiet try, spent.
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2' }]);
    await vi.waitFor(() => expect(h.scenes.get('n1')!.refuse.length).toBe(0), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    useGraphStore.getState().deleteNode('n1');
    await sleep(300);
    store.setSceneTryTimeoutForTests(120);
    const release = holdNextPut('n1');
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([OTHER('“Opening” and “Ref scene”')]);
    // Its late answer: refused the same way, which changes nothing.
    refuseWith(h, 'n1', OTHER_422);
    release();
    await vi.waitFor(() => expect(h.scenes.get('n1')!.refuse.length).toBe(0), { timeout: 3000, interval: 5 });
    await sleep(50);
    expect(stopped().n1).toBe(true);
    expect(await codexSends(h, 'codex s2 later'), 'a delete and Undo buys no quiet try').toBe(0);
    expect(stopped().n1).toBe(true);
  });
});

describe('review 22 LOW-3: the mark reads the name live while timed retries go', () => {
  it('a rename during the retries: the mark says the new name at once, never the old one after it', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([60_000]);
    h.fail('n1', 1000);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(unsaved('n1')).toBe(RETRYING('Opening')), { timeout: 3000, interval: 5 });
    expect(markLine('n1')).toBe(RETRYING('Opening'));
    const stale: string[] = [];
    const off = useGraphStore.subscribe((state) => {
      const label = state.nodes.find((n) => n.id === 'n1')?.data.label;
      const mark = store.sceneMarkLine(state, 'n1');
      if (label === 'Opening IV' && mark !== RETRYING('Opening IV')) stale.push(String(mark));
    });
    await rename(h, 'n1', 'Opening IV');
    off();
    expect(stale).toEqual([]);
    expect(markLine('n1')).toBe(RETRYING('Opening IV'));
    expect(stopped().n1).toBeUndefined();
  });

  it('once the retries stop, or the save lands, the mark is that state’s', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([5]);
    h.fail('n1', 1000);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(useGraphStore.getState().sceneStops.n1?.cause).not.toBe('retrying');
    await rename(h, 'n1', 'Opening V');
    expect(markLine('n1')).toBe(SERVER('“Opening V”'));
    h.fail('n1', 0);
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(markLine('n1')).toBeNull();
    expect(useGraphStore.getState().sceneStops).toEqual({});
  });
});

describe('review 22 NIT-1: a stopped scene’s quiet try that a run holds', () => {
  it('the stop line gives way to the run’s in one update', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    h.fail('n1', 0);
    refuseWith(h, 'n1', RUN_LOCK);
    store.setSceneRetryDelaysForTests([60_000]);
    const w = watchStopLines();
    h.codex('n1', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2' }]);
    await vi.waitFor(() => expect(stopLines()).toEqual([RUN_LINE]), { timeout: 3000, interval: 5 });
    await sleep(20);
    w.off();
    expect(w.seen, JSON.stringify(w.seen)).toEqual([[SERVER('“Opening”')], [RUN_LINE]]);
  });
});

describe('GM r35 Q1: a stop of another kind starts without the spent quiet try', () => {
  it('other, its quiet try, a 500 (the server line), a change sends a quiet try, refused 400: it waits', async () => {
    const h = backend({ n1: 'Opening' });
    await stopN1(h, 'other');
    h.fail('n1', 1);
    expect(await codexSends(h, 'codex 1')).toBe(1);
    await vi.waitFor(() => expect(stopLines()).toEqual([SERVER('“Opening”')]), { timeout: 3000, interval: 5 });
    expect(stopped().n1).toBe(true);
    h.refuse('n1', 400);
    expect(await codexSends(h, 'codex 2'), 'the server line promises a try with the next change').toBe(1);
    await vi.waitFor(() => expect(stopLines()).toEqual([CANT('Opening')]), { timeout: 3000, interval: 5 });
    expect(await codexSends(h, 'codex 3'), 'a 400 waits for the person').toBe(0);
    expect(stopped().n1).toBe(true);
  });
});

describe('review 22 NIT-5: each reset of the spent quiet try', () => {
  /** An "other" stop whose one quiet try was spent (refused the same way). */
  async function spent(h: ReturnType<typeof backend>) {
    await stopN1(h, 'other');
    refuseWith(h, 'n1', OTHER_422);
    expect(await codexSends(h, 'codex 1')).toBe(1);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(await codexSends(h, 'codex 2')).toBe(0);
  }

  it('the person’s edit, refused the same way again: the next change elsewhere buys one quiet try', async () => {
    const h = backend({ n1: 'Opening' });
    await spent(h);
    refuseWith(h, 'n1', OTHER_422);
    typeIn('n1', 's1', 'mine, again');
    await vi.waitFor(() => expect(h.scenes.get('n1')!.refuse.length).toBe(0), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(await codexSends(h, 'codex 3')).toBe(1);
  });

  it('a clash answer, refused the same way again: the next change elsewhere buys one quiet try', async () => {
    const h = backend({ n1: 'Opening' });
    await spent(h);
    h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'codex 2' }]);
    await vi.waitFor(() => expect(clashOf('n1')).toBeTruthy(), { timeout: 3000, interval: 5 });
    refuseWith(h, 'n1', OTHER_422);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(h.scenes.get('n1')!.refuse.length).toBe(0), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(await codexSends(h, 'codex 3')).toBe(1);
  });
});

describe('review 22 LOW-2: a stop line is never empty', () => {
  it('an "other" stop with no line kept says Nebula’s own', () => {
    const nodes = [{ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
      data: { label: 'Opening', definitionId: 'cinema-scene', params: {}, state: 'idle', outputs: {} } }];
    const state = { nodes, stoppedScenes: { n1: true }, sceneStops: { n1: { cause: 'other', reason: null, nebula: false, line: '' } },
      scenePopover: null } as never;
    expect(store.sceneStopLines(state).map((line) => line.text)).toEqual([OTHER('“Opening”')]);
  });
});
