import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 11 (GM r16, item 2): a stopped scene save tries once by
 * itself, but only on evidence that saving works again: a change from
 * another writer arriving in the scene. About 2 s after the last such change
 * it goes once; a success clears "Unsaved" as any save does, a failure stays
 * stopped with no new toast and the popover keeps [Try again]. One try per
 * quiet stretch, never a loop. On round 10's keyed backend in small.
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
const QUIET = 80;
const stopped = () => useGraphStore.getState().stoppedScenes;
const toast = () => (useGraphStore.getState() as unknown as { undoNotice: { text: string; retryScene?: { nodeId: string } } | null }).undoNotice;

/** A save stopped after its 8 timed retries (the server keeps failing). */
async function stoppedByServer(h: ReturnType<typeof backend>) {
  store.setSceneRetryDelaysForTests([5]);
  h.failNext(1000);
  typeIn('s1', 'mine');
  await sleep(200);
  expect(stopped()).toEqual({ n1: true });
  expect(unsaved()).toBe(STOPPED);
  return h.puts.length;
}

beforeEach(() => store.setSceneQuietRetryForTests(QUIET));
afterEach(() => store.setSceneQuietRetryForTests(null));

describe('GM r16: a stopped save tries once after another writer’s change', () => {
  it('Codex’s change arrives once saving works: about 2 s later it goes once, saves, and "Unsaved" clears', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.failNext(0);
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(QUIET / 2);
    expect(h.puts.length).toBe(before);
    await sleep(QUIET + 60);
    expect(h.puts.length).toBe(before + 1);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex', 's3:c']);
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
    expect(toast()?.retryScene).toBeUndefined();
  });

  it('it fails again: stopped as before, the same line, no new toast, and no more tries', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    const saidBefore = [...said];
    // The stopped toast in the slot now; only what comes after it counts.
    const lines: string[] = [toast()?.text ?? ''];
    const off = useGraphStore.subscribe((state) => { const text = (state as unknown as { undoNotice: { text: string } | null }).undoNotice?.text;
      if (text && lines[lines.length - 1] !== text) lines.push(text); });
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(QUIET + 80);
    off();
    expect(h.puts.length).toBe(before + 1);
    expect(h.puts[h.puts.length - 1].status).toBe(500);
    expect(stopped()).toEqual({ n1: true });
    expect(unsaved()).toBe(STOPPED);
    // Only Codex's own toast: no line of the save's.
    expect(said).toEqual(saidBefore);
    expect(lines.slice(1).filter((line) => /save/i.test(line))).toEqual([]);
    await sleep(QUIET * 3);
    expect(h.puts.length).toBe(before + 1);
    // The popover's [Try again] still sends.
    h.failNext(0);
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(60);
    expect(unsaved()).toBeNull();
    expect(h.backendBrief()[0]).toBe('s1:mine');
  });

  it('one try per quiet stretch: changes in a row push it back, then it goes once', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    for (let k = 1; k <= 4; k += 1) {
      h.other((shots) => setPrompt(shots, 's2', `codex ${k}`), 'agent');
      await sleep(QUIET / 2);
    }
    expect(h.puts.length).toBe(before);
    await sleep(QUIET + 60);
    expect(h.puts.length).toBe(before + 1);
    // Still failing: the next stretch tries once more, only after a new change.
    await sleep(QUIET * 2);
    expect(h.puts.length).toBe(before + 1);
    h.other((shots) => setPrompt(shots, 's3', 'codex again'), 'agent');
    await sleep(QUIET + 60);
    expect(h.puts.length).toBe(before + 2);
    expect(stopped()).toEqual({ n1: true });
  });

  it('no change from another writer: no try of its own, however long it waits', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.failNext(0);
    await sleep(QUIET * 4);
    expect(h.puts.length).toBe(before);
    // A sync that brings nothing new for the scene (another node changed) isn't evidence either.
    h.emit(AGENT);
    await sleep(QUIET * 2);
    expect(h.puts.length).toBe(before);
    expect(stopped()).toEqual({ n1: true });
  });

  it('the next change or [Try again] before the quiet stretch ends: one save, no second one from the timer', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    h.failNext(0);
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(10);
    useGraphStore.getState().retrySceneSave('n1');
    await sleep(QUIET + 80);
    expect(h.puts.length).toBe(before + 1);
    expect(unsaved()).toBeNull();
  });

  it('refused 20 times by a busy Codex: once Codex is quiet, the one try saves both changes', async () => {
    const h = backend(S3);
    let busy = true;
    let k = 0;
    h.onPut(async () => { if (busy) { k += 1; h.other((shots) => setPrompt(shots, 's2', `c${k}`), 'agent'); } });
    typeIn('s1', 'p1');
    await sleep(400);
    expect(stopped()).toEqual({ n1: true });
    const before = h.puts.length;
    busy = false;
    h.other((shots) => setPrompt(shots, 's3', 'codex last'), 'agent');
    await sleep(QUIET + 80);
    expect(h.puts.length).toBe(before + 1);
    expect(h.backendBrief()).toEqual(['s1:p1', `s2:c${k}`, 's3:codex last']);
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
  });

  it('the one try refused as changed (Codex wrote meanwhile), a silent merge: merged on the card, nothing new shown, still stopped; once Codex is quiet, one more try saves', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    const saidBefore = [...said];
    const lines: string[] = [toast()?.text ?? ''];
    const off = useGraphStore.subscribe((state) => { const text = (state as unknown as { undoNotice: { text: string } | null }).undoNotice?.text;
      if (text && lines[lines.length - 1] !== text) lines.push(text); });
    h.failNext(0);
    let once = true;
    h.onPut(async () => { if (once) { once = false; h.other((shots) => setPrompt(shots, 's3', 'codex during'), 'agent'); } });
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(QUIET + 40);
    expect(h.puts.length).toBe(before + 1);
    expect(h.puts[h.puts.length - 1].status).toBe(409);
    expect(brief()).toEqual(['s1:mine', 's2:codex', 's3:codex during']);
    expect(stopped()).toEqual({ n1: true });
    expect(unsaved()).toBe(STOPPED);
    // GM r17: silent means silent: no clash prompt, no line of the save's.
    expect(useGraphStore.getState().sceneClashes).toEqual({});
    expect(said).toEqual(saidBefore);
    expect(lines.slice(1).filter((line) => /save|chang(ed|es) to/i.test(line) && !/^Codex changed/.test(line))).toEqual([]);
    off();
    // The refusal is Codex's change arriving: the next quiet stretch tries once more, and saves.
    await sleep(QUIET + 80);
    expect(h.puts.length).toBe(before + 2);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex', 's3:codex during']);
    expect(unsaved()).toBeNull();
  });
  it('the one try refused as changed, and Codex’s change overlaps the person’s field: the clash prompt asks as usual, the stopped state waits behind it (GM r17)', async () => {
    const h = backend(S3);
    const before = await stoppedByServer(h);
    expect(toast()?.retryScene).toEqual({ nodeId: 'n1' });
    h.failNext(0);
    let once = true;
    // During the try, Codex writes the shot the person changed (s1).
    h.onPut(async () => { if (once) { once = false; h.other((shots) => setPrompt(shots, 's1', 'codex s1'), 'agent'); } });
    h.other((shots) => setPrompt(shots, 's2', 'codex'), 'agent');
    await sleep(QUIET + 40);
    expect(h.puts.length).toBe(before + 1);
    expect(h.puts[h.puts.length - 1].status).toBe(409);
    // The clash asks, with its own line on the mark; the person's text stays on the card.
    const clash = useGraphStore.getState().sceneClashes.n1;
    expect(clash).toBeTruthy();
    expect(clash.agent).toBe('Codex');
    expect(unsaved()).toBe(clash.line);
    expect(unsaved()).not.toBe(STOPPED);
    expect(brief()[0]).toBe('s1:mine');
    // The stopped state waits behind it: the mark offers no [Try again] and
    // the stopped toast leaves; the save is still stopped underneath.
    expect(stopped()).toEqual({});
    expect(toast()?.retryScene).toBeUndefined();
    // No quiet try while the clash waits, however long.
    await sleep(QUIET * 4);
    expect(h.puts.length).toBe(before + 1);
    // The person's answer sends the save, as any clash answer does.
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.puts.length).toBe(before + 2);
    expect(h.backendBrief()).toEqual(['s1:mine', 's2:codex', 's3:c']);
    expect(unsaved()).toBeNull();
    expect(stopped()).toEqual({});
    expect(useGraphStore.getState().sceneClashes).toEqual({});
  });
});


