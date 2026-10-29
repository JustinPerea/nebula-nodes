import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 18 (review 16, GM r27), on graphStore.fix17's harness:
 * - LOW-1 (GM r27 answer 1): while a clash waits on a scene (first or asked
 *   again), Codex's edits about that scene alone go only to the Agent log,
 *   as for a stopped scene: one rule for a scene with a line of its own. An
 *   edit to the clashed field rewrites the prompt; one that makes it match
 *   the person's value ends the clash.
 * - LOW-2 (GM r27 answer 2): while a scene is stopped, the person's own
 *   toasts show with the stop line beside them, with [Try again]. Their own
 *   Undo that leaves nothing unsaved clears the stop and the mark.
 * - GM r27 answer 3: a Codex wire from the stopped scene into another node
 *   shows its toast, with the stop line beside it.
 */
const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    // The project store's own listener (M-3's beforeunload test).
    subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
const wsq = { hold: false, queue: [] as Record<string, unknown>[] };
const deliver = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };
const socketSends = (event: Record<string, unknown>) => { if (wsq.hold) wsq.queue.push(JSON.parse(JSON.stringify(event))); else deliver(event); };

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
type Shot = { id: string; prompt?: string; [key: string]: unknown };
type Wire = { id: string; type: string; source: string; sourceHandle: string; target: string; targetHandle: string; data: { dataType: string } };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sceneOf = (shots: Shot[]) => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots });
const cinema = (shots: Shot[]) => ({ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
  data: { label: 'Opening', definitionId: 'cinema-scene', params: { scene: sceneOf(clone(shots)) }, state: 'idle', outputs: {} } });
const editNode = (id: string, label: string) => ({ id, type: 'model-node', position: { x: 400, y: 0 },
  data: { label, definitionId: 'gpt-image-2-5-edit', params: {}, state: 'idle', outputs: {} } });
const unsaved = () => useGraphStore.getState().unsavedScenes.n1 ?? null;
let said: string[] = [];
const AGENT = { edit: { id: 'ed_agent', actor: { kind: 'agent', name: 'Codex' } } };
const WINDOW = { edit: { id: 'ed_window', actor: { kind: 'person', name: 'You' }, tab: 'tab-other' } };
const OWN = () => ({ edit: { id: `ed_own${Math.random()}`, actor: { kind: 'person', name: 'You' }, tab: TAB_ID } });
const wire = (shot: string, target: string, handle = 'mask'): Wire => ({ id: `e-${shot}-${target}-${handle}`, type: 'typed-edge', source: 'n1',
  sourceHandle: `shot_${shot}`, target, targetHandle: handle, data: { dataType: 'Image' } });

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a', canvas: 'c1' } as never);
  useGraphStore.getState().resetExecution();
  store.clearCinemaScenePersistence();
  store.setSceneRetryDelaysForTests([30, 30, 30]);
  said = [];
  wsq.hold = false;
  wsq.queue = [];
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [], unsavedScenes: {}, sceneClashes: {},
    stoppedScenes: {}, isExecuting: false, backendFreshStartPending: false, undoNotice: null, messageNotice: null, isImportingGraph: false,
    runHistory: [], providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (text: string) => { said.push(text); } } as never);
});

/** Revisions go on across tests, as the backend's do across restarts. */
let revisionCounter = 1000;

/** The keyed backend (main.py + services/scene_keys.py, in small), with
 * revisions and a socket that can lag. */
