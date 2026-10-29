import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 7 (review 6; GM r9 and its answers):
 * - H1: a canvas replacement hands a scene's kept edits to #195's cut-off
 *   report, then lets them go: an agent's clear names them ("…while you were
 *   editing “Scene” for “Opening”…"), a sync with no edit that brought
 *   another canvas names them (and keeps the copy), and no kept save, retry
 *   or edit ever PUTs the old scene onto the new canvas's node. A reconnect
 *   to the same canvas cuts nothing off: the edits go again.
 * - H2 (GM r9 decision 2, option b): another change is rebased in, field by
 *   field, and saved without asking when nothing overlaps; on a clash the
 *   person chooses, and until then saves send the other side's value for it.
 * - M1: `canvas_replaced` says no line of its own.
 * - L2-L5: retries stop, no late line after Undo, no line twice, the
 *   person's own switch.
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
// GM r28 item 2 (round 19): the stop line is a state, in its own slot.
const stopLineOf = (nodeId: string) => store.sceneStopLines(useGraphStore.getState()).find((line) => line.nodeIds.includes(nodeId))?.text ?? null;
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Shot = Record<string, unknown>;
const sceneOf = (...shots: Shot[]) => ({ scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots } });
const cinema = (id: string, shots: Shot[], label = 'Opening') => ({ id, type: 'cinemaSceneNode',
  position: { x: 0, y: 0 }, data: { label, definitionId: 'cinema-scene', params: sceneOf(...shots), state: 'idle', outputs: {} } });
const textNode = (id: string, label = id) => ({ id, type: 'model-node', position: { x: 300, y: 0 },
  data: { label, definitionId: 'text-input', params: { text: '' }, state: 'idle', outputs: {} } });
const nodeOf = (id: string) => useGraphStore.getState().nodes.find((n: { id: string }) => n.id === id);
const shotsOf = (id = 'n1') => ((nodeOf(id)?.data.params.scene as { shots: Shot[] } | undefined)?.shots ?? []);
const brief = (id = 'n1') => shotsOf(id).map((s) => `${s.id}:${s.prompt}`);
const unsaved = (id = 'n1') => useGraphStore.getState().unsavedScenes[id] ?? null;
const clash = (id = 'n1') => useGraphStore.getState().sceneClashes[id]?.line ?? null;
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;
const ports = (id = 'n1') => ((nodeOf(id)?.data as { dynamicOutputPorts?: { id: string }[] }).dynamicOutputPorts ?? []).map((p) => p.id);
let said: string[] = [];
const AGENT = { edit: { id: 'ed_agent', actor: { kind: 'agent', name: 'Codex' } } };
const WINDOW = { edit: { id: 'ed_window', actor: { kind: 'person', name: 'You' }, tab: 'tab-other' } };

const graph = (shots: Shot[] = [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }], label = 'Opening') =>
  ({ nodes: [cinema('n1', shots, label), textNode('n2', 'Grade')], edges: [] });
const syncs = (g: object) => socketSends({ type: 'graphSync', ...base, empty: false, ...g });

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

/** n1 PUTs answer from `answers` in order (the last repeats); each PUT's shots are kept. */
function backend(answers: (() => Response | Promise<Response>)[], start: object = graph()) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [], edges: [] } as never);
  syncs({ ...start, canvasRevision: 'c1' });
  const puts: string[][] = [];
  let count = 0;
  const answer = (list: typeof answers) => { answers = list; count = 0; };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && String(url).includes('/api/graph/node/n1')) {
      puts.push(JSON.parse(String(init.body)).params.scene.shots.map((s: Shot) => `${s.id}:${s.prompt}`));
      const next = answers[Math.min(count, answers.length - 1)];
      count += 1;
      return next();
    }
    if (String(url).includes('/api/graph/export')) return json({ ...base, ...graph(), canvasRevision: 'c1', empty: false });
    return json({});
  });
  return { puts, answer };
}
const typeIn = (shotId: string, prompt: string, id = 'n1') => useGraphStore.getState().updateScene(id, (current: { shots: Shot[] }) => ({ ...current,
  shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, prompt } : shot)) }));
const boom = () => json({ detail: 'boom' }, 500);
const ok = () => json({ ok: true });

