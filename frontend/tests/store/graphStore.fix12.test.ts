import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 12 (review 11; GM r19 and r20), on round 11's keyed
 * backend in small (graphStore.fix11's), which can also delete the scene
 * node (404 node_gone with deletedBy), put it back, refuse a save as another
 * project opened (workspace_moved) or as 400 / 413:
 * - M-1 (GM r19 answer 2, r20 answer 1): a clash answered while the save was
 *   stopped sends the save once; landed, the stopped state is gone; failed,
 *   back to stopped with the same line, no new toast, no timed retries, and
 *   the quiet try comes back.
 * - L-1 (GM r19 answer 3, r20 answer 2): "another window" only for the
 *   person's own tab; anyone else unknown, and the line says nothing of who.
 * - L-2 (GM r16, r20 answer 3): a deleted scene says so once and stops for good, and picks the save back
 *   up when the delete is undone; a workspace move says nothing of its own.
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
const { resetBackendConnectionForTests, noteBackendConnection, noteBackendBootId } = await import('../../src/lib/backendConnection');
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

const STOPPED = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.';
const RETRYING = 'Couldn’t save your changes to “Opening”. They’re kept and Nebula will try again.';
const QUIET = 80;
const stopped = () => useGraphStore.getState().stoppedScenes;
const clashes = () => useGraphStore.getState().sceneClashes;
const toast = () => (useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null }).undoNotice;
// GM r28 item 2 (round 19): the stop line, with [Try again], is a state in its own slot.
const stopLineOf = (nodeId: string) => store.sceneStopLines(useGraphStore.getState()).find((line) => line.nodeIds.includes(nodeId))?.text ?? null;
const UNKNOWN = { edit: { id: 'ed_unknown', actor: { kind: 'anonymous', name: 'Someone' } } };

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

/** Codex commits during each of the tab's saves until told to stop. */
function busyCodex(h: ReturnType<typeof backend>, writer?: { kind: string; name: string } | null) {
  let busy = true;
  let k = 0;
  h.onPut(async () => {
    if (!busy) return;
    k += 1;
    h.other((shots) => setPrompt(shots, 's2', `c${k}`), 'agent');
    if (writer !== undefined) h.state.writer = writer;
  });
  return () => { busy = false; h.onPut(async () => {}); };
}

beforeEach(() => store.setSceneQuietRetryForTests(QUIET));
afterEach(() => store.setSceneQuietRetryForTests(null));

