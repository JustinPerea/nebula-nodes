import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 17 (review 15, GM r26), on round 12's keyed backend in
 * small (graphStore.fix16's harness):
 * - LOW-1 (GM r26 answer 1): Codex ends a clash itself (it writes the
 *   person's own value) while a 400 or 413 waits behind it: the same as the
 *   person's answer. The card matching Nebula's scene clears the stop and
 *   the mark; otherwise the stop line is said once, with [Try again].
 * - GM r26 answer 2: while a clash is asked again, the prompt is the only
 *   line for that scene; the lines that gave way don't come back, and no
 *   stale [Undo] can delete the scene behind the open question.
 * - GM r26 answer 3: while a scene is stopped, its stop line keeps its slot;
 *   Codex's edits about that scene alone go only to the Agent log. Codex
 *   deleting it or starting a new clash says that instead; edits about
 *   anything else show, with the stop line beside them.
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


const CANT = 'Nebula can’t save your changes to “Opening”.';
const TOO_BIG = '“Opening” is too big to save. Remove something from it, then try again.';
/** Both notice slots' lines from now on (a line beside an undo offer goes
 * in the message slot). */
function watchSlots() {
  const texts = (state: unknown) => {
    const st = state as { undoNotice: { text: string } | null; messageNotice: { text: string } | null };
    return [st.undoNotice?.text, st.messageNotice?.text].filter((text): text is string => Boolean(text));
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
const retryToasts = () => slots().filter((notice) => notice.retryScene?.nodeId === 'n1');

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
const DELETED16 = 'Codex deleted “Opening”, so your changes to it can’t be saved.';
const gone = () => !useGraphStore.getState().nodes.some((node: { id: string }) => node.id === 'n1');

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

const AGENT_UNDO = { edit: { id: 'ed_agent_undo', actor: { kind: 'agent', name: 'Codex' }, undoes: 'ed_agent' } };
const STOPPED = 'Couldn’t save your changes to “Opening”. They’re kept and Nebula will try again with your next change.';
const messageSlot = () => (useGraphStore.getState() as unknown as { messageNotice: { text: string; retryScene?: { nodeId: string } } | null }).messageNotice;

/** A clash on s1, s3 unsaved too, and the save that goes refused `status`. */
async function refusedDuringClash(h: ReturnType<typeof backend>, status: number) {
  await clashOnS1(h);
  h.failNext(0);
  const puts = h.puts.length;
  h.refuseNext(status, status === 413 ? { detail: 'too big', limit: 'size' } : { detail: 'bad', code: 'bad_params' });
  typeIn('s3', 'mine on s3');
  await vi.waitFor(() => expect(h.puts.slice(puts).some((put) => put.status === status)).toBe(true), { timeout: 3000, interval: 5 });
  await sleep(40);
}

/** A save stopped after its timed retries (the server keeps failing). */
async function stoppedByServer(h: ReturnType<typeof backend>) {
  store.setSceneRetryDelaysForTests([5]);
  h.failNext(1000);
  typeIn('s2', 'mine on s2');
  await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
  expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
}

describe('review 15 LOW-1 (GM r26 answer 1): Codex ends the clash itself while a 400 or 413 waits behind it', () => {
  it.each([[400, CANT], [413, TOO_BIG]])('%i, another edit left: the stop line is said once with [Try again]; nothing is sent', async (status, line) => {
    const h = backend(S3);
    const lines = watchSlots();
    await refusedDuringClash(h, status);
    const puts = h.puts.length;
    // Codex writes the person's own value into the clashing field.
    h.other((shots) => setPrompt(shots, 's1', 'mine'), 'agent');
    await vi.waitFor(() => expect(unsaved()).toBe(line), { timeout: 3000, interval: 5 });
    await sleep(QUIET * 2);
    lines.off();
    expect(clashes16()).toEqual({});
    expect(stopped()).toEqual({ n1: true });
    expect([toast(), messageSlot()].filter((notice) => notice?.retryScene?.nodeId === 'n1').map((notice) => notice!.text)).toEqual([line]);
    expect(lines.lines.filter((text) => text === line)).toEqual([line]);
    expect(h.puts.length).toBe(puts);
    // Nothing more goes on Codex's next write; [Try again] sends it.
    h.other((shots) => setPrompt(shots, 's2', 'codex s2'), 'agent');
    await sleep(QUIET * 2);
    expect(h.puts.length).toBe(puts);
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex s2', 's3:mine on s3']);
  });

  it('nothing left unsaved (s3 typed back first): the stop and the mark go, nothing is said, the next edit saves', async () => {
    const h = backend(S3);
    const lines = watchSlots();
    await refusedDuringClash(h, 400);
    typeIn('s3', 'c');
    await sleep(40);
    const puts = h.puts.length;
    h.other((shots) => setPrompt(shots, 's1', 'mine'), 'agent');
    await vi.waitFor(() => expect(clashes16()).toEqual({}), { timeout: 3000, interval: 5 });
    await sleep(QUIET * 2);
    lines.off();
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
    expect(retryToasts()).toEqual([]);
    expect(lines.lines.filter((text) => text === CANT)).toEqual([]);
    expect(h.puts.length).toBe(puts);
    expect(store.hasUnsavedSceneEdits()).toBe(false);
    typeIn('s2', 'after');
    await vi.waitFor(() => expect(h.backendBrief()[1]).toBe('s2:after'), { timeout: 3000, interval: 5 });
  });
});

describe('GM r26 answer 2: the asked-again prompt is the only line for the scene', () => {
  it('the Agent log’s undo brings it back: "Codex undid its edit." with [Undo] gives way, doesn’t come back after the answer; Cmd+Z still undoes it', async () => {
    const h = backend(S3);
    await clashOnS1(h);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await vi.waitFor(() => expect(gone()).toBe(true), { timeout: 3000, interval: 5 });
    h.failNext(0);
    h.restore(AGENT_UNDO);
    await vi.waitFor(() => expect(clashes16().n1?.line).toBe(CLASH16), { timeout: 3000, interval: 5 });
    await sleep(40);
    // No line about the scene beside the prompt: no stale [Undo] to delete it.
    expect(slots().map((notice) => notice.text)).toEqual([]);
    const top = useGraphStore.getState().undoStack.at(-1) as { undoes?: string; kind?: string };
    expect(top.undoes).toBe('ed_agent');
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(h.backendBrief()[0]).toBe('s1:mine'), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(slots().map((notice) => notice.text)).toEqual([]);
  });

  it('the person’s own delete and Undo: "Restored the node." with [Redo] gives way to the prompt; Redo still works by the keyboard', async () => {
    const h = backend(S3);
    withRestore(h);
    await clashOnS1(h);
    h.failNext(0);
    useGraphStore.getState().deleteNode('n1');
    await vi.waitFor(() => expect(h.state.deleted).toBe(true), { timeout: 3000, interval: 5 });
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(clashes16().n1?.line).toBe(CLASH16), { timeout: 3000, interval: 5 });
    await sleep(60);
    expect(slots().map((notice) => notice.text)).toEqual([]);
    expect(useGraphStore.getState().redoStack.length).toBeGreaterThan(0);
    useGraphStore.getState().redo();
    await vi.waitFor(() => expect(gone()).toBe(true), { timeout: 3000, interval: 5 });
  });

  it('a line about another node stays beside the prompt', async () => {
    const h = backend(S3);
    withRestore(h);
    await clashOnS1(h);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await vi.waitFor(() => expect(gone()).toBe(true), { timeout: 3000, interval: 5 });
    h.failNext(0);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(clashes16().n1?.line).toBe(CLASH16), { timeout: 3000, interval: 5 });
    h.state.nodes = [editNode('n2', 'Edit B')];
    h.emit(AGENT);
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex changed the canvas.'), { timeout: 3000, interval: 5 });
    expect(clashes16().n1?.line).toBe(CLASH16);
  });
});

describe('GM r26 answer 3: the stop line keeps its slot; Codex’s edits about that scene go to the Agent log', () => {
  it('Codex’s edit about the stopped scene alone: no toast; the stop line stays with [Try again]; Cmd+Z can still undo it', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    const lines = watchSlots();
    h.other((shots) => setPrompt(shots, 's3', 'codex s3'), 'agent');
    await vi.waitFor(() => expect(briefOf()[2]).toBe('s3:codex s3'), { timeout: 3000, interval: 5 });
    await sleep(40);
    lines.off();
    expect(lines.lines.filter((text) => text === 'Codex changed the canvas.')).toEqual([]);
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    expect(toast()?.text).toBe(STOPPED);
    const top = useGraphStore.getState().undoStack.at(-1) as { kind?: string; agentName?: string };
    expect(top.kind).toBe('foreign');
    expect(top.agentName).toBe('Codex');
  });

  it('Codex deletes the stopped scene: its line replaces the stop line', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await vi.waitFor(() => expect(toast()?.text).toBe(DELETED16), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(retryToasts()).toEqual([]);
    expect(slots().map((notice) => notice.text)).toEqual([DELETED16]);
  });

  it('Codex deletes the stopped scene and more: one sentence replaces the stop line', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    h.state.nodes = [editNode('n2', 'Edit B')];
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    const ONE = 'Codex changed the canvas and deleted “Opening”, so your changes to it can’t be saved.';
    await vi.waitFor(() => expect(toast()?.text).toBe(ONE), { timeout: 3000, interval: 5 });
    await sleep(40);
    expect(slots().map((notice) => notice.text)).toEqual([ONE]);
  });

  it('Codex starts a new clash on the stopped scene: the prompt replaces the stop line; no Codex toast', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    const lines = watchSlots();
    h.other((shots) => setPrompt(shots, 's2', 'codex s2'), 'agent');
    await vi.waitFor(() => expect(clashes16().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    await sleep(40);
    lines.off();
    expect(slots().map((notice) => notice.text)).toEqual([]);
    expect(lines.lines.filter((text) => text === 'Codex changed the canvas.')).toEqual([]);
  });

  it('Codex’s edit about another node: its toast shows as usual, the stop line moves beside it with [Try again]', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    h.state.nodes = [editNode('n2', 'Edit B')];
    h.emit(AGENT);
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex changed the canvas.'), { timeout: 3000, interval: 5 });
    expect(messageSlot()?.text).toBe(STOPPED);
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
  });
});
