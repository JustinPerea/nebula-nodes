import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 19 (review 17, GM r28), on a keyed backend in small
 * that holds several scenes:
 * - LOW-1: the person's own delete of a stopped scene leaves "Deleted the
 *   node." [Undo] as the only line; no stop line stays for it.
 * - LOW-2: another writer's change that makes a stopped scene match the
 *   person's values clears the stop, its line and the mark together.
 * - LOW-3 (GM r28 answer 1, option c): Undo brings a scene deleted while
 *   stopped back as it was: stopped, with its line and [Try again], for every
 *   cause. No new round of timed retries; the quiet try still goes on the
 *   next sign that saving works.
 * - GM r28 item 2: a stop line is a state in its own slot above the event
 *   slot, one line per cause, merging the scenes of the same cause (up to 3
 *   by name, then a count). Events can't push it out; a scene whose stop
 *   clears leaves its line; a merged [Try again] that fails for some keeps
 *   only those.
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
const realNotify = useGraphStore.getState().notify;
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
const WINDOW = { edit: { id: 'ed_window', actor: { kind: 'person', name: 'You' }, tab: 'tab-other' } };
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
afterEach(() => store.setSceneQuietRetryForTests(null));

type SceneState = { label: string; shots: Shot[]; rev: number; deleted: boolean; fail: number;
  refuse: { status: number; body: Record<string, unknown> }[] };
const START: Shot[] = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }];

/** The keyed backend (main.py + services/scene_keys.py, in small) for
 * several scenes, with the person's DELETE /api/graph/node and POST
 * /api/graph/restore. Each scene's saves can fail (500) or be refused. */
