import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 GM r36 Q1, on graphStore.fix20's keyed backend: the timed retries'
 * line ("Nebula couldn’t save your changes to “Opening”. They’re kept, and
 * Nebula is trying again.") is a state, not an event. It sits in the state
 * slot, in the scene's stop line's place while the retries run: no ×, no
 * timer, no toast. It reads the scene's name now and merges like the other
 * Nebula-written state lines. Each change of the slot is one store update.
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

const SERVER = (names: string) => `Nebula couldn’t save your changes to ${names}. They’re kept, and Nebula will try again with your next change.`;
const CANT = (names: string) => `Nebula can’t save your changes to ${names}.`;

type Cause = 'server' | 400 | 413;
/** The person's edit to `id`, stopped by `cause` (500s past the timed
 * retries, or a 400 or 413). */
async function stopBy(h: ReturnType<typeof backend>, id: string, cause: Cause, prompt = `mine ${id}`) {
  if (cause === 'server') h.fail(id, 1000); else h.refuse(id, cause);
  typeIn(id, 's1', prompt);
  await vi.waitFor(() => expect(stopped()[id]).toBe(true), { timeout: 3000, interval: 5 });
  await sleep(20);
}


const RETRYING = (names: string) => `Nebula couldn’t save your changes to ${names}. They’re kept, and Nebula is trying again.`;
/** Each store update's state lines, in order (repeats collapsed), and every toast that showed. */
function watch() {
  const seen: string[][] = [stopLines()];
  const toasts: string[] = [];
  const off = useGraphStore.subscribe((state) => {
    const now = stopLines();
    if (JSON.stringify(now) !== JSON.stringify(seen[seen.length - 1])) seen.push(now);
    const st = state as unknown as { undoNotice: { text: string } | null; messageNotice: { text: string } | null };
    for (const text of [st.undoNotice?.text, st.messageNotice?.text]) if (text && !toasts.includes(text)) toasts.push(text);
  });
  return { seen, toasts, off };
}

describe('GM r36 Q1: the retrying line is a state, in the state slot', () => {
  it('a server error: the retrying line in the state slot, no [Try again], no toast; it clears in one update when the retry saves', async () => {
    const h = backend({ n1: 'Opening' });
    useGraphStore.setState({ notify: realNotify } as never);
    store.setSceneRetryDelaysForTests([120]);
    h.fail('n1', 1);
    const w = watch();
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 3000, interval: 5 });
    expect(stopLineOf('n1')?.retry).toBe(false);
    expect(stopped().n1).toBeUndefined();
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    w.off();
    expect(w.seen).toEqual([[], [RETRYING('“Opening”')], []]);
    expect(w.toasts).toEqual([]);
    expect(said).toEqual([]);
    expect(h.brief('n1')).toEqual(['s1:mine n1', 's2:b']);
  });

  it('stop → retrying → stop: the person’s next change after a stop retries in the stop’s place, and runs out back to the stop, each in one update', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([60]);
    await stopBy(h, 'n1', 'server');
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    h.fail('n1', 1000);
    const w = watch();
    typeIn('n1', 's2', 'next change');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 5000, interval: 5 });
    w.off();
    expect(stopLines()).toEqual([SERVER('“Opening”')]);
    // Never a frame with neither line.
    expect(w.seen.filter((lines) => lines.length === 0)).toEqual([]);
    expect(w.seen.map((lines) => lines[0])).toEqual([SERVER('“Opening”'), RETRYING('“Opening”'), SERVER('“Opening”')]);
    expect(w.toasts).toEqual([]);
  });

  it('retrying → 400: the 400 stop takes the retrying line’s place in one update', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([150]);
    h.fail('n1', 1);
    const w = watch();
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 3000, interval: 5 });
    h.refuse('n1', 400);
    await vi.waitFor(() => expect(stopped().n1).toBe(true), { timeout: 3000, interval: 5 });
    w.off();
    expect(w.seen).toEqual([[], [RETRYING('“Opening”')], [CANT('“Opening”')]]);
  });

  it('a rename while it retries: the line says the new name at once (and the mark too)', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([60_000]);
    h.fail('n1', 1);
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 3000, interval: 5 });
    useGraphStore.getState().renameNode('n1', 'Opening IV');
    expect(stopLines()).toEqual([RETRYING('“Opening IV”')]);
    expect(store.sceneMarkLine(useGraphStore.getState(), 'n1')).toBe(RETRYING('“Opening IV”'));
  });

  it('two scenes retrying share one line, by name in reading order', async () => {
    const h = backend({ n1: 'Opening', n2: 'Ref scene' });
    store.setSceneRetryDelaysForTests([60_000]);
    h.fail('n1', 1);
    h.fail('n2', 1);
    typeIn('n1', 's1', 'mine n1');
    typeIn('n2', 's1', 'mine n2');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening” and “Ref scene”')]), { timeout: 3000, interval: 5 });
    expect(said).toEqual([]);
  });

  it('a clash while it retries: the prompt takes its place in the same update; nothing retries meanwhile', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([60_000]);
    h.fail('n1', 1000);
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 3000, interval: 5 });
    const frames: Array<{ lines: number; clash: boolean }> = [];
    const off = useGraphStore.subscribe((state) => frames.push({ lines: stopLines().length, clash: 'n1' in state.sceneClashes }));
    h.codex('n1', [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }]);
    await vi.waitFor(() => expect(useGraphStore.getState().sceneClashes.n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    off();
    expect(stopLines()).toEqual([]);
    expect(useGraphStore.getState().sceneStops.n1).toBeUndefined();
    expect(frames.every((frame) => frame.lines > 0 || frame.clash)).toBe(true);
  });

  it('the scene leaves the canvas: its retrying line goes with it', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([60_000]);
    h.fail('n1', 1);
    typeIn('n1', 's1', 'mine n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 3000, interval: 5 });
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(stopLines()).toEqual([]), { timeout: 3000, interval: 5 });
  });
});