function backend(start: Shot[] = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }],
  extra: { nodes?: unknown[]; edges?: Wire[] } = {}) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [], edges: [] } as never);
  const state = { shots: clone(start), edges: [...(extra.edges ?? [])], nodes: extra.nodes ?? [editNode('n2', 'Edit A')],
    writer: null as null | { kind: string; name: string }, rev: (revisionCounter += 1),
    deleted: false, deletedBy: null as null | { kind: string; name: string }, refuse: [] as { status: number; body: Record<string, unknown> }[] };
  const keyOf = () => JSON.stringify(state.shots.map((s) => [s.id, s.prompt]));
  const snapshot = () => (state.deleted ? { nodes: [...state.nodes], edges: [], sceneKeys: {}, sceneRevs: {} }
    : { nodes: [cinema(state.shots), ...state.nodes], edges: clone(state.edges), sceneKeys: { n1: keyOf() }, sceneRevs: { n1: state.rev } });
  const emit = (origin: object = {}) => socketSends({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...snapshot(), ...origin });
  const commit = (shots: Shot[], writer: { kind: string; name: string }) => {
    const before = keyOf();
    state.shots = clone(shots);
    const ports = new Set(shots.map((s) => `shot_${s.id}`));
    state.edges = state.edges.filter((e) => ports.has(e.sourceHandle));
    if (keyOf() !== before) state.rev = (revisionCounter += 1);
    state.writer = writer;
  };
  const puts: { shots: string[]; ifKey: string | null; status: number }[] = [];
  const connects: string[] = [];
  const deletes: string[] = [];
  let fail = 0;
  let hook: (n: number) => Promise<void> = async () => {};
  let answerHook: (n: number) => Promise<void> = async () => {};
  emit();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'PUT' && path.includes('/api/graph/node/n1')) {
      const body = JSON.parse(String(init.body));
      const n = puts.length + 1;
      const entry = { shots: body.params.scene.shots.map((s: Shot) => `${s.id}:${s.prompt}`), ifKey: body.ifSceneKey ?? null, status: 200 };
      puts.push(entry);
      await hook(n);
      if (state.deleted) {
        entry.status = 404;
        return json({ detail: 'Node n1 not found', code: 'node_gone', deletedBy: state.deletedBy }, 404);
      }
      const refusal = state.refuse.shift();
      if (refusal) { entry.status = refusal.status; return json(refusal.body, refusal.status); }
      if (fail > 0) { fail -= 1; entry.status = 500; return json({ detail: 'boom' }, 500); }
      if (entry.ifKey && entry.ifKey !== keyOf()) {
        entry.status = 409;
        const answer = { detail: 'changed', code: 'scene_changed', scene: sceneOf(clone(state.shots)), sceneKey: keyOf(),
          sceneRev: state.rev, changedBy: state.writer };
        await answerHook(n);
        return json(answer, 409);
      }
      commit(body.params.scene.shots, { kind: 'person', name: 'You' });
      const committed = { ...snapshot(), ...OWN() };
      const key = keyOf();
      const rev = state.rev;
      await sleep(2);
      socketSends({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...committed });
      await sleep(2);
      await answerHook(n);
      return json({ id: 'n1', sceneKey: key, sceneRev: rev });
    }
    if (init?.method === 'POST' && path.includes('/api/graph/connect')) {
      const body = JSON.parse(String(init.body));
      const name = `${body.source}:${body.sourceHandle}->${body.target}:${body.targetHandle}`;
      connects.push(body.onlyIfFree ? `${name} (onlyIfFree)` : name);
      if (body.onlyIfFree && state.edges.some((e) => e.target === body.target && e.targetHandle === body.targetHandle)) {
        return json({ detail: 'taken', code: 'input_taken' }, 409);
      }
      state.edges.push(wire(body.sourceHandle.slice(5), body.target, body.targetHandle));
      emit(OWN());
      return json({ ok: true });
    }
    if (init?.method === 'DELETE' && path.includes('/api/graph/edge')) {
      deletes.push(String(init.body));
      return json({ detail: 'No such connection.' }, 404);
    }
    if (path.includes('/api/graph/export')) return json({ ...base, canvasRevision: 'c1', empty: false, ...snapshot() });
    return json({});
  });
  return {
    state, puts, connects, deletes, emit, keyOf,
    failNext: (count: number) => { fail = count; },
    onPut: (fn: (n: number) => Promise<void>) => { hook = fn; },
    beforeAnswer: (fn: (n: number) => Promise<void>) => { answerHook = fn; },
    /** An agent's (or another window's) write: committed, then its sync. */
    other: (change: (shots: Shot[]) => Shot[], who: 'agent' | 'window' = 'agent', edges?: (e: Wire[]) => Wire[]) => {
      commit(change(clone(state.shots)), who === 'agent' ? { kind: 'agent', name: 'Codex' } : { kind: 'person', name: 'You' });
      if (edges) state.edges = edges(state.edges);
      emit(who === 'agent' ? AGENT : WINDOW);
    },
    backendBrief: () => state.shots.map((s) => `${s.id}:${s.prompt}`),
    /** Someone deletes the scene node (who: `deletedBy`), then its sync. */
    remove: (by: { kind: string; name: string } | null, origin: object = by?.kind === 'agent' ? AGENT : {}, sync = true) => {
      state.deleted = true;
      state.deletedBy = by;
      state.edges = [];
      if (sync) emit(origin);
    },
    /** The delete undone (the Agent log's Undo): the node back as it was. */
    restore: (origin: object = AGENT) => {
      state.deleted = false;
      state.rev = (revisionCounter += 1);
      emit(origin);
    },
    refuseNext: (status: number, body: Record<string, unknown>) => { state.refuse.push({ status, body }); },
  };
}
const typeIn = (shotId: string, prompt: string) => useGraphStore.getState().updateScene('n1', (current: { shots: Shot[] }) => ({ ...current,
  shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, prompt } : shot)) }));