function backend(labels: Record<string, string>, others = [editNode('e1', 'Edit A')]) {
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
      nodes: [...live.map(([id, scene]) => ({ id, type: 'cinemaSceneNode', position: { x: ids.indexOf(id) * 300, y: 0 },
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
const messageSlot = () => (useGraphStore.getState() as unknown as { messageNotice: { text: string } | null }).messageNotice;
const sceneBrief = (id: string) => (((useGraphStore.getState().nodes.find((n: { id: string }) => n.id === id)?.data.params.scene) as { shots: Shot[] } | undefined)
  ?.shots ?? []).map((s) => `${s.id}:${s.prompt}`);

const SERVER = (names: string) => `Nebula couldn’t save your changes to ${names}. They’re kept, and Nebula will try again with your next change.`;
const CANT = (names: string) => `Nebula can’t save your changes to ${names}.`;
const TOO_BIG_ONE = (name: string) => `“${name}” is too big to save. Remove something from it, then try again.`;
const TOO_BIG = (names: string) => `${names} are too big to save. Remove something from them, then try again.`;

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

describe('GM r28 item 2: one line per cause, in the state slot', () => {
  it('two scenes stopped by the same cause share one line, naming both; [Try again] there retries both', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    await stopBy(h, 'n1', 'server');
    await stopBy(h, 'n2', 'server');
    expect(stopLines()).toEqual([SERVER('“Opening” and “Ref scene”')]);
    expect(stopLineOf('n1')!.nodeIds).toEqual(['n1', 'n2']);
    // Each mark keeps its own scene's line.
    expect(unsaved('n1')).toBe(SERVER('“Opening”'));
    expect(unsaved('n2')).toBe(SERVER('“Ref scene”'));
    expect(toast()).toBeNull();
    expect(messageSlot()).toBeNull();
    h.fail('n1', 0);
    h.fail('n2', 0);
    for (const id of stopLineOf('n1')!.nodeIds) useGraphStore.getState().retrySceneSave(id);
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([]);
    expect(h.brief('n1')[0]).toBe('s1:mine n1');
    expect(h.brief('n2')[0]).toBe('s1:mine n2');
  });

  it('400s and 413s merge the same way: GM’s plural lines', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale' });
    await stopBy(h, 'n1', 400);
    await stopBy(h, 'n2', 400);
    expect(stopLines()).toEqual([CANT('“Opening” and “Ref scene”')]);
    const k = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale' });
    await stopBy(k, 'n1', 413);
    await stopBy(k, 'n2', 413);
    await stopBy(k, 'n3', 413);
    expect(stopLines()).toEqual([TOO_BIG('“Opening”, “Ref scene” and “Finale”')]);
  });

  it('the line names its scenes in reading order on the canvas, whatever order the nodes are listed in', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    h.listIn(['n2', 'n1']);
    await sleep(20);
    const listed = useGraphStore.getState().nodes.map((node: { id: string }) => node.id);
    expect(listed.indexOf('n2')).toBeLessThan(listed.indexOf('n1'));
    await stopBy(h, 'n2', 400);
    await stopBy(h, 'n1', 400);
    expect(stopLines()).toEqual([CANT('“Opening” and “Ref scene”')]);
  });

  it('different causes give a line each, never merged: can’t save, still failing, too big', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale' });
    await stopBy(h, 'n1', 413);
    await stopBy(h, 'n2', 'server');
    await stopBy(h, 'n3', 400);
    expect(stopLines()).toEqual([CANT('“Finale”'), SERVER('“Ref scene”'), TOO_BIG_ONE('Opening')]);
  });

  it('from 4 scenes the line counts them', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale', n4: 'Coda' });
    for (const id of ['n1', 'n2', 'n3', 'n4']) await stopBy(h, id, 413);
    expect(stopLines()).toEqual([TOO_BIG('4 scenes')]);
    expect(stopLineOf('n4')!.nodeIds).toEqual(['n1', 'n2', 'n3', 'n4']);
    const k = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale', n4: 'Coda' });
    for (const id of ['n1', 'n2', 'n3', 'n4']) await stopBy(k, id, 400);
    expect(stopLines()).toEqual([CANT('4 scenes')]);
  });

  it('an event while stopped takes the event slot; the stop line stays above it, unchanged', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    await stopBy(h, 'n1', 'server');
    await stopBy(h, 'n2', 400);
    const before = stopLines();
    h.codexElsewhere();
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex changed the canvas.'), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual(before);
    // The person's own toast, and a written line beside it: the same.
    useGraphStore.getState().deleteNode('e1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual(before);
    expect(stopLines()).toEqual([CANT('“Ref scene”'), SERVER('“Opening”')]);
  });

  it('a merged [Try again] that fails for some scenes keeps only those in the line; no new timed retries', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale' });
    await stopBy(h, 'n1', 'server');
    await stopBy(h, 'n2', 'server');
    await stopBy(h, 'n3', 'server');
    expect(stopLines()).toEqual([SERVER('“Opening”, “Ref scene” and “Finale”')]);
    h.fail('n1', 0);
    h.fail('n3', 0);
    const putsOf2 = h.putsOf('n2').length;
    for (const id of stopLineOf('n1')!.nodeIds) useGraphStore.getState().retrySceneSave(id);
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(unsaved('n3')).toBeNull(), { timeout: 3000, interval: 5 });
    await sleep(60);
    expect(stopLines()).toEqual([SERVER('“Ref scene”')]);
    expect(stopped()).toEqual({ n2: true });
    // One try: the failure goes straight back to stopped.
    expect(h.putsOf('n2').length).toBe(putsOf2 + 1);
  });

  it('a scene whose stop clears leaves the line: it shrinks, then goes', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    await stopBy(h, 'n1', 413);
    await stopBy(h, 'n2', 413);
    expect(stopLines()).toEqual([TOO_BIG('“Opening” and “Ref scene”')]);
    // The person's next change to Opening fits, and saves.
    typeIn('n1', 's1', 'short');
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([TOO_BIG_ONE('Ref scene')]);
    typeIn('n2', 's1', 'short too');
    await vi.waitFor(() => expect(unsaved('n2')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([]);
  });
});

describe('review 17 LOW-1: the person’s own delete of a stopped scene', () => {
  it.each<Cause>(['server', 400, 413])('%s: "Deleted the node." [Undo] is the only line; no stop line stays', async (cause) => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', cause);
    expect(stopLines()).toEqual([lineFor(cause, 'Opening')]);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(toast()?.offer).toBe('undo');
    expect(messageSlot()).toBeNull();
    expect(stopLines()).toEqual([]);
    expect(stopped()).toEqual({});
  });

  it('with the stop line above another toast: the delete’s toast is the only line', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    await stopBy(h, 'n1', 'server');
    h.codexElsewhere();
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex changed the canvas.'), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(messageSlot()).toBeNull();
    expect(stopLines()).toEqual([]);
  });

  it('a scene still retrying, its retry line beside another toast: the delete takes that line too (the path another writer’s delete uses)', async () => {
    const h = backend({ n1: 'Opening' });
    useGraphStore.setState({ notify: realNotify } as never);
    store.setSceneRetryDelaysForTests([60_000]);
    // The save is out when Codex's toast comes; its failure says the retry line beside the toast.
    const release = h.holdPuts();
    h.fail('n1', 1);
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(h.putsOf('n1').length).toBe(1), { timeout: 3000, interval: 5 });
    h.codexElsewhere();
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex changed the canvas.'), { timeout: 3000, interval: 5 });
    release();
    const RETRYING = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula is trying again.';
    await vi.waitFor(() => expect(messageSlot()?.text).toBe(RETRYING), { timeout: 3000, interval: 5 });
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(messageSlot()).toBeNull();
    expect(stopLines()).toEqual([]);
  });

  it('a merged line loses only the deleted scene', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    await stopBy(h, 'n1', 400);
    await stopBy(h, 'n2', 400);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([CANT('“Ref scene”')]);
  });
});

