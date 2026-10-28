import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 10 (review 9; GM r14, r15), against round 9's keyed
 * backend in small (graphStore.fix9.test.ts's harness):
 * - M-2: a save another writer refuses 20 times in a row stops, never
 *   silently: "Unsaved" with GM's stopped line and [Try again]; the next
 *   change or [Try again] sends it.
 * - L-1: the revisions the tab has seen belong to one backend process; a
 *   restart (a new bootId) forgets them, so a clock that went back can't
 *   freeze the card.
 * - M-3 (GM r14: the bar follows the card): a scene's unsaved edits count
 *   as unsaved for the page: hasUnsavedSceneEdits, and closing the tab asks.
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
    writer: null as null | { kind: string; name: string }, rev: (revisionCounter += 1) };
  const keyOf = () => JSON.stringify(state.shots.map((s) => [s.id, s.prompt]));
  const snapshot = () => ({ nodes: [cinema(state.shots), ...state.nodes], edges: clone(state.edges),
    sceneKeys: { n1: keyOf() }, sceneRevs: { n1: state.rev } });
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
  };
}
const typeIn = (shotId: string, prompt: string) => useGraphStore.getState().updateScene('n1', (current: { shots: Shot[] }) => ({ ...current,
  shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, prompt } : shot)) }));
const setPrompt = (shots: Shot[], id: string, prompt: string) => shots.map((s) => (s.id === id ? { ...s, prompt } : s));
const S3 = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }, { id: 's3', prompt: 'c' }];


const STOPPED = 'Couldn’t save your changes to “Opening”. They’re kept and Nebula will try again with your next change.';
const offersRetry = () => {
  const state = useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null };
  return state.undoNotice?.text === STOPPED && state.undoNotice.retryScene?.nodeId === 'n1';
};

describe('M-2: a save another writer keeps refusing stops, never silently', () => {
  /** Codex commits during each of the tab's saves (the reviewer's R4: no
   * clock tricks), so every save is refused as changed. */
  function busyAgent(times = 1000) {
    const h = backend(S3);
    let k = 0;
    h.onPut(async () => { k += 1; if (k <= times) h.other((shots) => setPrompt(shots, 's2', `c${k}`), 'agent'); });
    return { h, quiet: () => { k = times + 1; h.onPut(async () => {}); } };
  }

  it('R4: 21 refusals in a row, then "Unsaved" with GM’s stopped line and [Try again]; nothing more is sent', async () => {
    const { h } = busyAgent();
    typeIn('s1', 'p1');
    await sleep(400);
    expect(h.puts.length).toBe(21);
    expect(h.puts.every((put) => put.status === 409)).toBe(true);
    expect(brief()[0]).toBe('s1:p1');
    expect(h.backendBrief()[0]).toBe('s1:a');
    expect(unsaved()).toBe(STOPPED);
    expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
    expect(offersRetry()).toBe(true);
    expect(store.hasUnsavedSceneEdits()).toBe(true);
    await sleep(150);
    expect(h.puts.length).toBe(21);
  });

  it('the next change sends it again, and it saves once the agent is done', async () => {
    const { h, quiet } = busyAgent();
    typeIn('s1', 'p1');
    await sleep(400);
    expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
    quiet();
    typeIn('s1', 'p2');
    await sleep(150);
    expect(h.backendBrief()[0]).toBe('s1:p2');
    expect(brief()[0]).toBe('s1:p2');
    expect(unsaved()).toBeNull();
    expect(useGraphStore.getState().stoppedScenes).toEqual({});
    expect(store.hasUnsavedSceneEdits()).toBe(false);
  });

  it('[Try again] sends it again; a writer that keeps refusing stops it again, after another 20', async () => {
    const { h, quiet } = busyAgent();
    typeIn('s1', 'p1');
    await sleep(400);
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(400);
    expect(h.puts.length).toBe(42);
    expect(unsaved()).toBe(STOPPED);
    expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
    quiet();
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(150);
    expect(h.backendBrief()[0]).toBe('s1:p1');
    expect(unsaved()).toBeNull();
  });

  it('after the stop, Codex keeps writing: its changes show on the card, the edits stay "Unsaved", nothing goes until [Try again]', async () => {
    const { h, quiet } = busyAgent();
    typeIn('s1', 'p1');
    await sleep(400);
    quiet();
    for (let j = 0; j < 4; j += 1) { h.other((shots) => setPrompt(shots, 's2', `late${j}`), 'agent'); await sleep(30); }
    await sleep(150);
    expect(brief()).toEqual(['s1:p1', 's2:late3', 's3:c']);
    expect(h.puts.length).toBe(21);
    expect(unsaved()).toBe(STOPPED);
    expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(120);
    expect(h.backendBrief()).toEqual(['s1:p1', 's2:late3', 's3:c']);
    expect(unsaved()).toBeNull();
  });

  it('fewer than 20 refusals in a row: it saves by itself, with no line', async () => {
    const { h } = busyAgent(5);
    typeIn('s1', 'p1');
    await sleep(200);
    expect(h.puts.map((put) => put.status)).toEqual([409, 409, 409, 409, 409, 200]);
    expect(h.backendBrief()[0]).toBe('s1:p1');
    expect(unsaved()).toBeNull();
    expect(said).toEqual([]);
  });
});

