import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 14 (GM r22), on round 12's keyed backend in small
 * (graphStore.fix12's harness, as fix13 uses it):
 * - Q3: one line per status everywhere: a save that wasn't stopped, refused
 *   400 or 413, says GM's line once with [Try again] and waits for the
 *   person, as a stopped one does. No line promises a retry.
 * - Q1: with the "Unsaved" mark's popover open, the toast with the same line
 *   and [Try again] leaves and doesn't come back; a line that comes while it
 *   is open shows only there.
 * - Notes 1 and 3: "Codex changed the canvas." ends with its period; a write
 *   that deleted the scene and did more is one sentence.
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
const QUIET = 80;
const stopped = () => useGraphStore.getState().stoppedScenes;
const toast = () => (useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null }).undoNotice;


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
// GM r28 item 2 (round 19): the stop lines are a state, in their own slot.
const stopTexts = (state: unknown) => store.sceneStopLines(state as Parameters<typeof store.sceneStopLines>[0]).map((line) => line.text);
/** Both notice slots' lines, and the state slot's, from now on (a line
 * beside an undo offer goes in the message slot). */
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
function watchLog() {
  const lines: string[] = [];
  const on = (event: Event) => { lines.push(String((event as CustomEvent<{ message: string }>).detail.message)); };
  window.addEventListener('nebula:agent-log-entry', on);
  return { lines, off: () => window.removeEventListener('nebula:agent-log-entry', on) };
}

const copy = await import('../../src/lib/sceneSaveCopy');

const clashes14 = () => useGraphStore.getState().sceneClashes as Record<string, { line: string; focus?: true }>;
const briefOf = () => (((useGraphStore.getState().nodes.find((n: { id: string }) => n.id === 'n1')?.data.params.scene) as { shots: Shot[] } | undefined)
  ?.shots ?? []).map((s) => `${s.id}:${s.prompt}`);
const slots = () => {
  const g = useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null;
    messageNotice: { text: string; retryScene?: { nodeId: string } } | null };
  return [g.undoNotice, g.messageNotice].filter((notice): notice is { text: string; retryScene?: { nodeId: string } } => Boolean(notice));
};
// GM r28 item 2 (round 19): the stop line with [Try again] is in the state
// slot now; the event slots never carry it.
const retryToasts = () => store.sceneStopLines(useGraphStore.getState()).filter((line) => line.nodeIds.includes('n1'))
  .map((line) => ({ text: line.text, retryScene: { nodeId: 'n1' } }));

describe('GM r22 Q3: one line per status, a save that wasn’t stopped too', () => {
  it.each([
    ['400', 400, { detail: 'params.scene nested too deeply', code: 'bad_params' }, CANT, 'HTTP 400 bad_params'],
    ['413', 413, { detail: 'Project snapshot exceeds the 16 MiB limit', limit: 'size' }, TOO_BIG, 'HTTP 413'],
  ])('%s on an ordinary save: GM’s line once, with [Try again]; never a retry by itself; the Agent log has the status', async (_what, status, body, line, logged) => {
    const h = backend(S3);
    const log = watchLog();
    const lines = watchSlots();
    h.refuseNext(status, body);
    typeIn('s1', 'mine');
    await vi.waitFor(() => expect(unsaved()).toBe(line), { timeout: 3000, interval: 5 });
    expect(h.puts.at(-1)!.status).toBe(status);
    expect(retryToasts().map((notice) => notice.text)).toEqual([line]);
    expect(stopped()).toEqual({ n1: true });
    expect(line).not.toMatch(/will try again|will save|HTTP|\d{3}/);
    expect(log.lines.some((entry) => entry.includes(logged) && entry.includes('“Opening”'))).toBe(true);
    log.off();
    // Nothing goes by itself: no timed retry, no quiet try on another
    // writer's change, no reconnect send; nothing is said again.
    const puts = h.puts.length;
    h.other((shots) => setPrompt(shots, 's3', 'codex'), 'agent');
    await sleep(QUIET * 3);
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await sleep(60);
    lines.off();
    expect(h.puts.length).toBe(puts);
    expect(lines.lines.filter((text) => text === line)).toEqual([line]);
    // [Try again] sends it.
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b', 's3:codex']);
  });

  it('the person’s next change sends it', async () => {
    const h = backend(S3);
    h.refuseNext(400, { detail: 'bad', code: 'bad_params' });
    typeIn('s1', 'mine');
    await vi.waitFor(() => expect(unsaved()).toBe(CANT), { timeout: 3000, interval: 5 });
    typeIn('s2', 'and more');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:and more', 's3:c']);
  });

  it('no 400 or 413 line anywhere promises a retry', () => {
    for (const line of [copy.sceneCantSaveLine('Opening'), copy.sceneTooBigToSaveLine('Opening')]) {
      // GM's 413 line asks the person to try again; neither says Nebula will.
      expect(line).not.toMatch(/will try|will save|Nebula will/i);
    }
    expect(copy).not.toHaveProperty('BAD_SAVE');
    expect(copy).not.toHaveProperty('SCENE_TOO_BIG');
    expect(copy).not.toHaveProperty('sceneTooBigLine');
  });
});

