import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 round 25 (review 23 LOW-1, GM r38): Codex's change to the field
 * the person's save carried arrives while that save is out, and the save
 * fails (500, 400, 413 or "other"). The clash is asked as soon as the failed
 * answer comes back, with the same prompt, in the scene's stop line's
 * place; never a card that shows a value Nebula doesn't have with no hint.
 * A change to another field merges as before (the next save's key check).
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

const clashOf = (id: string) => useGraphStore.getState().sceneClashes[id] ?? null;
const shotOf = (id: string, shot: string) => ((useGraphStore.getState().nodes.find((n) => n.id === id)?.data.params as { scene: { shots: Shot[] } })
  .scene.shots.find((s) => s.id === shot)?.prompt);
const CLASH = 'Codex changed “Opening” while you were editing it.';
/** Every clash prompt the scene showed, in order (one entry per time it appeared). */
function watchClashes(id: string) {
  const shown: string[] = [];
  let was: string | null = null;
  const off = useGraphStore.subscribe((state) => {
    const now = (state.sceneClashes[id] as { line?: string } | undefined)?.line ?? null;
    if (now && now !== was) shown.push(now);
    was = now;
  });
  return { shown, off };
}
const CODEX_S1 = [{ id: 's1', prompt: 'codex s1' }, { id: 's2', prompt: 'b' }];
const CODEX_S2 = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'codex s2' }];

