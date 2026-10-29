import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 13 (review 12; GM r21, GM's #198 r12 answers), on round
 * 12's keyed backend in small (graphStore.fix12's harness):
 * - Review 12 L-1: a second clash during the answer's save keeps the stop;
 *   its failed answer goes back to stopped, never the timed retries.
 * - GM #198 r12 answer 1 (review 12 N-1): a stopped save's own try refused
 *   400 or 413 speaks once, in a line that promises no retry, keeps
 *   [Try again] on the mark, and nothing tries again by itself until the
 *   person edits or presses it. The Agent log has the status and code.
 * - GM r21 answer 3: a delete's sync is ONE toast: the deleted line with
 *   Codex's [Undo]; "Codex changed the canvas." first only when the write
 *   did more than delete the scene.
 * - GM #198 r12 answer 2 (review 12 L-2): a clash waiting when the scene was
 *   deleted is asked again once it is back, against the restored scene; the
 *   same value is no clash; the clash prompt takes the deleted toast's place.
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
const { resetBackendConnectionForTests, noteBackendConnection } = await import('../../src/lib/backendConnection');
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
const nodeOf = (id: string) => useGraphStore.getState().nodes.find((n: { id: string }) => n.id === id);
const shotsOf = () => ((nodeOf('n1')?.data.params.scene as { shots: Shot[] } | undefined)?.shots ?? []);
const brief = () => shotsOf().map((s) => `${s.id}:${s.prompt}`);
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

const STOPPED = 'Couldn’t save your changes to “Opening”. They’re kept and Nebula will try again with your next change.';
const QUIET = 80;
const stopped = () => useGraphStore.getState().stoppedScenes;
const clashes = () => useGraphStore.getState().sceneClashes;
const toast = () => (useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null }).undoNotice;

/** Every toast line from now on (the slot's text as it changes; what it
 * shows now doesn't count). */
function watchToasts() {
  const now = toast()?.text;
  const lines: string[] = now ? [now] : [];
  const seen = lines.length;
  const off = useGraphStore.subscribe((state) => {
    const text = (state as unknown as { undoNotice: { text: string } | null }).undoNotice?.text;
    if (text && lines[lines.length - 1] !== text) lines.push(text);
  });
  return { get lines() { return lines.slice(seen); }, off };
}
const saveLines = (lines: string[]) => lines.filter((line) => /save|kept changing|deleted/i.test(line));

/** A save stopped after its timed retries (the server keeps failing). */
async function stoppedByServer(h: ReturnType<typeof backend>) {
  store.setSceneRetryDelaysForTests([5]);
  h.failNext(1000);
  typeIn('s1', 'mine');
  await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
  expect(unsaved()).toBe(STOPPED);
  return h.puts.length;
}

beforeEach(() => store.setSceneQuietRetryForTests(QUIET));
afterEach(() => store.setSceneQuietRetryForTests(null));


const CANT = 'Nebula can’t save your changes to “Opening”.';
const TOO_BIG = '“Opening” is too big to save. Remove something from it, then try again.';
const DELETED = 'Codex deleted “Opening”, so your changes to it can’t be saved.';
const CLASH = 'Codex changed “Opening” while you were editing it.';
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
const slotLine = (line: string) => [toast()?.text, (useGraphStore.getState() as unknown as { messageNotice: { text: string } | null })
  .messageNotice?.text].includes(line);
const slotRetry = () => toast()?.retryScene ?? (useGraphStore.getState() as unknown as { messageNotice: { retryScene?: { nodeId: string } } | null })
  .messageNotice?.retryScene;
const offer = () => (toast() as unknown as { offer?: string | null } | null)?.offer ?? null;

/** The Agent log's lines from now on. */
function watchLog() {
  const lines: string[] = [];
  const on = (event: Event) => { lines.push(String((event as CustomEvent<{ message: string }>).detail.message)); };
  window.addEventListener('nebula:agent-log-entry', on);
  return { lines, off: () => window.removeEventListener('nebula:agent-log-entry', on) };
}