/** Codex commits during each of the tab's saves until told to stop. */
function busyCodex(h: ReturnType<typeof backend>, writer?: { kind: string; name: string }) {
  let busy = true;
  let k = 0;
  h.onPut(async () => {
    if (!busy) return;
    k += 1;
    h.other((shots) => setPrompt(shots, 's2', `c${k}`), writer?.kind === 'person' ? 'window' : 'agent');
    if (writer) h.state.writer = writer;
  });
  return () => { busy = false; h.onPut(async () => {}); };
}

describe('review 10, L-2: a reconnect sends a save another writer’s refusals stopped', () => {
  // The quiet try (GM r16) is held off here: the reconnect is what sends.
  beforeEach(() => store.setSceneQuietRetryForTests(60_000));

  it('P3: Codex goes quiet, then a reconnect: one PUT, built on the 21st refusal’s scene, saves both changes', async () => {
    const h = backend(S3);
    const quiet = busyCodex(h);
    typeIn('s1', 'p1');
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    const before = h.puts.length;
    // The 21st refusal's scene is on the card already (merged before the stop).
    expect(brief()).toEqual(['s1:p1', `s2:c${before}`, 's3:c']);
    quiet();
    await sleep(1100); // a reconnect kicks a save at most once a second
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.puts.slice(before).map((put) => put.status)).toEqual([200]);
    expect(h.backendBrief()).toEqual(['s1:p1', `s2:c${before}`, 's3:c']);
    expect(stopped()).toEqual({});
  });

  it('a reconnect while Codex still writes: refused, merged and sent again (not stuck stopped), and saves once Codex is done', async () => {
    const h = backend(S3);
    const quiet = busyCodex(h);
    typeIn('s1', 'p1');
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    const before = h.puts.length;
    await sleep(1100);
    let left = 2;
    h.onPut(async () => { if (left > 0) { left -= 1; h.other((shots) => setPrompt(shots, 's3', `late${left}`), 'agent'); } });
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(h.puts.slice(before).map((put) => put.status)).toEqual([409, 409, 200]);
    expect(h.backendBrief()[0]).toBe('s1:p1');
    quiet();
  });
});