describe('M-1 (GM r19 answer 2): a clash answered while the save was stopped', () => {
  it('Keep mine, and its save fails: back to stopped with the same line, no new toast, no timed retries', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    // Codex changes the shot the person typed in: the clash asks at once.
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await sleep(20);
    expect(clashes().n1).toBeTruthy();
    expect(h.puts.length).toBe(before);
    const saidBefore = [...said];
    const toasts = watchToasts();
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    // Long enough for the timed retries (5 ms apart) many times over.
    await sleep(250);
    toasts.off();
    expect(h.puts.length).toBe(before + 1);
    expect(h.puts.at(-1)!.status).toBe(500);
    expect(stopped()).toEqual({ n1: true });
    expect(unsaved()).toBe(STOPPED);
    expect(said).toEqual(saidBefore);
    expect(saveLines(toasts.lines)).toEqual([]);
    expect(clashes()).toEqual({});
    expect(brief()[0]).toBe('s1:mine');
    // The popover's [Try again] still sends.
    h.failNext(0);
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.backendBrief()[0]).toBe('s1:mine');
  });

  it('GM r20 answer 1: after the fall back to stopped, the quiet try comes back (one try per quiet stretch)', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await sleep(20);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(QUIET * 2);
    expect(h.puts.length).toBe(before + 1);
    expect(stopped()).toEqual({ n1: true });
    // Codex's next change: one try about QUIET later, still quiet when it fails.
    h.other((shots) => setPrompt(shots, 's3', 'codex s3'), 'agent');
    await sleep(QUIET / 2);
    expect(h.puts.length).toBe(before + 1);
    await sleep(QUIET + 60);
    expect(h.puts.length).toBe(before + 2);
    expect(stopped()).toEqual({ n1: true });
    expect(unsaved()).toBe(STOPPED);
    await sleep(QUIET * 2);
    expect(h.puts.length).toBe(before + 2);
    // And one that works saves both.
    h.failNext(0);
    h.other((shots) => setPrompt(shots, 's2', 'codex s2'), 'agent');
    await sleep(QUIET + 80);
    expect(h.puts.length).toBe(before + 3);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex s2', 's3:codex s3']);
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
  });

  it('a stop that named Codex goes back to the named line', async () => {
    const h = backend(S3);
    const quiet = busyCodex(h);
    typeIn('s1', 'p1');
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    const NAMED = 'Codex kept changing “Opening”, so your changes aren’t saved yet. Nebula will try again when Codex stops.';
    expect(unsaved()).toBe(NAMED);
    quiet();
    store.setSceneRetryDelaysForTests([5]);
    h.failNext(1000);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await sleep(20);
    expect(clashes().n1).toBeTruthy();
    const before = h.puts.length;
    const saidBefore = [...said];
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(250);
    expect(h.puts.length).toBe(before + 1);
    expect(stopped()).toEqual({ n1: true });
    expect(unsaved()).toBe(NAMED);
    expect(said).toEqual(saidBefore);
  });

  it('Keep mine, and its save lands: the stopped state is gone for good (a later failure says its own line and retries)', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await sleep(20);
    h.failNext(0);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(h.puts.length).toBe(before + 1), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
    expect(h.backendBrief()[0]).toBe('s1:mine');
    store.setSceneRetryDelaysForTests([40]);
    h.failNext(1);
    said = [];
    useGraphStore.setState({ notify: (text: string) => { said.push(text); } } as never);
    typeIn('s2', 'later');
    await vi.waitFor(() => expect(said).toEqual([RETRYING]), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.backendBrief()[1]).toBe('s2:later');
  });

  it('Use Codex’s with nothing else to send: saved as it is, no PUT, never back to stopped', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await sleep(20);
    expect(clashes().n1?.agent).toBe('Codex');
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await sleep(QUIET * 2);
    expect(h.puts.length).toBe(before);
    expect(brief()[0]).toBe('s1:codex s1');
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
    expect(store.hasUnsavedSceneEdits()).toBe(false);
  });
});

describe('L-1 (GM r19 answer 3, r20 answer 2): "another window" only for the person’s own tab', () => {
  it('a sync from a writer nobody knows: the neutral clash line, and [Use theirs]', async () => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([400]);
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(40);
    h.state.shots = setPrompt(h.state.shots, 's1', 'script');
    h.state.rev = (revisionCounter += 1);
    h.emit(UNKNOWN);
    await sleep(30);
    expect(clashes().n1?.line).toBe('“Opening” changed while you were editing it.');
    expect(clashes().n1?.agent).toBeNull();
    expect(unsaved()).toBe('“Opening” changed while you were editing it.');
  });

  it('the person’s other tab: "another window"', async () => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([400]);
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(40);
    h.other((shots) => setPrompt(shots, 's1', 'other tab'), 'window');
    await sleep(30);
    expect(clashes().n1?.line).toBe('“Opening” was changed in another window while you were editing it.');
  });

  it('a writer nobody knows removes the shot the person changed: the passive removed line', async () => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([400]);
    h.failNext(1);
    typeIn('s2', 'mine');
    await sleep(40);
    h.state.shots = h.state.shots.filter((shot) => shot.id !== 's2');
    h.state.rev = (revisionCounter += 1);
    h.emit(UNKNOWN);
    await sleep(30);
    expect(clashes().n1?.line).toBe('“Shot 2” was removed while you were editing it.');
  });

  it('two writers on one clash (Codex, then a script): neutral, not "another window"', async () => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([400]);
    h.failNext(1000);
    typeIn('s1', 'mine 1');
    typeIn('s2', 'mine 2');
    await sleep(40);
    h.other((shots) => setPrompt(shots, 's1', 'codex'), 'agent');
    await sleep(30);
    expect(clashes().n1?.line).toBe('Codex changed “Opening” while you were editing it.');
    h.state.shots = setPrompt(h.state.shots, 's2', 'script');
    h.state.rev = (revisionCounter += 1);
    h.emit(UNKNOWN);
    await sleep(30);
    expect(clashes().n1?.line).toBe('“Opening” changed while you were editing it.');
    expect(clashes().n1?.agent).toBeNull();
  });

  it.each([
    ['a script (anonymous)', { kind: 'anonymous', name: 'Someone' }],
    ['Nebula itself (system)', { kind: 'system', name: 'Nebula' }],
    ['no writer recorded', null],
  ])('a stop by %s: the neutral stop line', async (_who, writer) => {
    const h = backend(S3);
    const quiet = busyCodex(h, writer);
    typeIn('s1', 'p1');
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    const line = '“Opening” kept changing, so your changes aren’t saved yet. Nebula will try again when it stops.';
    expect(unsaved()).toBe(line);
    expect(stopLineOf('n1')).toBe(line);
    expect(toast()).toBeNull();
    quiet();
  });
});