describe('review 12, L-1: a second clash during the answer’s save', () => {
  it('keeps the stop: the second answer, failing, goes back to stopped; no timed retries, no new line', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await sleep(20);
    expect(clashes().n1).toBeTruthy();
    // The first answer's save goes out with saving working again; Codex
    // writes s1 once more while it is out, so it is refused as changed and
    // a second clash asks. Saving fails again from then on.
    h.failNext(0);
    h.onPut(async (n) => {
      if (n !== before + 1) return;
      h.other((shots) => setPrompt(shots, 's1', 'codex s1 again'), 'agent');
    });
    h.beforeAnswer(async () => { h.failNext(1000); });
    const saidBefore = [...said];
    const toasts = watchToasts();
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(clashes().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    expect(h.puts.at(-1)!.status).toBe(409);
    h.onPut(async () => {});
    h.beforeAnswer(async () => {});
    const puts = h.puts.length;
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(300);
    toasts.off();
    // One send for the answer, then back to stopped: never the timed retries.
    expect(h.puts.length).toBe(puts + 1);
    expect(h.puts.at(-1)!.status).toBe(500);
    expect(stopped()).toEqual({ n1: true });
    expect(unsaved()).toBe(STOPPED);
    expect(said).toEqual(saidBefore);
    expect(saveLines(toasts.lines)).toEqual([]);
    expect(brief()[0]).toBe('s1:mine');
  });
});

describe('GM #198 r12 answer 1 (review 12 N-1): a stopped save’s own try refused 400 or 413', () => {
  it.each([
    ['400', 400, { detail: 'params.scene nested too deeply', code: 'bad_params' }, CANT, 'HTTP 400 bad_params'],
    ['413', 413, { detail: 'Project snapshot exceeds the 16 MiB limit', limit: 'size' }, TOO_BIG, 'HTTP 413'],
  ])('%s: said once, a line that promises no retry, [Try again] on the mark; nothing more until the person acts', async (_what, status, body, line, logged) => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    const log = watchLog();
    const toasts = watchSlots();
    h.refuseNext(status, body);
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(QUIET + 80);
    expect(h.puts.length).toBe(before + 1);
    expect(h.puts.at(-1)!.status).toBe(status);
    // Said once, with [Try again] (the toast's, and the mark's popover).
    expect(saveLines(toasts.lines)).toEqual([line]);
    expect(slotLine(line)).toBe(true);
    expect(slotRetry()).toEqual({ nodeId: 'n1' });
    expect(unsaved()).toBe(line);
    expect(stopped()).toEqual({ n1: true });
    expect(line).not.toMatch(/will try again|HTTP|\d{3}/);
    // The Agent log has the status and the code.
    expect(log.lines.some((entry) => entry.includes(logged) && entry.includes('“Opening”'))).toBe(true);
    log.off();
    // Codex keeps writing: no quiet try, no reconnect send, nothing said again.
    h.other((shots) => setPrompt(shots, 's3', 'codex 2'), 'agent');
    await sleep(QUIET * 3);
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await sleep(50);
    toasts.off();
    expect(h.puts.length).toBe(before + 1);
    expect(saveLines(toasts.lines)).toEqual([line]);
    // [Try again] sends it.
    h.failNext(0);
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.puts.length).toBe(before + 2);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex', 's3:codex 2']);
  });

  it('the person’s next change sends it too', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.refuseNext(413, { detail: 'too big', limit: 'size' });
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(QUIET + 80);
    expect(unsaved()).toBe(TOO_BIG);
    h.failNext(0);
    typeIn('s3', 'shorter');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.puts.length).toBe(before + 2);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex', 's3:shorter']);
  });

  it('the save a clash answer sent while stopped, refused 400: the same, said once', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await sleep(20);
    h.failNext(0);
    h.refuseNext(400, { detail: 'bad', code: 'bad_params' });
    const toasts = watchSlots();
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(QUIET * 3);
    toasts.off();
    expect(h.puts.at(-1)!.status).toBe(400);
    expect(saveLines(toasts.lines)).toEqual([CANT]);
    expect(unsaved()).toBe(CANT);
    expect(stopped()).toEqual({ n1: true });
  });
});

