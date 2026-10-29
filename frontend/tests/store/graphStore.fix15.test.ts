import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 15 (GM r24), on round 12's keyed backend in small
 * (graphStore.fix14's harness):
 * - Answer 1: an agent's undo that deleted the scene the person has unsaved
 *   changes to is one toast, one sentence, however much else it undid:
 *   "Codex undid its edit and deleted “Opening”, so your changes to it can’t
 *   be saved." It keeps the toast's own [Undo].
 * - Answer 2: the person's Undo on an agent's toast reads "Undid Codex’s
 *   edit." with its period; a count after it joins with one period.
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

const toast = () => (useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null }).undoNotice;

const AGENT_UNDO = { edit: { id: 'ed_agent_undo', actor: { kind: 'agent', name: 'Codex' }, undoes: 'ed_agent' } };
const offer = () => (useGraphStore.getState() as unknown as { undoNotice: { offer?: string } | null }).undoNotice?.offer;
const ONE_SENTENCE = 'Codex undid its edit and deleted “Opening”, so your changes to it can’t be saved.';

describe('GM r24 answer 1: an agent’s undo that deleted the scene is one sentence', () => {
  it.each([
    ['only deleted the scene', false],
    ['undid more besides', true],
  ])('Codex’s undo %s: one toast, one sentence, with its [Undo]; no second line', async (_what, more) => {
    const h = backend(S3);
    store.setSceneRetryDelaysForTests([60]);
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(20);
    said = [];
    if (more) h.state.nodes = [editNode('n2', 'Edit B')];
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT_UNDO);
    await vi.waitFor(() => expect(toast()?.text).toBe(ONE_SENTENCE), { timeout: 3000, interval: 5 });
    expect(offer()).toBe('undo');
    expect(useGraphStore.getState().messageNotice).toBeNull();
    expect(said).toEqual([]);
  });

  it('two scenes: “A” and “B”, "to them"', async () => {
    const copy = await import('../../src/lib/sceneSaveCopy');
    expect(copy.sceneUndidAndDeletedLine('Codex', ['Opening', 'Finale']))
      .toBe('Codex undid its edit and deleted “Opening” and “Finale”, so your changes to them can’t be saved.');
  });

  it('nothing unsaved: the toast stays Codex’s own "Codex undid its edit."', async () => {
    const h = backend(S3);
    await sleep(20);
    h.remove({ kind: 'agent', name: 'Codex' }, AGENT_UNDO);
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex undid its edit.'), { timeout: 3000, interval: 5 });
  });
});

describe('GM r24 answer 2: "Undid Codex’s edit." with its period', () => {
  it('every form of the person’s Undo and Redo line is a sentence', async () => {
    const { undoNoticeText } = await import('../../src/lib/canvasUndo');
    const agent = { kind: 'foreign', source: 'agent', agentName: 'Codex' } as never;
    expect(undoNoticeText('undo', agent)).toBe('Undid Codex’s edit.');
    expect(undoNoticeText('redo', agent)).toBe('Redid Codex’s edit.');
    expect(undoNoticeText('undo', { kind: 'foreign', source: 'window', agentName: null } as never)).toBe('Undid an edit from another window.');
    expect(undoNoticeText('undo', { kind: 'foreign', source: 'unknown', agentName: null } as never)).toBe('Undid an edit made outside Nebula.');
  });

  it('pressing Undo on Codex’s toast: "Undid Codex’s edit." with Redo', async () => {
    const h = backend(S3);
    h.other((shots) => setPrompt(shots, 's3', 'codex'), 'agent');
    await vi.waitFor(() => expect(toast()?.text).toBe('Codex changed the canvas.'), { timeout: 3000, interval: 5 });
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(toast()?.text).toBe('Undid Codex’s edit.'), { timeout: 3000, interval: 5 });
    expect(offer()).toBe('redo');
  });
});
