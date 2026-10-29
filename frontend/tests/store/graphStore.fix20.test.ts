import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 20 (GM r29), on graphStore.fix19's keyed backend:
 * - Call 3, save first: Undo brings a scene deleted while stopped back with
 *   its "Unsaved" mark and sends one save at once. Saved: no stop line ever
 *   shows. Failed (400, 413 or a server error): stopped again, its line
 *   and [Try again]. A stop line never shows and then clears itself.
 * - Call 2: while a [Try again] is on its way the line stays, its button
 *   disabled; a second press sends nothing.
 * - Call 7: reading order with a row tolerance: nodes nearly level read
 *   left to right.
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
const messageSlot = () => (useGraphStore.getState() as unknown as { messageNotice: { text: string } | null }).messageNotice;

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


/** Every stop line the store shows from now on, update by update. */
function watchStopLines() {
  const seen: string[][] = [];
  const off = useGraphStore.subscribe((state) => {
    const now = store.sceneStopLines(state).map((line) => line.text);
    if (JSON.stringify(now) !== JSON.stringify(seen[seen.length - 1] ?? [])) seen.push(now);
  });
  return { seen, off };
}

describe('GM r29 call 3: Undo of a stopped scene’s delete saves first', () => {
  it.each<Cause>(['server', 400, 413])('stopped by %s, saving works again: one save at once, it lands; no stop line in any store update', async (cause) => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', cause);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    h.fail('n1', 0);
    const puts = h.putsOf('n1').length;
    const marks: (string | null)[] = [unsaved('n1')];
    const markOff = useGraphStore.subscribe((state) => { const mark = state.unsavedScenes.n1 ?? null; if (marks[marks.length - 1] !== mark) marks.push(mark); });
    const lines = watchStopLines();
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(h.brief('n1')[0]).toBe('s1:mine n1'), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    await sleep(QUIET * 3);
    lines.off();
    markOff();
    expect(lines.seen).toEqual([]);
    // Back with its "Unsaved" mark (the line it had), which goes once saved.
    expect(marks).toEqual([null, lineFor(cause, 'Opening'), null]);
    expect(h.putsOf('n1').length).toBe(puts + 1);
    expect(stopped()).toEqual({});
    expect(store.hasUnsavedSceneEdits()).toBe(false);
  });

  it.each<Cause>(['server', 400, 413])('stopped by %s, still failing the same way: one save at once; back stopped with its line and [Try again]', async (cause) => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', cause);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    if (cause !== 'server') h.refuse('n1', cause);
    const puts = h.putsOf('n1').length;
    const lines = watchStopLines();
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    // The save went before any line: the line shows once, after its answer, and stays.
    await sleep(QUIET * 4);
    lines.off();
    expect(h.putsOf('n1').length).toBe(puts + 1);
    expect(lines.seen).toEqual([[lineFor(cause, 'Opening')]]);
    expect(unsaved('n1')).toBe(lineFor(cause, 'Opening'));
    expect(stopLineOf('n1')?.trying).toBe(false);
  });

  it('stopped by a 413, the save at once now refused 400: back stopped with the 400 line', async () => {
    const h = backend({ n1: 'Opening' });
    await stopBy(h, 'n1', 413);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    h.refuse('n1', 400);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([CANT('“Opening”')]);
  });
});