describe('GM r22 Q1: the popover open, the matching toast steps aside', () => {
  // GM r28 item 2 (round 19) changed "closing brings none back": a stop line
  // is a state, so it is back once the popover closes.
  it('opening the popover takes the line and [Try again] away; closing it brings the line back (a state, GM r28)', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    store.noteScenePopover('n1', true);
    expect(retryToasts()).toEqual([]);
    store.noteScenePopover('n1', false);
    await sleep(40);
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    expect(unsaved()).toBe(STOPPED);
  });

  it('beside an agent’s Undo (the message slot) too, and the agent’s toast stays', async () => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([5]);
    h.failNext(1000);
    typeIn('s1', 'mine');
    await sleep(5);
    h.other((shots) => setPrompt(shots, 's3', 'codex'), 'agent');
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(retryToasts().length).toBe(1), { timeout: 3000, interval: 5 });
    const agentToast = toast()?.text;
    store.noteScenePopover('n1', true);
    expect(retryToasts()).toEqual([]);
    expect(toast()?.text).toBe(agentToast);
    store.noteScenePopover('n1', false);
  });

  // GM r28 item 2 (round 19): the line is a state; it shows in the state slot
  // once the popover closes (it was never said as a toast before).
  it('a line that comes while the popover is open shows only there; closed, it is the state slot’s line', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    store.noteScenePopover('n1', true);
    h.failNext(0);
    h.refuseNext(413, { detail: 'too big', limit: 'size' });
    const lines = watchSlots();
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await vi.waitFor(() => expect(unsaved()).toBe(TOO_BIG), { timeout: 3000, interval: 5 });
    await sleep(30);
    expect(retryToasts()).toEqual([]);
    expect(lines.lines.filter((line) => line === TOO_BIG)).toEqual([]);
    store.noteScenePopover('n1', false);
    await sleep(40);
    lines.off();
    expect(lines.lines.filter((line) => line === TOO_BIG)).toEqual([TOO_BIG]);
    expect(retryToasts().map((notice) => notice.text)).toEqual([TOO_BIG]);
  });

  it('another scene’s toast is left alone', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    store.noteScenePopover('n9', true);
    expect(retryToasts().map((notice) => notice.text)).toEqual([STOPPED]);
    store.noteScenePopover('n9', false);
  });
});

describe('GM r22 notes 1 and 3: the agent’s toast is a sentence', () => {
  it('"Codex changed the canvas." ends with its period, at the source', async () => {
    const h = backend(S3);
    h.other((shots) => setPrompt(shots, 's3', 'codex'), 'agent');
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex changed the canvas.'), { timeout: 3000, interval: 5 });
    const { editArrivedText } = await import('../../src/lib/canvasUndo');
    expect(editArrivedText({ source: 'agent', agentName: 'Codex', undoes: 'ed_x' } as never)).toBe('Codex undid its edit.');
  });

  it('a write that deleted two scenes and did more: one sentence naming both', () => {
    expect(copy.sceneChangedAndDeletedLine('Codex', ['Opening'])).toBe('Codex changed the canvas and deleted “Opening”, so your changes to it can’t be saved.');
    expect(copy.sceneChangedAndDeletedLine('Codex', ['Opening', 'Finale']))
      .toBe('Codex changed the canvas and deleted “Opening” and “Finale”, so your changes to them can’t be saved.');
  });
});

/** The backend's POST /api/graph/restore, in small: the node back with the
 * params the restore sent, then its own echo (this tab's). */
function withRestore(h: ReturnType<typeof backend>) {
  const inner = fetchMock.getMockImplementation()!;
  const restores: { nodes: { id: string; params?: { scene?: { shots: Shot[] } } }[] }[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/api/graph/restore')) {
      const body = JSON.parse(String(init.body));
      restores.push(body);
      const item = body.nodes.find((node: { id: string }) => node.id === 'n1');
      if (item) {
        h.state.deleted = false;
        if (item.params?.scene?.shots) h.state.shots = clone(item.params.scene.shots);
        h.state.rev = (revisionCounter += 1);
        h.state.writer = { kind: 'person', name: 'You' };
      }
      h.emit(OWN());
      await sleep(2);
      return json({ ok: true });
    }
    return inner(url, init);
  });
  return restores;
}

const CLASH14 = 'Codex changed “Opening” while you were editing it.';
const DELETED14 = 'Codex deleted “Opening”, so your changes to it can’t be saved.';

