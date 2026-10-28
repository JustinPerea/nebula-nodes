import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 8 (review 7; GM r10 and r11), against a small keyed
 * backend that does what main.py does: every Cinema scene has a sceneKey (in
 * each sync and each save's answer), a save that sends an ifSceneKey Nebula
 * no longer has is refused with 409 scene_changed and the scene it has now,
 * and a save's own echo is broadcast before its answer.
 * - H2: Codex's edit while the person types is never lost (E1, E2, R7-A).
 * - H1: an order clash works both ways, and a later sync still merges.
 * - M1 (GM r10): no retry and no retry line while a clash waits; after
 *   Keep mine, a failure says the normal line.
 * - M2 (GM r11 answer 4): Keep mine brings a removed shot back with its
 *   connection, or says which one couldn't come back.
 * - GM r10 answer 3: each clash its own line.
 * - L1-L3: the prompt names the change it clashes with; retries stop until
 *   the next change ([Try again]); a reconnect sends at once.
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
const socketSends = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const store = await import('../../src/store/graphStore');
const { useGraphStore } = store;
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const { TAB_ID } = await import('../../src/lib/tabId');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Shot = { id: string; prompt?: string; [key: string]: unknown };
type Wire = { id: string; type: string; source: string; sourceHandle: string; target: string; targetHandle: string; data: { dataType: string } };
const sceneOf = (shots: Shot[]) => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots });
const cinema = (shots: Shot[]) => ({ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
  data: { label: 'Opening', definitionId: 'cinema-scene', params: { scene: sceneOf(shots) }, state: 'idle', outputs: {} } });
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
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [], unsavedScenes: {}, sceneClashes: {},
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, messageNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (text: string) => { said.push(text); } } as never);
});

/** The keyed backend (main.py + services/scene_keys.py, in small). */
function backend(start: Shot[] = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }],
  extra: { nodes?: unknown[]; edges?: Wire[] } = {}) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [], edges: [] } as never);
  const state = { shots: JSON.parse(JSON.stringify(start)) as Shot[], edges: [...(extra.edges ?? [])], nodes: extra.nodes ?? [editNode('n2', 'Edit A')],
    writer: null as null | { kind: string; name: string } };
  const keyOf = () => JSON.stringify(state.shots.map((s) => [s.id, s.prompt]));
  const snapshot = () => ({ nodes: [cinema(state.shots), ...state.nodes], edges: state.edges, sceneKeys: { n1: keyOf() } });
  const emit = (origin: object = {}) => socketSends({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...snapshot(), ...origin });
  const commit = (shots: Shot[], writer: { kind: string; name: string }) => {
    state.shots = JSON.parse(JSON.stringify(shots));
    const ports = new Set(shots.map((s) => `shot_${s.id}`));
    state.edges = state.edges.filter((e) => ports.has(e.sourceHandle));
    state.writer = writer;
  };
  const puts: { shots: string[]; ifKey: string | null; status: number }[] = [];
  const connects: string[] = [];
  let fail = 0;
  let hook: (n: number) => Promise<void> = async () => {};
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
        return json({ detail: 'changed', code: 'scene_changed', scene: sceneOf(state.shots), sceneKey: keyOf(), changedBy: state.writer }, 409);
      }
      commit(body.params.scene.shots, { kind: 'person', name: 'You' });
      // The echo and the answer carry the scene as this save committed it.
      const committed = { ...snapshot(), ...OWN() };
      const key = keyOf();
      await sleep(2);
      socketSends({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...committed });
      await sleep(2);
      return json({ id: 'n1', sceneKey: key });
    }
    if (init?.method === 'POST' && path.includes('/api/graph/connect')) {
      const body = JSON.parse(String(init.body));
      connects.push(`${body.source}:${body.sourceHandle}->${body.target}:${body.targetHandle}`);
      state.edges.push({ ...wire(body.sourceHandle.slice(5), body.target, body.targetHandle) });
      emit(OWN());
      return json({ ok: true });
    }
    if (path.includes('/api/graph/export')) return json({ ...base, canvasRevision: 'c1', empty: false, ...snapshot() });
    return json({});
  });
  return {
    state, puts, connects, emit, keyOf,
    failNext: (count: number) => { fail = count; },
    onPut: (fn: (n: number) => Promise<void>) => { hook = fn; },
    /** An agent's (or another window's) write: committed, then its sync. */
    other: (change: (shots: Shot[]) => Shot[], who: 'agent' | 'window' = 'agent', edges?: (e: Wire[]) => Wire[]) => {
      commit(change(JSON.parse(JSON.stringify(state.shots))), who === 'agent' ? { kind: 'agent', name: 'Codex' } : { kind: 'person', name: 'You' });
      if (edges) state.edges = edges(state.edges);
      emit(who === 'agent' ? AGENT : WINDOW);
    },
    backendBrief: () => state.shots.map((s) => `${s.id}:${s.prompt}`),
  };
}
const typeIn = (shotId: string, prompt: string) => useGraphStore.getState().updateScene('n1', (current: { shots: Shot[] }) => ({ ...current,
  shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, prompt } : shot)) }));