describe('H1: a canvas replacement takes a scene\'s kept edits with it, and names them', () => {
  it('1d-rev: an unanswered removal, then a sync with no edit that brings another canvas: nothing PUT onto its n1, the edits named', async () => {
    const h = backend([async () => { throw new TypeError('Failed to fetch'); }, ok]);
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(80);
    syncs({ canvasRevision: 'c2', bootId: 'boot-2', ...graph([{ id: 's1', prompt: 'other canvas' }, { id: 's2', prompt: 'other s2' }], 'Other') });
    await sleep(300);
    expect(brief()).toEqual(['s1:other canvas', 's2:other s2']);
    expect(h.puts).toHaveLength(1);
    expect(unsaved()).toBeNull();
    expect(notice()).toBe("Couldn’t save “Scene” for “Opening”.");
  });

  it('1e: kept edits (500), then an agent clear that re-adds n1: the typing line, no retry onto the new n1', async () => {
    store.setSceneRetryDelaysForTests([60, 60, 60]);
    const h = backend([boom]);
    typeIn('s1', 'old canvas typing');
    await sleep(40);
    syncs({ canvasRevision: 'c2', cleared: true, ...AGENT,
      ...graph([{ id: 's1', prompt: 'fresh canvas' }, { id: 's2', prompt: 'fresh s2' }], 'Fresh') });
    await sleep(400);
    expect(brief()).toEqual(['s1:fresh canvas', 's2:fresh s2']);
    expect(h.puts).toHaveLength(1);
    expect(unsaved()).toBeNull();
    expect(notice()).toBe("Codex cleared the canvas while you were editing “Scene” for “Opening”. That change wasn’t saved.");
  });

  it('1f: the same, then the person types in the new n1: only the new scene is sent', async () => {
    store.setSceneRetryDelaysForTests([5000]);
    const h = backend([boom]);
    typeIn('s1', 'old canvas typing');
    await sleep(40);
    syncs({ canvasRevision: 'c2', cleared: true, ...AGENT, ...graph([{ id: 's1', prompt: 'fresh canvas' }], 'Fresh') });
    await sleep(60);
    h.answer([ok]);
    typeIn('s1', 'person edits fresh');
    await sleep(120);
    expect(h.puts.slice(1)).toEqual([['s1:person edits fresh']]);
  });

  it('1a: an agent clear seen as its own empty sync names the kept scene edits', async () => {
    store.setSceneRetryDelaysForTests([400]);
    backend([boom]);
    typeIn('s1', 'person typing kept');
    await sleep(40);
    socketSends({ type: 'graphSync', ...base, empty: true, cleared: true, canvasRevision: 'c2', nodes: [], edges: [], ...AGENT });
    await sleep(80);
    expect(notice()).toBe("Codex cleared the canvas while you were editing “Scene” for “Opening”. That change wasn’t saved.");
    expect(useGraphStore.getState().unsavedScenes).toEqual({});
  });

  it('1b: an import (graphReplaced) names them in its line', async () => {
    useGraphStore.getState().setCanvasProjectName(() => 'Active');
    backend([() => json({ detail: 'A paid run is starting.', code: 'paid_start' }, 409)]);
    typeIn('s1', 'kept during run');
    await sleep(60);
    socketSends({ type: 'graphSync', ...base, empty: false, graphReplaced: true, canvasRevision: 'c2',
      nodes: [textNode('n1', 'Imported')], edges: [], ...AGENT });
    await sleep(120);
    const lines = [notice(), useGraphStore.getState().messageNotice?.text ?? null, ...said];
    expect(lines.some((line) => line?.includes('“Scene”'))).toBe(true);
    expect(useGraphStore.getState().unsavedScenes).toEqual({});
    useGraphStore.getState().setCanvasProjectName(() => null);
  });

  it('GM r9 answer 1: a reconnect to the same canvas cuts nothing off; the kept edits go again and save', async () => {
    store.setSceneRetryDelaysForTests([20]);
    const h = backend([boom]);
    typeIn('s1', 'typed before the gap');
    await sleep(400);
    const before = h.puts.length;
    expect(before).toBe(9); // the first try and 8 timed retries (L2), then it waits
    // GM r11 answer 3: stopped; the line says the next change sends them.
    expect(unsaved()).toBe("Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.");
    h.answer([ok]);
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await sleep(80);
    expect(h.puts.length).toBe(before + 1);
    expect(h.puts.at(-1)).toEqual(['s1:typed before the gap', 's2:b']);
    expect(unsaved()).toBeNull();
    expect(notice()).toBeNull();
  });
});