describe('review 13 LOW-1 (GM r23 answer 2): the delete toast’s own [Undo] asks a waiting clash again', () => {
  async function clashThenDelete(h: ReturnType<typeof backend>) {
    store.setSceneRetryDelaysForTests([40]);
    h.failNext(1000);
    typeIn('s1', 'mine');
    await sleep(20);
    h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent');
    await vi.waitFor(() => expect(clashes14().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await sleep(60);
    expect(clashes14()).toEqual({});
    expect(toast()?.text).toBe(DELETED14);
    h.failNext(0);
  }

  it('[Undo] puts back the scene Nebula had (Codex’s), not the card; the clash is asked again in the toast’s place', async () => {
    const h = backend(S3);
    const restores = withRestore(h);
    await clashThenDelete(h);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(clashes14().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    // The restore carried Nebula's scene: the Undo restores, it doesn't choose.
    expect(restores[0].nodes.find((node) => node.id === 'n1')?.params?.scene?.shots.find((shot) => shot.id === 's1')?.prompt).toBe('codex s1');
    expect(clashes14().n1.line).toBe(CLASH14);
    expect(clashes14().n1.focus).toBe(true);
    // The person's value on the card, Codex's on the backend, until they choose.
    expect(briefOf()[0]).toBe('s1:mine');
    await sleep(60);
    expect(h.backendBrief()[0]).toBe('s1:codex s1');
    // Never both: the delete toast and the Undo's own line are gone.
    expect(slots().map((notice) => notice.text).filter((text) => /deleted|Undid/.test(text))).toEqual([]);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await vi.waitFor(() => expect(h.backendBrief()[0]).toBe('s1:mine'), { timeout: 3000, interval: 5 });
  });

  it('Use Codex’s after that [Undo] keeps Codex’s value', async () => {
    const h = backend(S3);
    withRestore(h);
    await clashThenDelete(h);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(clashes14().n1).toBeTruthy(), { timeout: 3000, interval: 5 });
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await vi.waitFor(() => expect(store.hasUnsavedSceneEdits()).toBe(false), { timeout: 3000, interval: 5 });
    expect(briefOf()[0]).toBe('s1:codex s1');
    expect(h.backendBrief()[0]).toBe('s1:codex s1');
  });

  it('no clash waiting: [Undo] brings it back as Nebula had it and the person’s edits save onto it, unasked', async () => {
    const h = backend(S3);
    const restores = withRestore(h);
    store.setSceneRetryDelaysForTests([40]);
    h.failNext(1000);
    typeIn('s2', 'mine on s2');
    await sleep(20);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT);
    await sleep(60);
    h.failNext(0);
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(h.backendBrief()[1]).toBe('s2:mine on s2'), { timeout: 3000, interval: 5 });
    expect(restores[0].nodes.find((node) => node.id === 'n1')?.params?.scene?.shots.find((shot) => shot.id === 's2')?.prompt).toBe('b');
    expect(clashes14()).toEqual({});
  });
});

describe('review 13 LOW-2 (GM r23 answer 1): a refused [Try again] or edit stays stopped for good', () => {
  it.each([
    ['400', 400, { detail: 'bad', code: 'bad_params' }, CANT],
    ['413', 413, { detail: 'too big', limit: 'size' }, TOO_BIG],
  ])('%s: [Try again] refused again keeps the same line, [Try again] in the toast and the popover; Codex’s writes send nothing', async (_what, status, body, line) => {
    const h = backend(S3);
    h.refuseNext(status, body);
    typeIn('s1', 'mine');
    await vi.waitFor(() => expect(unsaved()).toBe(line), { timeout: 3000, interval: 5 });
    h.refuseNext(status, body);
    const lines = watchSlots();
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(h.puts.at(-1)!.status).toBe(status), { timeout: 3000, interval: 5 });
    await sleep(30);
    expect(h.puts.filter((put) => put.status === status)).toHaveLength(2);
    expect(unsaved()).toBe(line);
    expect(stopped()).toEqual({ n1: true });
    expect(retryToasts().map((notice) => notice.text)).toEqual([line]);
    const puts = h.puts.length;
    h.other((shots) => setPrompt(shots, 's3', 'codex 1'), 'agent');
    await sleep(QUIET * 2);
    h.other((shots) => setPrompt(shots, 's3', 'codex 2'), 'agent');
    await sleep(QUIET * 3);
    lines.off();
    expect(h.puts.length).toBe(puts);
    expect(unsaved()).toBe(line);
    expect(lines.lines.every((text) => text === line || /Codex changed the canvas\./.test(text))).toBe(true);
  });

  it('413: an edit refused again stays for good, the same line, never the first-refusal copy; Codex sends nothing', async () => {
    const h = backend(S3);
    h.refuseNext(413, { detail: 'too big', limit: 'size' });
    typeIn('s1', 'mine');
    await vi.waitFor(() => expect(unsaved()).toBe(TOO_BIG), { timeout: 3000, interval: 5 });
    h.refuseNext(413, { detail: 'too big', limit: 'size' });
    typeIn('s2', 'still too big');
    await vi.waitFor(() => expect(h.puts.at(-1)!.status).toBe(413), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    expect(unsaved()).toBe(TOO_BIG);
    expect(slots().map((notice) => notice.text).join(' ')).not.toMatch(/project is too big|will save/);
    const puts = h.puts.length;
    h.other((shots) => setPrompt(shots, 's3', 'codex'), 'agent');
    await sleep(QUIET * 3);
    expect(h.puts.length).toBe(puts);
  });
});