const setPrompt = (shots: Shot[], id: string, prompt: string) => shots.map((s) => (s.id === id ? { ...s, prompt } : s));
const S3 = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }, { id: 's3', prompt: 'c' }];

const QUIET = 80;
const stopped = () => useGraphStore.getState().stoppedScenes;
const toast = () => (useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null }).undoNotice;



beforeEach(() => store.setSceneQuietRetryForTests(QUIET));
afterEach(() => store.setSceneQuietRetryForTests(null));


/** Both notice slots' lines from now on (a line beside an undo offer goes
 * in the message slot). */
function watchSlots() {
  const texts = (state: unknown) => {
    const st = state as { undoNotice: { text: string } | null; messageNotice: { text: string } | null };
    return [st.undoNotice?.text, st.messageNotice?.text, ...stopTexts(state)].filter((text): text is string => Boolean(text));
  };
  // What shows now doesn't count; a line counts each time it appears.
  let shown = new Set(texts(useGraphStore.getState()));
  const lines: string[] = [];
  const off = useGraphStore.subscribe((state) => {
    const now = new Set(texts(state));
    for (const text of now) if (!shown.has(text)) lines.push(text);
    shown = now;
  });
  return { lines, off };
}

/** The Agent log's lines from now on. */


const briefOf = () => (((useGraphStore.getState().nodes.find((n: { id: string }) => n.id === 'n1')?.data.params.scene) as { shots: Shot[] } | undefined)
  ?.shots ?? []).map((s) => `${s.id}:${s.prompt}`);
const slots = () => {
  const g = useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null;
    messageNotice: { text: string; retryScene?: { nodeId: string } } | null };
  return [g.undoNotice, g.messageNotice].filter((notice): notice is { text: string; retryScene?: { nodeId: string } } => Boolean(notice));
};
// GM r28 item 2 (round 19): the stop line with [Try again] is in the state
// slot now; the event slots never carry it.
const stopTexts = (state: unknown) => store.sceneStopLines(state as Parameters<typeof store.sceneStopLines>[0]).map((line) => line.text);
const retryToasts = () => store.sceneStopLines(useGraphStore.getState()).filter((line) => line.nodeIds.includes('n1'))
  .map((line) => ({ text: line.text, retryScene: { nodeId: 'n1' } }));

/** The backend's POST /api/graph/restore and DELETE /api/graph/node, in
 * small: the node back with the params the restore sent (or taken off by a
 * redo's `remove`, or the person's delete), then this tab's own echo. */
function withRestore(h: ReturnType<typeof backend>) {
  const inner = fetchMock.getMockImplementation()!;
  const restores: { remove: string[]; nodes: { id: string; params?: { scene?: { shots: Shot[] } } }[] }[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST' && path.includes('/api/graph/restore')) {
      const body = JSON.parse(String(init.body));
      restores.push(body);
      const item = body.nodes.find((node: { id: string }) => node.id === 'n1');
      if (item) {
        h.state.deleted = false;
        if (item.params?.scene?.shots) h.state.shots = clone(item.params.scene.shots);
        h.state.rev = (revisionCounter += 1);
        h.state.writer = { kind: 'person', name: 'You' };
      }
      if (body.remove?.includes('n1')) h.state.deleted = true;
      h.emit(OWN());
      await sleep(2);
      return json({ ok: true });
    }
    if (init?.method === 'DELETE' && path.includes('/api/graph/node/n1')) {
      h.state.deleted = true;
      h.state.edges = [];
      h.emit(OWN());
      await sleep(2);
      return json({ ok: true });
    }
    return inner(url, init);
  });
  return restores;
}

const CLASH16 = 'Codex changed “Opening” while you were editing it.';

