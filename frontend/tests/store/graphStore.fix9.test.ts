import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 9 (review 8; GM r12, r13), against a small keyed
 * backend that does what main.py does now: every Cinema scene has a sceneKey
 * and a sceneRev (a number that grows with each authoring), in each sync,
 * each save's answer and each 409; a save that sends an ifSceneKey Nebula no
 * longer has is refused with 409 scene_changed; an `onlyIfFree` connect into
 * a taken input is refused with 409 input_taken. The socket can hold its
 * syncs and let them out late, in order (the reviewer's lag).
 * - H-1: a sync older than what the tab already knows never rolls the card
 *   back, never clashes, never stops a save (D1, D1b, a late 409).
 * - M-3 (GM r13 answer 1): a removed shot put back while the choice waits.
 * - L-3: Keep mine's put-back connect never takes an input that holds
 *   another connection.
 * - L-4 (GM r13 answer 2): the person deletes a held connection: no request,
 *   no line, and Keep mine doesn't put it back.
 * - GM r12 item 1 / r13 answer 3: the stopped state outlives the toast.
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
const wsq = { hold: false, queue: [] as Record<string, unknown>[] };
const deliver = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };
const socketSends = (event: Record<string, unknown>) => { if (wsq.hold) wsq.queue.push(JSON.parse(JSON.stringify(event))); else deliver(event); };
const releaseOne = () => { const event = wsq.queue.shift(); if (event) deliver(event); return Boolean(event); };
const releaseAll = () => { wsq.hold = false; while (releaseOne()) { /* drain */ } };

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
const clash = () => useGraphStore.getState().sceneClashes.n1 ?? null;
const wiresNow = () => useGraphStore.getState().edges.map((e: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) =>
  `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`);
let said: string[] = [];
const AGENT = { edit: { id: 'ed_agent', actor: { kind: 'agent', name: 'Codex' } } };
const WINDOW = { edit: { id: 'ed_window', actor: { kind: 'person', name: 'You' }, tab: 'tab-other' } };
const OWN = () => ({ edit: { id: `ed_own${Math.random()}`, actor: { kind: 'person', name: 'You' }, tab: TAB_ID } });
const wire = (shot: string, target: string, handle = 'mask'): Wire => ({ id: `e-${shot}-${target}-${handle}`, type: 'typed-edge', source: 'n1',
  sourceHandle: `shot_${shot}`, target, targetHandle: handle, data: { dataType: 'Image' } });
const edgeName = (e: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) =>
  `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`;

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