describe('GM r18 answer 2: a stop by another writer names that writer; a server failure keeps its line', () => {
  const cases: [string, { kind: string; name: string } | undefined, string][] = [
    ['an agent by name', undefined,
      'Codex kept changing “Opening”, so your changes aren’t saved yet. Nebula will try again when Codex stops.'],
    ['an agent with no name', { kind: 'agent', name: '' },
      'An agent kept changing “Opening”, so your changes aren’t saved yet. Nebula will try again when it stops.'],
    ['another window', { kind: 'person', name: 'You' },
      '“Opening” kept changing in another window, so your changes aren’t saved yet. Nebula will try again when it stops.'],
  ];
  it.each(cases)('%s: the same line in the toast (with [Try again]) and on the mark (its tooltip and popover)', async (_who, writer, line) => {
    const h = backend(S3);
    const quiet = busyCodex(h, writer);
    typeIn('s1', 'p1');
    await vi.waitFor(() => expect(stopped()).toEqual({ n1: true }), { timeout: 3000, interval: 5 });
    expect(unsaved()).toBe(line);
    expect(toast()?.text).toBe(line);
    expect(toast()?.retryScene).toEqual({ nodeId: 'n1' });
    quiet();
    // [Try again] saves, and the line goes.
    useGraphStore.getState().retrySceneSave('n1');
    await vi.waitFor(() => expect(unsaved()).toBeNull(), { timeout: 3000, interval: 5 });
    expect(stopped()).toEqual({});
  });

  it('a real server failure keeps the existing line', async () => {
    const h = backend(S3);
    await stoppedByServer(h);
    expect(unsaved()).toBe(STOPPED);
    expect(toast()?.text).toBe(STOPPED);
    expect(toast()?.retryScene).toEqual({ nodeId: 'n1' });
  });
});

describe('review 10, N-4: a late sync from a process already replaced is dropped', () => {
  it('P1: the new process’s id is known (health probe), then the old one’s late sync below what the tab has: the card keeps the person’s typing, no false clash', async () => {
    revisionCounter = 9_000_000;
    const h = backend(S3);
    noteBackendBootId('boot-1');
    h.emit({ bootId: 'boot-1' });
    const old = { type: 'graphSync', ...base, bootId: 'boot-1', canvasRevision: 'c1', empty: false, nodes: [cinema(S3), editNode('n2', 'Edit A')],
      edges: [], sceneKeys: { n1: h.keyOf() }, sceneRevs: { n1: h.state.rev } };
    h.other((shots) => setPrompt(shots, 's2', 'c1'), 'agent');
    await sleep(10);
    typeIn('s1', 'p1');
    await sleep(80);
    noteBackendBootId('boot-2'); // the health probe, or the new socket's hello
    deliver(old); // the old process's late sync
    deliver({ ...old, bootId: undefined }); // and a broadcast on its socket
    await sleep(20);
    expect(brief()[0]).toBe('s1:p1');
    expect(useGraphStore.getState().sceneClashes).toEqual({});
    typeIn('s1', 'p1x');
    await vi.waitFor(() => expect(h.backendBrief()[0]).toBe('s1:p1x'), { timeout: 3000, interval: 5 });
    expect(useGraphStore.getState().sceneClashes).toEqual({});
    // The new process's own sync is taken.
    h.other((shots) => setPrompt(shots, 's3', 'new process'), 'agent');
    h.emit({ bootId: 'boot-2' });
    await sleep(20);
    expect(brief()).toEqual(['s1:p1x', 's2:c1', 's3:new process']);
  });
});