const reorder = (ids: string[]) => useGraphStore.getState().updateScene('n1', (current: { shots: Shot[] }) => ({ ...current,
  shots: ids.map((id) => current.shots.find((shot) => shot.id === id)!) }));
const setPrompt = (shots: Shot[], id: string, prompt: string) => shots.map((s) => (s.id === id ? { ...s, prompt } : s));

describe('H2: Codex edits a scene while the person types in it, and nothing is lost', () => {
  it('E1: Codex commits after our save and its sync lands before our answer: shown, and our next key keeps it', async () => {
    const h = backend();
    h.onPut(async (n) => {
      if (n !== 1) return;
      // Our save commits first (below); Codex's lands right after, before our answer.
      setTimeout(() => h.other((shots) => setPrompt(shots, 's2', "codex's s2")), 1);
    });
    typeIn('s1', 'm1');
    await sleep(60);
    typeIn('s1', 'm12');
    await sleep(80);
    expect(h.backendBrief()).toEqual(['s1:m12', "s2:codex's s2"]);
    expect(brief()).toEqual(['s1:m12', "s2:codex's s2"]);
    expect(said).toEqual([]);
    expect(clash()).toBeNull();
  });

  it('E2: continuous typing, Codex edits s2 once mid-typing: every key saves and Codex\'s change stays', async () => {
    const h = backend();
    h.onPut(async (n) => { if (n === 3) h.other((shots) => setPrompt(shots, 's2', "codex's s2")); });
    const word = 'hello world';
    for (let i = 1; i <= word.length; i += 1) {
      typeIn('s1', word.slice(0, i));
      await sleep(4);
    }
    await sleep(150);
    expect(h.backendBrief()).toEqual(['s1:hello world', "s2:codex's s2"]);
    expect(brief()).toEqual(['s1:hello world', "s2:codex's s2"]);
    // The refused save said nothing and asked nothing (GM r11 H2 notes).
    expect(h.puts.some((put) => put.status === 409)).toBe(true);
    expect(said).toEqual([]);
    expect(clash()).toBeNull();
    expect(unsaved()).toBeNull();
  });

  it('R7-A: Codex commits between our dispatch and our commit: scene_changed, merged silently, sent again', async () => {
    const h = backend();
    h.onPut(async (n) => { if (n === 1) h.other((shots) => setPrompt(shots, 's2', "codex's s2")); });
    typeIn('s1', 'a quiet street at dusk');
    await sleep(80);
    expect(h.puts.map((put) => put.status)).toEqual([409, 200]);
    expect(h.puts[1].shots).toEqual(['s1:a quiet street at dusk', "s2:codex's s2"]);
    expect(h.backendBrief()).toEqual(['s1:a quiet street at dusk', "s2:codex's s2"]);
    expect(said).toEqual([]);
  });

  it('the same field: scene_changed asks with the field line, and no "Couldn\'t save" toast', async () => {
    const h = backend();
    h.onPut(async (n) => { if (n === 1) h.other((shots) => setPrompt(shots, 's1', "codex's s1")); });
    typeIn('s1', 'mine');
    await sleep(80);
    expect(clash()?.line).toBe('Codex changed “Opening” while you were editing it.');
    expect(unsaved()).toBe(clash()?.line);
    expect(said).toEqual([]);
    expect(h.backendBrief()).toEqual(["s1:codex's s1", 's2:b']);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(60);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b']);
    expect(unsaved()).toBeNull();
  });

  it('a card that shows a scene Nebula never had: its first save is refused and merged, never sent over Nebula\'s', async () => {
    const h = backend();
    // The card drifted from what Nebula has (a change it showed that Nebula never took).
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node: { id: string; data: { params: Record<string, unknown> } }) => (node.id === 'n1'
      ? { ...node, data: { ...node.data, params: { ...node.data.params, scene: sceneOf([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'card only' }]) } } }
      : node)) }) as never);
    typeIn('s1', 'mine');
    await sleep(80);
    expect(h.puts.map((put) => [put.ifKey, put.status])).toEqual([['stale', 409], [expect.any(String), 200]]);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b']);
    expect(said).toEqual([]);
  });

  it('every save carries the key of the scene it was built on', async () => {
    const h = backend();
    const first = h.keyOf();
    typeIn('s1', 'x');
    await sleep(40);
    const second = h.keyOf();
    typeIn('s1', 'xy');
    await sleep(40);
    expect(h.puts.map((put) => put.ifKey)).toEqual([first, second]);
  });
});