describe('GM r38 (review 23 LOW-1): a save that fails asks the clash at once when Codex changed the same field meanwhile', () => {
  const causes: [string, (h: ReturnType<typeof backend>) => void][] = [
    ['500', (h) => h.fail('n1', 1000)],
    ['400', (h) => h.refuse('n1', 400)],
    ['413', (h) => h.refuse('n1', 413)],
    ['other (422)', (h) => h.scenes.get('n1')!.refuse.push({ status: 422, body: { detail: 'Nope.', code: 'something_else' } })],
  ];
  for (const [name, failWith] of causes) {
    it(`${name}: the prompt comes with the failed answer, in one update, with no line before it; nothing is sent while it asks`, async () => {
      const h = backend({ n1: 'Opening' });
      store.setSceneRetryDelaysForTests([5]);
      failWith(h);
      const release = h.holdPuts();
      typeIn('n1', 's1', 'mine');
      await vi.waitFor(() => expect(h.putsOf('n1')).toHaveLength(1), { timeout: 2000, interval: 2 });
      // Codex writes s1 while the person's save is out: its sync comes first.
      h.codex('n1', CODEX_S1);
      await sleep(20);
      expect(clashOf('n1')).toBeNull();
      const w = watch();
      const c = watchClashes('n1');
      release();
      await vi.waitFor(() => expect(clashOf('n1')).not.toBeNull(), { timeout: 1000, interval: 2 });
      await sleep(200);
      w.off(); c.off();
      expect(c.shown).toEqual([CLASH]);
      // The prompt is the scene's only line: no retrying or stop line came first or stays.
      expect(w.seen).toEqual([[]]);
      expect(w.toasts.filter((t) => /couldn’t save|can’t save|too big|trying again/i.test(t))).toEqual([]);
      expect(shotOf('n1', 's1')).toBe('mine');
      expect(h.brief('n1')).toEqual(['s1:codex s1', 's2:b']);
      expect(h.putsOf('n1')).toHaveLength(1);
      expect(unsaved('n1')).toBe(CLASH);
    });
  }

  it('500: Keep mine saves the person’s value (the clash wins), the prompt shown once, never asked again', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([5]);
    h.fail('n1', 1);
    const release = h.holdPuts();
    const c = watchClashes('n1');
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(h.putsOf('n1')).toHaveLength(1), { timeout: 2000, interval: 2 });
    h.codex('n1', CODEX_S1);
    await sleep(20);
    release();
    await vi.waitFor(() => expect(clashOf('n1')).not.toBeNull(), { timeout: 1000, interval: 2 });
    await sleep(100);
    expect(h.putsOf('n1')).toHaveLength(1);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(h.brief('n1')).toEqual(['s1:mine', 's2:b']), { timeout: 2000, interval: 5 });
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 2000, interval: 5 });
    await sleep(100);
    c.off();
    expect(c.shown).toEqual([CLASH]);
    expect(clashOf('n1')).toBeNull();
    expect(stopLines()).toEqual([]);
    expect(stopped().n1).toBeFalsy();
  });

  it('500, then the retry saves after Codex’s same-field sync came while the retry was out: one prompt, from the retry’s answer', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([40]);
    h.fail('n1', 1);
    const c = watchClashes('n1');
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopLineOf('n1')?.text).toBe(RETRYING('“Opening”')), { timeout: 2000, interval: 2 });
    const release = h.holdPuts();
    await vi.waitFor(() => expect(h.putsOf('n1')).toHaveLength(2), { timeout: 2000, interval: 2 });
    h.codex('n1', CODEX_S1);
    await sleep(20);
    release();
    await vi.waitFor(() => expect(clashOf('n1')).not.toBeNull(), { timeout: 2000, interval: 2 });
    await sleep(200);
    c.off();
    expect(c.shown).toEqual([CLASH]);
    expect(stopLines()).toEqual([]);
    expect(shotOf('n1', 's1')).toBe('mine');
  });

  // A save the backend answers moved, replaced or params-outdated has its
  // own path (the project moved, the canvas was cleared, the save is
  // re-read): no clash is asked over it, whatever waited.
  for (const [code, name] of [['workspace_moved', 'moved'], ['canvas_replaced', 'replaced'], ['params_outdated', 'params-outdated']] as const) {
    it(`a save answered ${name} while Codex's change to the same field waits asks no clash`, async () => {
      const h = backend({ n1: 'Opening' });
      store.setSceneRetryDelaysForTests([60_000]);
      h.scenes.get('n1')!.refuse.push({ status: 409, body: { detail: 'No.', code, project: { id: 'B', name: 'Other' }, switchedBy: null } });
      const release = h.holdPuts();
      const c = watchClashes('n1');
      typeIn('n1', 's1', 'mine');
      await vi.waitFor(() => expect(h.putsOf('n1')).toHaveLength(1), { timeout: 2000, interval: 2 });
      h.codex('n1', CODEX_S1);
      await sleep(20);
      release();
      await vi.waitFor(() => expect(h.putsOf('n1')[0].status).toBe(409), { timeout: 2000, interval: 2 });
      await sleep(150);
      c.off();
      expect(c.shown).toEqual([]);
      expect(clashOf('n1')).toBeNull();
    });
  }

  it('a change to another field merges as before: no prompt; the next save takes both', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([30]);
    h.fail('n1', 1);
    const release = h.holdPuts();
    const c = watchClashes('n1');
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(h.putsOf('n1')).toHaveLength(1), { timeout: 2000, interval: 2 });
    h.codex('n1', CODEX_S2);
    await sleep(20);
    release();
    await vi.waitFor(() => expect(stopLineOf('n1')?.text).toBe(RETRYING('“Opening”')), { timeout: 1000, interval: 2 });
    expect(clashOf('n1')).toBeNull();
    // As before round 25: the failed answer doesn't take Codex's other field
    // in by itself (the card keeps what it showed, nothing more is sent);
    // the next save's key check brings it in.
    expect([shotOf('n1', 's1'), shotOf('n1', 's2'), h.putsOf('n1').length]).toEqual(['mine', 'b', 1]);
    await vi.waitFor(() => expect(h.brief('n1')).toEqual(['s1:mine', 's2:codex s2']), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 2000, interval: 5 });
    c.off();
    expect(c.shown).toEqual([]);
    expect(stopLines()).toEqual([]);
    expect(shotOf('n1', 's2')).toBe('codex s2');
  });
});

const { noteBackendConnection } = await import('../../src/lib/backendConnection');
const OUTPACED = 'Codex kept changing “Opening”, so your changes aren’t saved yet. Nebula will try again when Codex stops.';
const TOO_BIG_ONE = (name: string) => `“${name}” is too big to save. Remove something from it, then try again.`;
let codexRev = 900_000;
const codexShots = (n: number) => [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: `codex ${n}` }];
/** A 409 that Codex's change makes (scene_changed), with its s2 `n`, keyed as the fake backend keys it. */
const changedBy = (n: number) => ({ status: 409, body: { detail: 'changed', code: 'scene_changed',
  scene: sceneOf(codexShots(n)), sceneKey: JSON.stringify(codexShots(n).map((s) => [s.id, s.prompt])), sceneRev: (codexRev += 1),
  changedBy: { kind: 'agent', name: 'Codex' } } });