// GM r29 call 3 (round 20) changed this describe: Undo saves first; only a
// save that still fails comes back stopped (graphStore.fix20 pins it closely).
describe('review 17 LOW-3 (GM r28 answer 1, r29 call 3): Undo saves first; still failing, the scene comes back stopped', () => {
  it.each<Cause>([400, 413])('%s again: one save at once, refused; back stopped with its line and [Try again]; nothing more until the person acts', async (cause) => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', cause);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    const puts = h.putsOf('n1').length;
    h.refuse('n1', cause);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(sceneBrief('n1')[0]).toBe('s1:mine n1'), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    expect(h.putsOf('n1').length).toBe(puts + 1);
    expect(stopLines()).toEqual([lineFor(cause, 'Opening')]);
    expect(unsaved('n1')).toBe(lineFor(cause, 'Opening'));
    expect(store.hasUnsavedSceneEdits()).toBe(true);
    // Codex writing elsewhere, time: nothing goes by itself.
    h.codexElsewhere();
    await sleep(QUIET * 4);
    expect(h.putsOf('n1').length).toBe(puts + 1);
    expect(stopLines()).toEqual([lineFor(cause, 'Opening')]);
    expect(h.brief('n1')[0]).toBe('s1:a');
    // [Try again] sends it.
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.brief('n1')[0]).toBe('s1:mine n1');
    expect(stopLines()).toEqual([]);
  });

  it('a server failure that goes on: one save at once, failed; back stopped; the cycle isn’t restarted', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    const puts = h.putsOf('n1').length;
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(sceneBrief('n1')[0]).toBe('s1:mine n1'), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    expect(unsaved('n1')).toBe(SERVER('“Opening”'));
    await sleep(QUIET * 5);
    expect(h.putsOf('n1').length).toBe(puts + 1);
    expect(stopped()).toEqual({ n1: true });
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
  });

  it('the server is back by then: the save goes at once and lands; no line', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    h.fail('n1', 0);
    const saidBefore = [...said];
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(h.brief('n1')[0]).toBe('s1:mine n1'), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    expect(stopped()).toEqual({});
    expect(stopLines()).toEqual([]);
    expect(said.slice(saidBefore.length).filter((line) => /save/i.test(line))).toEqual([]);
  });

  it('it comes back matching Nebula (another window restored it with the person’s value): no stop, no line, no mark', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 400);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    const puts = h.putsOf('n1').length;
    h.restoreAs('n1', [{ id: 's1', prompt: 'mine n1' }, { id: 's2', prompt: 'b' }], WINDOW);
    await vi.waitFor(() => expect(sceneBrief('n1')[0]).toBe('s1:mine n1'), { timeout: 3000, interval: 5 });
    await sleep(QUIET * 2);
    expect(stopped()).toEqual({});
    expect(stopLines()).toEqual([]);
    expect(unsaved('n1')).toBeNull();
    expect(store.hasUnsavedSceneEdits()).toBe(false);
    expect(h.putsOf('n1').length).toBe(puts);
  });

  it('the late "Restored the node." (its restore answered after the press) leaves the stop line in its slot', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 'server');
    useGraphStore.getState().deleteNode('e1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    const release = h.holdRestores();
    useGraphStore.getState().undo();
    await sleep(30);
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    release();
    await vi.waitFor(() => expect(toast()?.text).toBe('Restored the node.'), { timeout: 3000, interval: 5 });
    expect(toast()?.offer).toBe('redo');
    expect(messageSlot()).toBeNull();
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    expect(stopped()).toEqual({ n1: true });
  });
});

describe('review 17 LOW-2: another writer’s change that makes a stopped scene match the person’s values', () => {
  it.each<Cause>(['server', 400, 413])('%s: the stop, its line and the mark go together; nothing is said or sent', async (cause) => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    await stopBy(h, 'n1', cause);
    await stopBy(h, 'n2', cause);
    const puts = h.putsOf('n1').length;
    const saidBefore = [...said];
    h.codex('n1', [{ id: 's1', prompt: 'mine n1' }, { id: 's2', prompt: 'b' }]);
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    await sleep(QUIET * 2);
    expect(stopped()).toEqual({ n2: true });
    expect(stopLines()).toEqual([lineFor(cause, 'Ref scene')]);
    expect(h.putsOf('n1').length).toBe(puts);
    expect(said).toEqual(saidBefore);
  });
});