describe('H2 (GM r9 decision 2): another change is merged in, never overwritten', () => {
  it('5a: another window edits a different shot: shown, merged and saved without asking', async () => {
    const h = backend([boom]);
    typeIn('s1', 'mine');
    await sleep(60);
    h.answer([ok]);
    syncs({ ...WINDOW, ...graph([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: "window's s2" }]) });
    await sleep(80);
    expect(brief()).toEqual(['s1:mine', "s2:window's s2"]);
    expect(h.puts.at(-1)).toEqual(['s1:mine', "s2:window's s2"]);
    expect(clash()).toBeNull();
    expect(unsaved()).toBeNull();
    typeIn('s1', 'mine2');
    await sleep(80);
    expect(h.puts.at(-1)).toEqual(['s1:mine2', "s2:window's s2"]);
  });

  it('5b: an agent adds Shot 3 with an image while edits are kept: it appears, with its port, and every save keeps it', async () => {
    const h = backend([boom]);
    typeIn('s1', 'mine');
    await sleep(60);
    h.answer([ok]);
    syncs({ ...AGENT, ...graph([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' },
      { id: 's3', prompt: 'agent shot', output: { status: 'done', imageUrl: '/api/outputs/s3.png' } }]) });
    await sleep(80);
    expect(brief()).toEqual(['s1:mine', 's2:b', 's3:agent shot']);
    expect(ports()).toContain('shot_s3');
    typeIn('s2', 'person edits s2');
    await sleep(80);
    expect(h.puts.at(-1)).toEqual(['s1:mine', 's2:person edits s2', 's3:agent shot']);
    expect(said).toEqual(["Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula is trying again."]);
  });

  it('5c (control): with nothing kept, the same agent edit is simply shown', async () => {
    backend([ok]);
    syncs({ ...AGENT, ...graph([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: "agent's s2" }]) });
    await sleep(40);
    expect(brief()).toEqual(['s1:a', "s2:agent's s2"]);
  });

  it('a clash with Codex: mine on screen, GM\'s line, saves send Codex\'s value for it, shots added elsewhere stay; Use Codex\'s takes it', async () => {
    const h = backend([boom]);
    typeIn('s1', 'mine');
    await sleep(60);
    h.answer([ok]);
    const sentBefore = h.puts.length;
    syncs({ ...AGENT, ...graph([{ id: 's1', prompt: "codex's s1" }, { id: 's2', prompt: 'b' }, { id: 's3', prompt: 'added' }]) });
    await sleep(80);
    const LINE = 'Codex changed “Opening” while you were editing it.';
    expect(brief()).toEqual(['s1:mine', 's2:b', 's3:added']);
    expect(clash()).toBe(LINE);
    expect(unsaved()).toBe(LINE);
    // Nothing of the person's to save past the clash: no PUT over Codex's.
    expect(h.puts.slice(sentBefore).every((put) => put[0] === "s1:codex's s1")).toBe(true);
    typeIn('s2', 'my s2');
    await sleep(80);
    expect(h.puts.at(-1)).toEqual(["s1:codex's s1", 's2:my s2', 's3:added']);
    expect(unsaved()).toBe(LINE);
    useGraphStore.getState().resolveSceneClash('n1', 'theirs');
    await sleep(80);
    expect(brief()).toEqual(["s1:codex's s1", 's2:my s2', 's3:added']);
    expect(clash()).toBeNull();
    expect(unsaved()).toBeNull();
  });

  it('a clash with no agent reads "another window"; Keep mine saves mine over it', async () => {
    const h = backend([boom]);
    typeIn('s1', 'mine');
    await sleep(60);
    h.answer([ok]);
    syncs({ ...WINDOW, ...graph([{ id: 's1', prompt: "window's s1" }, { id: 's2', prompt: 'b' }]) });
    await sleep(80);
    expect(clash()).toBe('“Opening” was changed in another window while you were editing it.');
    useGraphStore.getState().resolveSceneClash('n1', 'mine');
    await sleep(80);
    expect(h.puts.at(-1)).toEqual(['s1:mine', 's2:b']);
    expect(unsaved()).toBeNull();
  });

  it('a shot the person removed that the agent changed since comes back', async () => {
    const h = backend([boom]);
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(60);
    expect(brief()).toEqual(['s1:a']);
    h.answer([ok]);
    syncs({ ...AGENT, ...graph([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'agent rewrote s2' }]) });
    await sleep(80);
    expect(brief()).toEqual(['s1:a', 's2:agent rewrote s2']);
    expect(clash()).toBeNull();
  });

  it('a sync from before the save (it lands after the save\'s answer) is never read as another change', async () => {
    const h = backend([ok]);
    typeIn('s1', 'saved');
    await sleep(30);
    syncs(graph([{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }]));
    await sleep(30);
    expect(brief()).toEqual(['s1:saved', 's2:b']);
    expect(h.puts).toEqual([['s1:saved', 's2:b']]);
    expect(clash()).toBeNull();
  });
});