/** The person types s1 while saves fail; Codex changes s1: the clash waits. */
async function clashOnS1(h: ReturnType<typeof backend>) {
  store.setSceneRetryDelaysForTests([40]);
  h.failNext(1000);
  typeIn('s1', 'mine');
  await sleep(20);
  h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
  await vi.waitFor(() => expect(clashes16().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
}
const clashes16 = () => useGraphStore.getState().sceneClashes as Record<string, { line: string; focus?: true }>;

const STOPPED = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.';
const messageSlot = () => (useGraphStore.getState() as unknown as { messageNotice: { text: string; retryScene?: { nodeId: string } } | null }).messageNotice;


/** A save stopped after its timed retries (the server keeps failing). */
async function stoppedByServer(h: ReturnType<typeof backend>) {
  store.setSceneRetryDelaysForTests([5]);
  h.failNext(1000);
  typeIn('s2', 'mine on s2');
  await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
  expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
}

const CODEX_TOAST = 'Codex changed the canvas.';
const texts = () => slots().map((notice) => notice.text);

/** withRestore, and the person's delete of the other node (n2) and its
 * restore, on the backend in small. */
function withRestoreAll(h: ReturnType<typeof backend>) {
  const restores = withRestore(h);
  const inner = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'DELETE' && path.includes('/api/graph/node/n2')) {
      h.state.nodes = h.state.nodes.filter((node) => (node as { id: string }).id !== 'n2');
      h.emit(OWN());
      await sleep(2);
      return json({ ok: true });
    }
    if (init?.method === 'POST' && path.includes('/api/graph/restore')) {
      const body = JSON.parse(String(init.body));
      if (body.nodes?.some((node: { id: string }) => node.id === 'n2')
        && !h.state.nodes.some((node) => (node as { id: string }).id === 'n2')) h.state.nodes = [...h.state.nodes, editNode('n2', 'Edit A')];
      if (body.remove?.includes('n2')) h.state.nodes = h.state.nodes.filter((node) => (node as { id: string }).id !== 'n2');
    }
    return inner(url, init);
  });
  return restores;
}

describe('review 16 LOW-1 (GM r27 answer 1): while a clash waits, Codex’s edits about that scene alone go to the Agent log', () => {
  it('a first clash: the prompt is its only line; Codex’s edit to another field of it shows no toast, Cmd+Z can undo it; an edit about another node still toasts', async () => {
    const h = backend(S3);
    const lines = watchSlots();
    await clashOnS1(h);
    h.failNext(0);
    await sleep(40);
    expect(texts()).toEqual([]);
    h.other((shots) => setPrompt(shots, 's3', 'codex s3'), 'agent');
    await vi.waitFor(() => expect(briefOf()[2]).toBe('s3:codex s3'), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(texts()).toEqual([]);
    expect(lines.lines.filter((text) => text === CODEX_TOAST)).toEqual([]);
    expect(clashes16().n1?.line).toBe(CLASH16);
    const top = useGraphStore.getState().undoStack.at(-1) as { kind?: string; agentName?: string };
    expect(top.kind).toBe('foreign');
    expect(top.agentName).toBe('Codex');
    // Toasts about other nodes stack as usual.
    h.state.nodes = [editNode('n2', 'Edit B')];
    h.emit(AGENT);
    await vi.waitFor(() => expect(toast()?.text).toBe(CODEX_TOAST), { timeout: 3000, interval: 5 });
    expect(clashes16().n1?.line).toBe(CLASH16);
    lines.off();
  });

  it('asked again (the person’s delete and Undo): Codex’s edit to another field of the scene shows no toast beside the prompt', async () => {
    const h = backend(S3);
    withRestore(h);
    await clashOnS1(h);
    h.failNext(0);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(h.state.deleted).toBe(true), { timeout: 3000, interval: 5 });
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(clashes16().n1?.line).toBe(CLASH16), { timeout: 3000, interval: 5 });
    await sleep(60);
    const lines = watchSlots();
    h.other((shots) => setPrompt(shots, 's2', 'codex s2'), 'agent');
    await vi.waitFor(() => expect(briefOf()[1]).toBe('s2:codex s2'), { timeout: 3000, interval: 5 });
    await sleep(40);
    lines.off();
    expect(texts()).toEqual([]);
    expect(lines.lines).toEqual([]);
    expect(clashes16().n1?.line).toBe(CLASH16);
  });

  it('an edit to the clashed field (and another of the scene’s) rewrites the prompt to the latest state, with no toast; Use Codex’s takes the latest', async () => {
    const h = backend(S3);
    await clashOnS1(h);
    h.failNext(0);
    await sleep(40);
    const lines = watchSlots();
    h.other((shots) => setPrompt(setPrompt(shots, 's1', 'codex s1 again'), 's2', 'codex s2'), 'agent');
    await vi.waitFor(() => expect(briefOf()[1]).toBe('s2:codex s2'), { timeout: 3000, interval: 5 });
    await sleep(60);
    lines.off();
    expect(lines.lines).toEqual([]);
    expect(clashes16().n1?.line).toBe(CLASH16);
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await vi.waitFor(() => expect(briefOf()[0]).toBe('s1:codex s1 again'), { timeout: 3000, interval: 5 });
    expect(clashes16()).toEqual({});
    expect(briefOf()).toEqual(['s1:codex s1 again', 's2:codex s2', 's3:c']);
  });

  it('Codex’s edit makes the clashed field the person’s value (and changes another of the scene’s): the clash ends; no toast, nothing unsaved, no stop, no mark', async () => {
    const h = backend(S3);
    await clashOnS1(h);
    h.failNext(0);
    await sleep(40);
    const lines = watchSlots();
    h.other((shots) => setPrompt(setPrompt(shots, 's1', 'mine'), 's3', 'codex s3'), 'agent');
    await vi.waitFor(() => expect(clashes16()).toEqual({}), { timeout: 3000, interval: 5 });
    await sleep(QUIET * 2);
    lines.off();
    expect(lines.lines).toEqual([]);
    expect(texts()).toEqual([]);
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
    expect(store.hasUnsavedSceneEdits()).toBe(false);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b', 's3:codex s3']);
    expect(briefOf()).toEqual(['s1:mine', 's2:b', 's3:codex s3']);
  });
});