describe('GM r21 answer 3: the delete’s sync is ONE toast', () => {
  it('Codex’s write only deleted the scene: the toast says the deleted line and keeps Codex’s [Undo]', async () => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([60]);
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(20);
    said = [];
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await sleep(100);
    expect(toast()?.text).toBe(DELETED);
    expect(offer()).toBe('undo');
    expect(useGraphStore.getState().messageNotice).toBeNull();
    expect(said).toEqual([]);
  });

  it('Codex’s write did more: "Codex changed the canvas." with its [Undo], the deleted line as its second sentence', async () => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([60]);
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(20);
    said = [];
    h.state.nodes = [editNode('n2', 'Edit B')];
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await sleep(100);
    expect(toast()?.text).toBe(`Codex changed the canvas. ${DELETED}`);
    expect(offer()).toBe('undo');
    expect(useGraphStore.getState().messageNotice).toBeNull();
    expect(said).toEqual([]);
  });

  it('the save’s 404 said it first: the delete’s toast carries the line, never a second one', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.failNext(0);
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT, false);
    await sleep(QUIET + 80);
    expect(h.puts.length).toBe(before + 1);
    expect(said.filter((line) => /deleted/.test(line))).toEqual([DELETED]);
    h.emit(AGENT);
    await sleep(40);
    expect(toast()?.text).toBe(DELETED);
    expect(offer()).toBe('undo');
    expect(said.filter((line) => /deleted/.test(line))).toEqual([DELETED]);
    expect(useGraphStore.getState().messageNotice).toBeNull();
  });

  it('nothing unsaved: the delete’s toast stays Codex’s own', async () => {
    const h = backend(S3);
    typeIn('s1', 'saved');
    await vi.waitFor(() => expect(h.backendBrief()[0]).toBe('s1:saved'), { timeout: 3000, interval: 5 });
    await sleep(30);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await sleep(40);
    expect(toast()?.text).toBe('Codex changed the canvas');
  });
});

describe('GM #198 r12 answer 2 (review 12 L-2): a clash waiting when the scene was deleted', () => {
  async function clashThenDelete(h: ReturnType<typeof backend>) {
    store.setSceneRetryDelaysForTests([40]);
    h.failNext(1000);
    typeIn('s1', 'mine');
    await sleep(20);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await vi.waitFor(() => expect(clashes().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    expect(clashes().n1.line).toBe(CLASH);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await sleep(60);
    expect(nodeOf('n1')).toBeUndefined();
    expect(clashes()).toEqual({});
    expect(toast()?.text).toBe(DELETED);
    h.failNext(0);
  }

  it('asked again once the scene is back, against the restored scene; the clash prompt takes the deleted toast’s place', async () => {
    const h = backend(S3);
    await clashThenDelete(h);
    // Put back with no toast of its own (the deleted toast still shows).
    h.restore({});
    await vi.waitFor(() => expect(clashes().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    expect(clashes().n1.line).toBe(CLASH);
    expect(clashes().n1.agent).toBe('Codex');
    expect(toast()?.text ?? '').not.toContain(DELETED);
    expect(useGraphStore.getState().messageNotice?.text ?? '').not.toContain(DELETED);
    expect(unsaved()).toBe(CLASH);
    // The person's value on the card; Codex's stays Nebula's until they choose.
    expect(brief()[0]).toBe('s1:mine');
    await sleep(80);
    expect(h.backendBrief()[0]).toBe('s1:codex s1');
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(h.backendBrief()[0]).toBe('s1:mine'), { timeout: 3000, interval: 5 });
  });

  it('the restored value is the person’s: no clash, the save goes', async () => {
    const h = backend(S3);
    await clashThenDelete(h);
    h.state.shots = setPrompt(h.state.shots, 's1', 'mine');
    h.restore({});
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
    expect(clashes()).toEqual({});
    expect(brief()[0]).toBe('s1:mine');
    expect(h.backendBrief()[0]).toBe('s1:mine');
  });

  it('Use Codex’s after the restore keeps Codex’s value', async () => {
    const h = backend(S3);
    await clashThenDelete(h);
    h.restore(AGENT);
    await vi.waitFor(() => expect(clashes().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
    expect(brief()[0]).toBe('s1:codex s1');
    expect(h.backendBrief()[0]).toBe('s1:codex s1');
  });
});