describe('L-2 (GM r16, r20 answer 3): what the quiet try says when it is refused', () => {
  // GM #198 r12 answer 1 (round 13) changed this: a stopped save's quiet try
  // refused 400 or 413 speaks once and stops; graphStore.fix13 pins it.

  it('a server failure stays quiet (unchanged)', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    const saidBefore = [...said];
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(QUIET + 80);
    expect(h.puts.length).toBe(before + 1);
    expect(said).toEqual(saidBefore);
    expect(unsaved()).toBe(STOPPED);
  });

  it('404, Codex deleted the scene: said once, by name; nothing more is sent; the delete undone, the save picks back up', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.failNext(0);
    // Codex changes s2 (the evidence that starts the quiet stretch), then
    // deletes the node before the try; its sync is late.
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT, false);
    await sleep(QUIET + 80);
    const LINE = 'Codex deleted “Opening”, so your changes to it can’t be saved.';
    expect(h.puts.length).toBe(before + 1);
    expect(h.puts.at(-1)!.status).toBe(404);
    expect(said.filter((line) => line === LINE)).toHaveLength(1);
    expect(toast()?.retryScene).toBeUndefined();
    expect(stopLineOf('n1')).toBeNull();
    // The delete's sync: no second line.
    h.emit(AGENT);
    await sleep(30);
    expect(nodeOf('n1')).toBeUndefined();
    expect(said.filter((line) => /deleted/.test(line))).toEqual([LINE]);
    await sleep(QUIET * 3);
    expect(h.puts.length).toBe(before + 1);
    // Undone from the Agent log: the scene comes back as it was, and the
    // person's edit is saved onto it, with no new line.
    h.restore();
    await vi.waitFor(() => expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex', 's3:c']), { timeout: 3000, interval: 5 });
    expect(brief()).toEqual(['s1:mine', 's2:codex', 's3:c']);
    expect(said.filter((line) => /deleted/.test(line))).toEqual([LINE]);
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
  });

  it.each([
    ['Codex', { kind: 'agent', name: 'Codex' }, AGENT, 'Codex deleted “Opening”, so your changes to it can’t be saved.'],
    ['the person’s other tab', { kind: 'person', name: 'You' }, WINDOW, '“Opening” was deleted in another window, so your changes to it can’t be saved.'],
    ['a writer nobody knows', { kind: 'anonymous', name: 'Someone' }, UNKNOWN, '“Opening” was deleted, so your changes to it can’t be saved.'],
  ])('the delete’s sync comes first (%s): said once, by who; restored, the save resumes', async (_who, by, origin, line) => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([60]);
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(20);
    expect(unsaved()).toBe(RETRYING);
    said = [];
    useGraphStore.setState({ notify: (text: string) => { said.push(text); } } as never);
    h.remove(by, origin);
    await sleep(150);
    expect(nodeOf('n1')).toBeUndefined();
    // GM r21 answer 3 (round 13): Codex's delete is one toast, its line with
    // Codex's [Undo]; another window or a script brings no toast, so the
    // line shows on its own.
    if (by.kind === 'agent') {
      expect(said).toEqual([]);
      expect(toast()?.text).toBe(line);
      expect((toast() as unknown as { offer: string }).offer).toBe('undo');
    } else expect(said).toEqual([line]);
    const puts = h.puts.length;
    await sleep(150);
    expect(h.puts.length).toBe(puts);
    h.restore(origin);
    await vi.waitFor(() => expect(h.backendBrief()[0]).toBe('s1:mine'), { timeout: 3000, interval: 5 });
    expect(said).toEqual(by.kind === 'agent' ? [] : [line]);
  });

  it('a scene deleted with nothing unsaved: no line (the delete’s own toast is the canvas’s)', async () => {
    const h = backend(S3);
    typeIn('s1', 'saved');
    await vi.waitFor(() => expect(h.backendBrief()[0]).toBe('s1:saved'), { timeout: 3000, interval: 5 });
    await sleep(30);
    said = [];
    useGraphStore.setState({ notify: (text: string) => { said.push(text); } } as never);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await sleep(40);
    expect(said.filter((line) => /deleted/.test(line))).toEqual([]);
  });

  it('workspace moved: no line of the scene’s own, nothing more sent, the edits still count as unsaved (the switch says it once)', async () => {
    const h = backend(S3);
    h.refuseNext(409, { detail: 'This canvas is out of date. Open the current project before editing or running it.',
      code: 'workspace_moved', project: { id: 'B', name: 'Moodboards' }, switchedBy: { kind: 'agent', name: 'Codex' } });
    const toasts = watchToasts();
    typeIn('s1', 'mine');
    await sleep(150);
    toasts.off();
    expect(h.puts.length).toBe(1);
    expect(said).toEqual([]);
    expect(saveLines(toasts.lines)).toEqual([]);
    expect(unsaved()).toBeNull();
    expect(store.hasUnsavedSceneEdits()).toBe(true);
    // A quiet stretch or a reconnect sends nothing to the moved canvas.
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await sleep(QUIET * 2);
    expect(h.puts.length).toBe(1);
  });
});