describe('H1: an order clash works, and never breaks a sync', () => {
  const three = [{ id: 's1', prompt: 'one' }, { id: 's2', prompt: 'two' }, { id: 's3', prompt: 'three' }];
  async function orderClash() {
    const h = backend(three, { nodes: [editNode('n2', 'Edit A'), editNode('n3', 'Temp')] });
    h.failNext(1);
    reorder(['s2', 's1', 's3']);
    await sleep(20);
    h.other((shots) => [shots[0], shots[2], shots[1]]);
    await sleep(40);
    return h;
  }

  it('ORD1: both reorder: GM r10\'s reorder line, the card keeps mine', async () => {
    await orderClash();
    expect(clash()?.line).toBe('Codex reordered the shots in “Opening” while you were editing them.');
    expect(shotsOf().map((s) => s.id)).toEqual(['s2', 's1', 's3']);
    expect(shotsOf().every((s) => s && typeof s.id === 'string')).toBe(true);
  });

  it('ORD1, Use Codex\'s: their order, saved, the mark goes', async () => {
    const h = await orderClash();
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await sleep(60);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    expect(h.state.shots.map((s) => s.id)).toEqual(['s1', 's3', 's2']);
    expect(unsaved()).toBeNull();
    expect(clash()).toBeNull();
  });

  it('ORD1, Keep mine: my order, saved over theirs', async () => {
    const h = await orderClash();
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(60);
    expect(h.state.shots.map((s) => s.id)).toEqual(['s2', 's1', 's3']);
    expect(unsaved()).toBeNull();
  });

  it('ORD1, a later sync while the clash waits: merged, and other nodes in it still arrive', async () => {
    const h = await orderClash();
    h.state.nodes = [editNode('n2', 'Edit A renamed'), editNode('n3', 'Temp')];
    h.other((shots) => setPrompt(shots, 's3', "codex's three"));
    await sleep(40);
    expect(nodeOf('n2')?.data.label).toBe('Edit A renamed');
    expect(shotsOf().find((s) => s.id === 's3')?.prompt).toBe("codex's three");
    expect(clash()).not.toBeNull();
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await sleep(60);
    expect(h.state.shots.map((s) => `${s.id}:${s.prompt}`)).toEqual(['s1:one', "s3:codex's three", 's2:two']);
  });
});

describe('M1 (GM r10): while a clash waits, nothing retries and no retry line shows', () => {
  it('C1: a 500 kept, then a clash: no PUT and no line while waiting; the retry toast leaves', async () => {
    const h = backend();
    h.failNext(100);
    typeIn('s1', 'mine');
    await sleep(20);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. They're kept and Nebula will try again."]);
    useGraphStore.setState({ undoNotice: { id: 99, text: said[0], offer: null } } as never);
    h.other((shots) => setPrompt(shots, 's1', "codex's s1"));
    await sleep(10);
    expect(clash()).not.toBeNull();
    expect(useGraphStore.getState().undoNotice).toBeNull();
    const before = h.puts.length;
    await sleep(300);
    expect(h.puts.length).toBe(before);
    expect(said).toHaveLength(1);
    expect(unsaved()).toBe(clash()?.line);
  });

  it('after Keep mine, a failed save says the normal retry line once', async () => {
    const h = backend();
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(10);
    h.other((shots) => setPrompt(shots, 's1', "codex's s1"));
    await sleep(10);
    said = [];
    h.failNext(1);
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(15);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. They're kept and Nebula will try again."]);
    await sleep(80);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b']);
    expect(unsaved()).toBeNull();
  });
});