describe('H-1: a sync older than what the tab knows is never merged as new', () => {
  it('D1: Codex and the window commit, their syncs lag; a 409 tells the tab; Codex\'s old sync lands while the next save is out', async () => {
    const h = backend(S3);
    wsq.hold = true;
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    h.other((shots) => setPrompt(shots, 's3', 'w1'), 'window');
    typeIn('s1', 'p1');
    await sleep(40);
    expect(h.backendBrief()).toEqual(['s1:p1', 's2:c1', 's3:w1']);
    h.onPut(async (n) => { if (n === 3) { releaseOne(); await sleep(2); } });
    typeIn('s1', 'p12');
    await sleep(60);
    // The old sync (a, c1, c) landed: the card never went back to it.
    expect(brief()).toEqual(['s1:p12', 's2:c1', 's3:w1']);
    releaseAll();
    await sleep(150);
    expect(h.backendBrief()).toEqual(['s1:p12', 's2:c1', 's3:w1']);
    expect(brief()).toEqual(['s1:p12', 's2:c1', 's3:w1']);
    expect(clash()).toBeNull();
    expect(unsaved()).toBeNull();
    expect(said).toEqual([]);
  });

  it('D1b: the person stops typing; the old sync lands while the taken save is out', async () => {
    const h = backend(S3);
    wsq.hold = true;
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    h.other((shots) => setPrompt(shots, 's3', 'w1'), 'window');
    h.onPut(async (n) => { if (n === 2) { releaseOne(); await sleep(2); } });
    typeIn('s1', 'p1');
    await sleep(60);
    expect(brief()).toEqual(['s1:p1', 's2:c1', 's3:w1']);
    releaseAll();
    await sleep(150);
    expect(brief()).toEqual(['s1:p1', 's2:c1', 's3:w1']);
    expect(h.backendBrief()).toEqual(['s1:p1', 's2:c1', 's3:w1']);
    expect(clash()).toBeNull();
    expect(said).toEqual([]);
  });

  it('a 409 older than a sync the tab already has: merged onto the newer scene, nothing lost', async () => {
    const h = backend(S3);
    // Codex commits while our save is out; its 409 answer is slow, and the
    // window's later commit reaches the tab first.
    h.onPut(async (n) => { if (n === 1) h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent'); });
    h.beforeAnswer(async (n) => {
      if (n !== 1) return;
      h.other((shots) => setPrompt(shots, 's3', 'w1'), 'window');
      await sleep(10);
    });
    typeIn('s1', 'p1');
    await sleep(120);
    expect(h.backendBrief()).toEqual(['s1:p1', 's2:c1', 's3:w1']);
    expect(brief()).toEqual(['s1:p1', 's2:c1', 's3:w1']);
    expect(clash()).toBeNull();
    expect(said).toEqual([]);
  });

  it('every sync from the backend says its revision; one below what the tab has is dropped whole for the scene', async () => {
    const h = backend(S3);
    const old = { type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, nodes: [cinema(S3), editNode('n2', 'Edit A')], edges: [],
      sceneKeys: { n1: h.keyOf() }, sceneRevs: { n1: h.state.rev } };
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c1', 's3:c']);
    deliver(old);
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c1', 's3:c']);
    expect(h.puts).toEqual([]);
  });
  it('a scene the card first sees: its revision is noted, so an older sync after it is dropped too', async () => {
    const h = backend(S3);
    const older = { type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, nodes: [cinema(S3), editNode('n2', 'Edit A')], edges: [],
      sceneKeys: { n1: h.keyOf() }, sceneRevs: { n1: h.state.rev } };
    // The card loses the node (a fresh canvas view), then the newer sync brings it first.
    useGraphStore.setState({ nodes: [], edges: [] } as never);
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c1', 's3:c']);
    deliver(older);
    await sleep(10);
    expect(brief()).toEqual(['s1:a', 's2:c1', 's3:c']);
  });
});

describe('M-3 (GM r13 answer 1): a removed shot put back while the choice waits', () => {
  async function removed(who: 'agent' | 'window') {
    const h = backend(undefined, { edges: [wire('s2', 'n2')] });
    h.failNext(1);
    typeIn('s2', 'mine');
    await sleep(15);
    h.other((shots) => shots.filter((s) => s.id !== 's2'), who);
    await sleep(30);
    said = [];
    return h;
  }

  for (const who of ['agent', 'window'] as const) {
    it(`${who}: back as it was: mine wins silently, saved, no prompt`, async () => {
      const h = await removed(who);
      expect(clash()).not.toBeNull();
      h.other((shots) => [...shots, { id: 's2', prompt: 'b' }], who);
      await sleep(120);
      expect(clash()).toBeNull();
      expect(brief()).toEqual(['s1:a', 's2:mine']);
      expect(h.backendBrief()).toEqual(['s1:a', 's2:mine']);
      expect(unsaved()).toBeNull();
      expect(said).toEqual([]);
    });
  }

  it('back with other text: the field line names the shot; one prompt, its line replaced', async () => {
    const h = await removed('agent');
    expect(clash()?.line).toBe('Codex removed “Shot 2” while you were editing it.');
    h.other((shots) => [...shots, { id: 's2', prompt: 'codex re-added' }]);
    await sleep(60);
    expect(clash()?.line).toBe('Codex changed “Shot 2” while you were editing it.');
    expect(Object.keys(useGraphStore.getState().sceneClashes)).toEqual(['n1']);
    expect(brief()).toEqual(['s1:a', 's2:mine']);
    expect(unsaved()).toBe('Codex changed “Shot 2” while you were editing it.');
    expect(h.backendBrief()).toEqual(['s1:a', 's2:codex re-added']);
  });

  it('back with other text, Keep mine: the person\'s text is saved', async () => {
    const h = await removed('agent');
    h.other((shots) => [...shots, { id: 's2', prompt: 'codex re-added' }]);
    await sleep(60);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.backendBrief()).toEqual(['s1:a', 's2:mine']);
    expect(brief()).toEqual(['s1:a', 's2:mine']);
    expect(clash()).toBeNull();
  });

  it('back with other text, Use Codex’s: the re-added text', async () => {
    const h = await removed('agent');
    h.other((shots) => [...shots, { id: 's2', prompt: 'codex re-added' }]);
    await sleep(60);
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await sleep(80);
    expect(brief()).toEqual(['s1:a', 's2:codex re-added']);
    expect(h.backendBrief()).toEqual(['s1:a', 's2:codex re-added']);
    expect(clash()).toBeNull();
    expect(unsaved()).toBeNull();
  });
});

describe('the held connections (L-3, L-4; GM r13 answer 2)', () => {
  async function removedClash(edges: Wire[] = [wire('s2', 'n2')]) {
    const h = backend(undefined, { edges });
    h.failNext(1);
    typeIn('s2', 'mine');
    await sleep(15);
    h.other((shots) => shots.filter((s) => s.id !== 's2'));
    await sleep(30);
    said = [];
    return h;
  }

  it('L-3: Codex wired its own shot into the single input, its sync late: Keep mine asks onlyIfFree, and the line says so', async () => {
    const h = await removedClash();
    wsq.hold = true;
    h.state.edges.push(wire('s1', 'n2'));
    h.emit(AGENT);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.connects).toEqual(['n1:shot_s2->n2:mask (onlyIfFree)']);
    expect(h.state.edges.map(edgeName)).toEqual(['n1:shot_s1->n2:mask']);
    expect(said).toEqual(['“Shot 2” is back without its connection to “Edit A”.']);
    expect(wiresNow()).not.toContain('n1:shot_s2->n2:mask');
    releaseAll();
    await sleep(40);
    expect(wiresNow()).toEqual(['n1:shot_s1->n2:mask']);
  });

  it('L-4: the person deletes the held wire while the choice waits: no request, no line; Keep mine leaves it out', async () => {
    const h = await removedClash();
    const held = useGraphStore.getState().edges.find((e: { sourceHandle?: string | null }) => e.sourceHandle === 'shot_s2');
    expect(held).toBeTruthy();
    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: held!.id }] as never);
    await sleep(40);
    expect(wiresNow()).toEqual([]);
    expect(h.deletes).toEqual([]);
    expect(said).toEqual([]);
    expect(useGraphStore.getState().undoNotice).toBeNull();
    expect(useGraphStore.getState().messageNotice).toBeNull();
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.backendBrief()).toEqual(['s1:a', 's2:mine']);
    expect(h.connects).toEqual([]);
    expect(wiresNow()).toEqual([]);
    expect(said).toEqual([]);
  });

  it('plurals: two shots back without their connections, in one line', async () => {
    const h = backend([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }, { id: 's3', prompt: 'c' }],
      { nodes: [editNode('n2', 'Edit A')], edges: [wire('s2', 'n2'), wire('s3', 'n2', 'images')] });
    h.failNext(1);
    typeIn('s2', 'mine 2');
    typeIn('s3', 'mine 3');
    await sleep(15);
    h.state.nodes = [];
    h.other((shots) => shots.filter((s) => s.id === 's1'), 'agent', () => []);
    await sleep(30);
    expect(clash()?.line).toBe('Codex removed “Shot 2” and “Shot 3” while you were editing them.');
    said = [];
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(said).toEqual(['“Shot 2” and “Shot 3” are back without their connections to “Edit A”.']);
  });
});

describe('GM r12 item 1 / r13 answer 3: a stopped save stays stoppable after its toast goes', () => {
  it('stopped after 8: stoppedScenes says so through an agent\'s toast; [Try again] clears it', async () => {
    store.setSceneRetryDelaysForTests([5]);
    const h = backend();
    h.failNext(1000);
    typeIn('s1', 'mine');
    await sleep(200);
    expect(h.puts).toHaveLength(9);
    expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
    // An agent's toast takes the slot: the mark keeps the stopped state.
    useGraphStore.getState().notify('Codex added “Edit B”.', 'info');
    expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
    h.failNext(0);
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(40);
    expect(useGraphStore.getState().stoppedScenes).toEqual({});
    expect(unsaved()).toBeNull();
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b']);
  });

  it('the next change leaves the stopped state too', async () => {
    store.setSceneRetryDelaysForTests([5]);
    const h = backend();
    h.failNext(1000);
    typeIn('s1', 'mine');
    await sleep(200);
    expect(useGraphStore.getState().stoppedScenes).toEqual({ n1: true });
    typeIn('s1', 'mine 2');
    expect(useGraphStore.getState().stoppedScenes).toEqual({});
  });
});