describe('L-1: a restart forgets the revisions the tab has seen', () => {
  it('R2: a new bootId with a clock that went back: the card takes the new process’s scene, then its edits, and saves', async () => {
    revisionCounter = 5_000_000;
    const h = backend(S3);
    h.emit({ bootId: 'boot-1' });
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c1', 's3:c']);
    // The new process: its clock is behind the old one's revisions.
    revisionCounter = 10;
    h.state.shots = setPrompt(h.state.shots, 's3', 'c2');
    h.state.rev = (revisionCounter += 1);
    h.emit({ bootId: 'boot-2' });
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c1', 's3:c2']);
    h.other((shots) => setPrompt(shots, 's2', 'c3'), 'agent');
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c3', 's3:c2']);
    typeIn('s1', 'p1');
    await sleep(120);
    expect(h.puts.map((put) => put.status)).toEqual([200]);
    expect(h.backendBrief()).toEqual(['s1:p1', 's2:c3', 's3:c2']);
    expect(unsaved()).toBeNull();
  });

  it('the label and outputs on a later sync of the new process reach the card too', async () => {
    revisionCounter = 6_000_000;
    const h = backend(S3);
    h.emit({ bootId: 'boot-1' });
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    await sleep(10);
    revisionCounter = 20;
    h.state.rev = (revisionCounter += 1);
    h.emit({ bootId: 'boot-2' });
    await sleep(10);
    const node = cinema(h.state.shots) as { data: Record<string, unknown> };
    node.data.label = 'Renamed by agent';
    node.data.outputs = { shot_s1: { type: 'Image', value: 'http://x/a.png' } };
    deliver({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, nodes: [node, editNode('n2', 'Edit A')], edges: [],
      sceneKeys: { n1: h.keyOf() }, sceneRevs: { n1: h.state.rev }, ...AGENT });
    await sleep(10);
    expect(nodeOf('n1')?.data.label).toBe('Renamed by agent');
    expect(nodeOf('n1')?.data.outputs).toEqual({ shot_s1: { type: 'Image', value: 'http://x/a.png' } });
  });

  it('the same process: a sync below what the tab has is still dropped (H-1 holds)', async () => {
    revisionCounter = 7_000_000;
    const h = backend(S3);
    h.emit({ bootId: 'boot-1' });
    const old = { type: 'graphSync', ...base, bootId: 'boot-1', canvasRevision: 'c1', empty: false, nodes: [cinema(S3), editNode('n2', 'Edit A')],
      edges: [], sceneKeys: { n1: h.keyOf() }, sceneRevs: { n1: h.state.rev } };
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    await sleep(10);
    deliver(old);
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c1', 's3:c']);
  });
});

describe('M-3: a scene card’s unsaved edits count for the page', () => {
  it('closing the tab asks while a scene is stopped, and not once it saved', async () => {
    const { subscribeProjectAutosave } = await import('../../src/store/projectStore');
    const unsubscribe = subscribeProjectAutosave();
    const prompts = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      store.setSceneRetryDelaysForTests([5]);
      const h = backend();
      expect(prompts()).toBe(false);
      h.failNext(1000);
      typeIn('s1', 'mine');
      await sleep(200);
      expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
      expect(prompts()).toBe(true);
      h.failNext(0);
      useGraphStore.getState().retrySceneSave('n1');
      await sleep(60);
      expect(unsaved()).toBeNull();
      expect(prompts()).toBe(false);
    } finally {
      unsubscribe();
    }
  });
});