describe('review 23 NIT-1: the retrying line’s paths the mutants found untested', () => {
  it('a reconnect resends a server stop: the retrying line takes the stop’s place in one update, then clears when it saves', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneRetryDelaysForTests([5]);
    await stopBy(h, 'n1', 'server');
    h.fail('n1', 0);
    await sleep(1100); // resends go at most once a second per scene
    const release = h.holdPuts();
    const w = watch();
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 2000, interval: 2 });
    release();
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 2000, interval: 5 });
    w.off();
    expect(w.seen).toEqual([[SERVER('“Opening”')], [RETRYING('“Opening”')], []]);
  });

  it('an outpaced stop (Codex kept changing it) promises no retry: the person’s next change never shows the retrying line', async () => {
    const h = backend({ n1: 'Opening' });
    store.setSceneQuietRetryForTests(60_000);
    for (let n = 0; n <= 21; n += 1) h.scenes.get('n1')!.refuse.push(changedBy(n));
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopLines()).toEqual([OUTPACED]), { timeout: 5000, interval: 5 });
    // Codex is quiet now: the backend holds its last change (the 21st refusal's, n = 20).
    const scene = h.scenes.get('n1')!;
    scene.refuse.length = 0;
    scene.shots = codexShots(20);
    const w = watch();
    typeIn('n1', 's1', 'mine again');
    await vi.waitFor(() => expect(unsaved('n1')).toBeNull(), { timeout: 3000, interval: 5 });
    w.off();
    expect(w.seen).toEqual([[OUTPACED], []]);
  });



  for (const [code, name] of [['workspace_moved', 'moved'], ['canvas_replaced', 'replaced'], ['params_outdated', 'params-outdated']] as const) {
    it(`a retry answered ${name} ends the retrying line in the update that settles it`, async () => {
      const h = backend({ n1: 'Opening' });
      store.setSceneRetryDelaysForTests([40]);
      h.fail('n1', 1);
      const w = watch();
      typeIn('n1', 's1', 'mine');
      await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 2000, interval: 2 });
      h.scenes.get('n1')!.refuse.push({ status: 409, body: { detail: 'No.', code, project: { id: 'B', name: 'Other' }, switchedBy: null } });
      await vi.waitFor(() => expect(h.putsOf('n1')).toHaveLength(2), { timeout: 2000, interval: 2 });
      await sleep(30);
      w.off();
      expect(w.seen).toEqual([[], [RETRYING('“Opening”')], []]);
    });
  }

  it('the lines’ order: a 400, a stop, the retries, a too-big (rank)', async () => {
    const h = backend({ n1: 'Opening', n2: 'Second' });
    store.setSceneRetryDelaysForTests([60_000]);
    h.refuse('n2', 413);
    typeIn('n2', 's1', 'big');
    await vi.waitFor(() => expect(stopped().n2).toBe(true), { timeout: 2000, interval: 2 });
    h.fail('n1', 1);
    typeIn('n1', 's1', 'mine');
    await vi.waitFor(() => expect(stopLines()).toHaveLength(2), { timeout: 2000, interval: 2 });
    expect(stopLines()).toEqual([RETRYING('“Opening”'), TOO_BIG_ONE('Second')]);
  });
  it('a retrying scene deleted and put back by Undo comes back saving, never as a stop', async () => {
    // Last in the file: the restore's node hold and the scene caches the
    // module keeps by id outlive the store reset between tests.
    // Its own node id (the scene caches the module keeps by id outlive a
    // test), and no extra node: the fake's "e1" isn't a backend-style id, so
    // the store keeps it as the canvas's own as well, and an Undo of the
    // whole canvas would leave it twice for the next test.
    const h = backend({ n7: 'Opening' }, []);
    store.setSceneRetryDelaysForTests([60_000]);
    h.fail('n7', 1);
    typeIn('n7', 's1', 'mine');
    await vi.waitFor(() => expect(stopLines()).toEqual([RETRYING('“Opening”')]), { timeout: 3000, interval: 5 });
    useGraphStore.getState().deleteNode('n7');
    // The delete lands first (as review 23's R2a: Undo after it, not racing its request).
    await vi.waitFor(() => expect(h.scenes.get('n7')!.deleted).toBe(true), { timeout: 2000, interval: 5 });
    await sleep(100);
    expect(stopLines()).toEqual([]);
    const w = watch();
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(h.brief('n7')).toEqual(['s1:mine', 's2:b']), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(unsaved('n7')).toBeNull(), { timeout: 2000, interval: 5 });
    w.off();
    expect(w.seen.flat().filter((line) => line.includes('next change'))).toEqual([]);
    expect(stopped().n7).toBeFalsy();
  });
});