describe('GM r29 call 2: one [Try again] at a time', () => {
  it('while a try is on its way the line stays, its [Try again] marked as trying; a second press sends nothing', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    await stopBy(h, 'n1', 'server');
    await stopBy(h, 'n2', 'server');
    h.fail('n1', 0);
    const release = h.holdPuts();
    const puts1 = h.putsOf('n1').length;
    const lines = watchStopLines();
    for (const id of stopLineOf('n1')!.nodeIds) useGraphStore.getState().retrySceneSave(id);
    await vi.waitFor(() => expect(h.putsOf('n1').length).toBe(puts1 + 1), { timeout: 3000, interval: 5 });
    // Through the try: the same line, trying; no store update without it.
    expect(stopLineOf('n1')).toMatchObject({ text: SERVER('“Opening” and “Ref scene”'), trying: true });
    for (const id of ['n1', 'n2', 'n1']) useGraphStore.getState().retrySceneSave(id);
    await sleep(40);
    expect(h.putsOf('n1').length).toBe(puts1 + 1);
    release();
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    await sleep(40);
    lines.off();
    // Opening saved and left the line; Ref failed and stays, its button back.
    expect(stopLineOf('n2')).toMatchObject({ text: SERVER('“Ref scene”'), trying: false });
    expect(lines.seen.every((texts) => texts.length === 1)).toBe(true);
    expect(lines.seen.at(-1)).toEqual([SERVER('“Ref scene”')]);
    // Ref's own try: one save.
    const puts2 = h.putsOf('n2').length;
    useGraphStore.getState().retrySceneSave('n2');
    useGraphStore.getState().retrySceneSave('n2');
    await vi.waitFor(() => expect(stopLineOf('n2')?.trying).toBe(false), { timeout: 3000, interval: 5 });
    expect(h.putsOf('n2').length).toBe(puts2 + 1);
  });
});

describe('GM r29 call 7: reading order with a row tolerance', () => {
  it('nearly level (a few px apart, within a quarter of a card): left to right', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' }, undefined, { n1: { x: 0, y: 12 }, n2: { x: 400, y: 0 } });
    await stopBy(h, 'n1', 400);
    await stopBy(h, 'n2', 400);
    expect(stopLines()).toEqual([CANT('“Opening” and “Ref scene”')]);
  });

  it('a row lower than the tolerance reads after: top to bottom first, each row left to right', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale' }, undefined,
      { n1: { x: 0, y: 12 }, n2: { x: 400, y: 0 }, n3: { x: 0, y: 120 } });
    for (const id of ['n3', 'n2', 'n1']) await stopBy(h, id, 400);
    expect(stopLines()).toEqual([CANT('“Opening”, “Ref scene” and “Finale”')]);
  });

  it('the tolerance is a quarter of the row’s first card height (55 px unmeasured)', async () => {
    expect(store.READING_ROW_SHARE).toBe(0.25);
    const h = backend({ n1: 'Opening', n2: 'Ref scene', n3: 'Finale' }, undefined,
      { n1: { x: 0, y: 55 }, n2: { x: 400, y: 0 }, n3: { x: 200, y: 56 } });
    for (const id of ['n1', 'n2', 'n3']) await stopBy(h, id, 413);
    // n2 starts the row; n1 (55 px lower) is in it, n3 (56 px) is the next row.
    expect(stopLines()).toEqual([TOO_BIG('“Opening”, “Ref scene” and “Finale”')]);
  });
});

// Review 18 NIT-1, with GM r29 Q1's retrying line: when the save stops, the
// retry line it said ("…Nebula is trying again.") leaves the event slots, so
// it never sits under the stop line that contradicts it.
describe('review 18 NIT-1: the retrying line goes when the save stops', () => {
  const RETRYING = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula is trying again.';
  const events = () => [toast()?.text ?? null, messageSlot()?.text ?? null];

  it('the timed retries run out (stopSceneSave): the retrying line goes as the stop line comes', async () => {
    const h = backend({ n1: 'Opening' });
    useGraphStore.setState({ notify: realNotify } as never);
    store.setSceneRetryDelaysForTests([150, 150]);
    h.fail('n1', 1000);
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(events()).toContain(RETRYING), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    expect(events()).not.toContain(RETRYING);
  });

  it('a retry refused 400 (stopSceneForGood): the retrying line goes as the 400 line comes', async () => {
    const h = backend({ n1: 'Opening' });
    useGraphStore.setState({ notify: realNotify } as never);
    store.setSceneRetryDelaysForTests([200]);
    h.fail('n1', 1);
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(events()).toContain(RETRYING), { timeout: 3000, interval: 5 });
    h.refuse('n1', 400);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    expect(stopLines()).toEqual([CANT('“Opening”')]);
    expect(events()).not.toContain(RETRYING);
  });
});