describe('review 16 LOW-2 (GM r27 answer 2): the person’s own toasts and the stop line show together', () => {
  it('the person deletes another node: "Deleted the node." with [Undo], the stop line above it (the state slot) with [Try again]; Undo: "Restored the node." with [Redo], the stop line still above it', async () => {
    const h = backend(S3);
    withRestoreAll(h);
    await stoppedByServer(h);
    useGraphStore.getState().deleteNode('n2');
    // GM r28 item 2 (round 19): the stop line is in the state slot above the
    // event slot, never in the message slot.
    await vi.waitFor(() => expect(toast()?.text).toBe('Deleted the node.'), { timeout: 3000, interval: 5 });
    expect(messageSlot()).toBeNull();
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(toast()?.text).toBe('Restored the node.'), { timeout: 3000, interval: 5 });
    expect(messageSlot()).toBeNull();
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    expect(stopped()).toEqual({ n1: true });
  });

  it('Cmd+Z on Codex’s quiet edit to the stopped scene: "Undid Codex’s edit." with [Redo], the stop line above it; still stopped', async () => {
    const h = backend(S3);
    withRestore(h);
    await stoppedByServer(h);
    h.other((shots) => setPrompt(shots, 's3', 'codex s3'), 'agent');
    await vi.waitFor(() => expect(briefOf()[2]).toBe('s3:codex s3'), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(toast()).toBeNull();
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(toast()?.text).toBe('Undid Codex’s edit.'), { timeout: 3000, interval: 5 });
    await sleep(60);
    expect(messageSlot()).toBeNull();
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    expect(stopped()).toEqual({ n1: true });
    expect(unsaved()).toBe(STOPPED);
  });

  it('the person’s own Undo leaves nothing unsaved: the stop and the mark clear', async () => {
    const h = backend(S3);
    withRestore(h);
    await stoppedByServer(h);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(briefOf()[1]).toBe('s2:b'), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped()).toEqual({}), { timeout: 3000, interval: 5 });
    await sleep(QUIET * 2);
    expect(unsaved()).toBeNull();
    expect(retryToasts()).toEqual([]);
    expect(store.hasUnsavedSceneEdits()).toBe(false);
  });
});

describe('GM r27 answer 3: a Codex wire from the stopped scene into another node', () => {
  it('shows its toast; the stop line stays above it (the state slot) with [Try again]', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    h.other((shots) => shots, 'agent', (edges) => [...edges, wire('s1', 'n2')]);
    await vi.waitFor(() => expect(toast()?.text).toBe(CODEX_TOAST), { timeout: 3000, interval: 5 });
    expect(messageSlot()).toBeNull();
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    expect(useGraphStore.getState().edges.some((edge: { source: string; target: string }) => edge.source === 'n1' && edge.target === 'n2')).toBe(true);
  });
});