describe('M2 (GM r11 answer 4): Keep mine on a shot Codex removed', () => {
  async function removedClash(edges: Wire[] = [wire('s2', 'n2')]) {
    const h = backend(undefined, { edges });
    h.failNext(1);
    typeIn('s2', 'mine: a busy street, kept');
    await sleep(15);
    h.other((shots) => shots.filter((s) => s.id !== 's2'));
    await sleep(30);
    said = []; // the kept save's first line, before the clash
    return h;
  }

  it('the removal line, and the wire stays drawn while the choice waits', async () => {
    await removedClash();
    expect(clash()?.line).toBe('Codex removed “Shot 2” while you were editing it.');
    expect(wiresNow()).toContain('n1:shot_s2->n2:mask');
  });

  it('K1: Keep mine brings the shot and its connection back, on the card and on the backend, silently', async () => {
    const h = await removedClash();
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.backendBrief()).toEqual(['s1:a', 's2:mine: a busy street, kept']);
    expect(h.connects).toEqual(['n1:shot_s2->n2:mask']);
    expect(h.state.edges.map((e) => `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`)).toEqual(['n1:shot_s2->n2:mask']);
    expect(wiresNow()).toEqual(['n1:shot_s2->n2:mask']);
    expect(said).toEqual([]);
  });

  it('K2: Use Codex\'s: the shot and its wire go', async () => {
    const h = await removedClash();
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await sleep(80);
    expect(brief()).toEqual(['s1:a']);
    expect(h.connects).toEqual([]);
    expect(wiresNow()).toEqual([]);
  });

  it('K3: the input now holds Codex\'s own connection: kept, and the line says so', async () => {
    const h = backend(undefined, { edges: [wire('s2', 'n2')] });
    h.failNext(1);
    typeIn('s2', 'mine');
    await sleep(15);
    h.other((shots) => shots.filter((s) => s.id !== 's2'), 'agent', (edges) => [...edges, wire('s1', 'n2')]);
    await sleep(30);
    said = [];
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.connects).toEqual([]);
    expect(wiresNow()).toEqual(['n1:shot_s1->n2:mask']);
    expect(said).toEqual(['“Shot 2” is back without its connection to “Edit A”.']);
  });

  it('K4: the other end is gone: the shot comes back without it, and the line says so', async () => {
    const h = backend(undefined, { edges: [wire('s2', 'n2')] });
    h.failNext(1);
    typeIn('s2', 'mine');
    await sleep(15);
    h.state.nodes = [];
    h.other((shots) => shots.filter((s) => s.id !== 's2'), 'agent', () => []);
    await sleep(30);
    said = [];
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.connects).toEqual([]);
    expect(said).toEqual(['“Shot 2” is back without its connection to “Edit A”.']);
  });
});

describe('the lines and the lows', () => {
  it('another window: the removal and reorder lines in their no-agent shapes, with Use theirs', async () => {
    const h = backend();
    h.failNext(1);
    typeIn('s2', 'mine');
    await sleep(15);
    h.other((shots) => shots.filter((s) => s.id !== 's2'), 'window');
    await sleep(30);
    expect(clash()).toMatchObject({ line: '“Shot 2” was removed in another window while you were editing it.', agent: null });
  });

  it('L1: the prompt names the change it clashes with, not the latest changer', async () => {
    const h = backend([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }, { id: 's3', prompt: 'c' }]);
    h.failNext(100);
    typeIn('s1', 'mine');
    await sleep(15);
    h.other((shots) => setPrompt(shots, 's1', "window's s1"), 'window');
    await sleep(15);
    expect(clash()?.line).toBe('“Opening” was changed in another window while you were editing it.');
    h.other((shots) => setPrompt(shots, 's3', "codex's s3"));
    await sleep(15);
    expect(clash()).toMatchObject({ line: '“Opening” was changed in another window while you were editing it.', agent: null });
  });

  it('L2: after 8 retries a sync sends nothing; the next change does; [Try again] does', async () => {
    store.setSceneRetryDelaysForTests([5]);
    const h = backend();
    h.failNext(1000);
    typeIn('s1', 'mine');
    await sleep(200);
    expect(h.puts).toHaveLength(9);
    expect(unsaved()).toBe("Couldn't save your changes to “Opening”. They're kept and Nebula will try again with your next change.");
    h.emit(AGENT);
    h.emit(AGENT);
    await sleep(40);
    expect(h.puts).toHaveLength(9);
    h.failNext(0);
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(40);
    expect(h.puts).toHaveLength(10);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b']);
    expect(unsaved()).toBeNull();
  });

  it('L3: a reconnect sends a kept save at once, its waiting timer cancelled', async () => {
    store.setSceneRetryDelaysForTests([15_000]);
    const h = backend();
    h.failNext(1);
    typeIn('s1', 'mine');
    await sleep(20);
    expect(h.puts).toHaveLength(1);
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await sleep(40);
    expect(h.puts).toHaveLength(2);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:b']);
  });
});