describe('L-4 (review 11, probe B1): two quick restarts never freeze the card', () => {
  it('a late health answer from the short-lived middle process doesn’t retire the newest one', async () => {
    const h = backend(S3);
    h.emit({ bootId: 'boot-a', bootStartedAt: 1_000 });
    await sleep(10);
    h.emit({ bootId: 'boot-c', bootStartedAt: 3_000 }); // the newest process's hello
    await sleep(10);
    noteBackendBootId('boot-b', 2_000); // a late health answer from the middle one
    h.other((shots) => setPrompt(shots, 's2', 'after'), 'agent'); // a broadcast on boot-c's socket
    await sleep(20);
    expect(brief()).toEqual(['s1:a', 's2:after', 's3:c']);
    h.emit({ bootId: 'boot-c', bootStartedAt: 3_000 });
    await sleep(20);
    expect(brief()).toEqual(['s1:a', 's2:after', 's3:c']);
    // The middle process's own late sync is dropped.
    deliver({ type: 'graphSync', ...base, bootId: 'boot-b', bootStartedAt: 2_000, canvasRevision: 'c1', empty: false,
      nodes: [cinema(S3), editNode('n2', 'Edit A')], edges: [], sceneKeys: { n1: 'old' }, sceneRevs: { n1: 1 } });
    await sleep(20);
    expect(brief()).toEqual(['s1:a', 's2:after', 's3:c']);
  });

  it('a health answer that doesn’t say when it started (an older backend) is older than one that does', async () => {
    const h = backend(S3);
    h.emit({ bootId: 'boot-a', bootStartedAt: 1_000 });
    h.emit({ bootId: 'boot-c', bootStartedAt: 3_000 });
    await sleep(10);
    noteBackendBootId('boot-b');
    h.other((shots) => setPrompt(shots, 's2', 'after'), 'agent');
    await sleep(20);
    expect(brief()).toEqual(['s1:a', 's2:after', 's3:c']);
  });

  it('a newer process still takes over (a real restart)', async () => {
    const h = backend(S3);
    h.emit({ bootId: 'boot-a', bootStartedAt: 1_000 });
    await sleep(10);
    noteBackendBootId('boot-d', 4_000);
    // A late broadcast on boot-a's socket is the old process's: dropped.
    h.state.shots = setPrompt(h.state.shots, 's2', 'old process');
    h.emit({});
    await sleep(20);
    expect(brief()[1]).toBe('s2:b');
    h.emit({ bootId: 'boot-d', bootStartedAt: 4_000 });
    await sleep(20);
    expect(brief()[1]).toBe('s2:old process');
  });
});