describe('M1: canvas_replaced says no line of its own', () => {
  const replaced = (kind: 'agent' | 'person') => json({ detail: 'This canvas is out of date. Open the current project before editing or running it.',
    code: 'canvas_replaced', project: { id: 'A', name: 'Active' },
    switchedBy: kind === 'agent' ? { kind: 'agent', name: 'Codex' } : { kind: 'person', name: 'You' } }, 409);

  it('A: the 409 before the clear\'s sync: no "switched" line; the sync says #195\'s line', async () => {
    backend([() => replaced('agent')]);
    typeIn('s1', 'typed');
    await sleep(60);
    expect(said).toEqual([]);
    expect(unsaved()).toBeNull();
    socketSends({ type: 'graphSync', ...base, empty: true, cleared: true, canvasRevision: 'c2', nodes: [], edges: [], ...AGENT });
    await sleep(60);
    expect(notice()).toBe("Codex cleared the canvas while you were editing “Scene” for “Opening”. That change wasn’t saved.");
    expect(said.some((line) => line.includes('switched'))).toBe(false);
  });

  it('C: the person\'s own clear in another window: nothing said', async () => {
    backend([() => replaced('person')]);
    typeIn('s1', 'typed');
    await sleep(60);
    socketSends({ type: 'graphSync', ...base, empty: true, cleared: true, canvasRevision: 'c2', nodes: [], edges: [], ...WINDOW });
    await sleep(60);
    expect(said).toEqual([]);
    expect(notice()).toBeNull();
  });
});

describe('L2-L5', () => {
  it('L2: a server error that goes on stops after 8 timed retries, "Unsaved" and the line stay', async () => {
    store.setSceneRetryDelaysForTests([10]);
    const h = backend([boom]);
    typeIn('s1', 'x');
    await sleep(500);
    expect(h.puts).toHaveLength(9);
    expect(said).toHaveLength(1);
    // GM r11 answer 3: the stopped line, with [Try again] on its toast.
    const stopped = "Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.";
    expect(unsaved()).toBe(stopped);
    // GM r28 item 2 (round 19): the line is a state, in its own slot.
    expect(stopLineOf('n1')).toBe(stopped);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('L3: Undo while the removal is out, then its 409: no late line, no mark', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rendering = async () => { await gate; return json({ detail: "Couldn’t remove “Shot 2”. It’s still running. Stop the run first.",
      code: 'rendering_shots', rendering: { shotIds: ['s2'] } }, 409); };
    backend([rendering, ok]);
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(30);
    useGraphStore.getState().undo();
    await sleep(60);
    release();
    await sleep(200);
    expect(brief()).toEqual(['s1:a', 's2:b']);
    expect(said).toEqual([]);
    expect(unsaved()).toBeNull();
  });

  it('L4: a rendering 409 whose resend is refused the same way says it once', async () => {
    const rendering = () => json({ detail: "Couldn’t remove “Shot 2”. It’s still running. Stop the run first.",
      code: 'rendering_shots', rendering: { shotIds: ['s2'], shots: [2], stoppable: true } }, 409);
    backend([rendering]);
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(300);
    expect(said).toEqual(["Couldn’t remove “Shot 2”. It’s still running. Stop the run first."]);
  });

  it('L5: the person\'s own switch in another window', async () => {
    backend([() => json({ detail: 'This canvas is out of date.', code: 'workspace_moved', project: { id: 'B', name: 'B' },
      switchedBy: { kind: 'person', name: 'You' } }, 409)]);
    typeIn('s1', 'typed');
    await sleep(80);
    // PR #198 fix round 12 (GM r20 answer 3): the switch's own handling says
    // it (projectStore's outdated-workspace banner); the scene says nothing.
    expect(said).toEqual([]);
  });
});
