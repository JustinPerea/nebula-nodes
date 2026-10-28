import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 5 (review 5; GM's r6 and r7 rulings), the store side:
 * - H1: a refused shot removal leaves the undo and redo stacks consistent.
 *   Every step pushed while the refused write was out takes the shot back
 *   into its snapshot, so no Undo or Redo ever sends a scene without it
 *   (review 5 P1, P7; the live repro).
 * - M1 / GM r6 item 1: a partial revert. A 409 that names its rendering shots
 *   (`rendering.shotIds`) puts back only those, and the rest of the save goes
 *   again at once: the typing saves, the removal never goes out again.
 * - GM r7 item 1: every whole-save refusal keeps the edits on screen, marked
 *   unsaved, with the line for what clears it.
 * - L1: a removal with no answer is reconciled like a refusal on reconnect,
 *   unless the backend shows it applied.
 * - L2: a failed re-read never leaves the restored shot without its wire.
 * - GM r6 naming rule on both multi-delete lines; N1, a wire-only Delete in a run.
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
const setSceneRetryDelaysForTests = (delays: number[]) => (store as { setSceneRetryDelaysForTests?: (d: number[]) => void }).setSceneRetryDelaysForTests?.(delays);
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { apiFetch } = await import('../../src/lib/backend');
const copy = await import('../../src/lib/sceneSaveCopy');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Shot = Record<string, unknown>;
const sceneOf = (...shots: Shot[]) => ({ scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots } });
const cinema = (id: string, shots: Shot[], label = 'Opening', outputs: Record<string, unknown> = {}) => ({ id, type: 'cinemaSceneNode',
  position: { x: 0, y: 0 }, data: { label, definitionId: 'cinema-scene', params: sceneOf(...shots), state: 'idle', outputs } });
const textNode = (id: string, label = id, text = '') => ({ id, type: 'model-node', position: { x: 300, y: 0 },
  data: { label, definitionId: 'text-input', params: { text }, state: 'idle', outputs: {} } });
const nodeOf = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id);
const shotsOf = (id = 'n1') => ((nodeOf(id)?.data.params.scene as { shots: Shot[] } | undefined)?.shots ?? []);
const brief = (id = 'n1') => shotsOf(id).map((s) => `${s.id}:${s.prompt}${(s.output as { imageUrl?: string } | undefined)?.imageUrl ? '+img' : ''}`);
const edgeHandles = () => useGraphStore.getState().edges.map((e) => e.sourceHandle);
const ids = () => useGraphStore.getState().nodes.map((node) => node.id);
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;
const unsaved = (id = 'n1') => (useGraphStore.getState() as { unsavedScenes?: Record<string, string> }).unsavedScenes?.[id] ?? null;
let said: string[] = [];
let logged: string[] = [];

const REMOVE_LINE = "Couldn't remove “Shot 2”. It's still running. Stop the run first.";
const PAID = '/api/outputs/paid-s2.png';
const RENDERING_409 = { detail: REMOVE_LINE, code: 'rendering_shots', rendering: { shotIds: ['s2'], shots: [2], stoppable: true } };

function backendGraph(s1: Shot = { id: 's1', prompt: 'a' }, s2: Shot | null = { id: 's2', prompt: 'b' }) {
  const shots = s2 ? [s1, s2] : [s1];
  return {
    nodes: [cinema('n1', shots, 'Opening', s2?.output ? { shot_s2: { type: 'Image', value: PAID } } : {}), textNode('n2', 'Grade')],
    edges: s2 ? [{ id: 'e1', type: 'typed-edge', source: 'n1', sourceHandle: 'shot_s2', target: 'n2', targetHandle: 'text',
      data: { dataType: 'Image' } }] : [],
  };
}

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  store.clearCinemaScenePersistence();
  setSceneRetryDelaysForTests([30, 30, 30]);
  said = [];
  logged = [];
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [],
    isExecuting: false, backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [],
    providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (text: string) => { said.push(text); } } as never);
});
window.addEventListener('nebula:agent-log-entry', (event) => { logged.push((event as CustomEvent<{ message: string }>).detail.message); });

/**
 * A backend whose first n1 PUT waits until `release()`, then answers
 * `first` (default: the rendering 409). Later n1 PUTs answer `later` (default
 * 200). Restores, exports and every PUT's shots are recorded.
 */
/** The backend's graph reaches the tab as the app gets it: a graphSync. */
function syncs(graph: object) {
  socketSends({ type: 'graphSync', ...base, empty: false, ...graph });
}

function harness(options: { first?: () => Response; later?: () => Response; exportGraph?: () => object; start?: object } = {}) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [], edges: [] } as never);
  syncs(options.start ?? backendGraph());
  const puts: string[][] = [];
  const restores: string[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  let later = options.later ?? (() => json({ ok: true }));
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'PUT' && path.includes('/api/graph/node/n1')) {
      const body = JSON.parse(String(init.body));
      puts.push(body.params.scene.shots.map((s: Shot) => `${s.id}:${s.prompt}`));
      count += 1;
      if (count === 1) {
        await gate;
        return options.first ? options.first() : json(RENDERING_409, 409);
      }
      return later();
    }
    if (path.includes('/api/graph/restore')) {
      const body = JSON.parse(String(init?.body));
      const n1 = (body.nodes ?? []).find((n: { id: string }) => n.id === 'n1');
      const shots = n1?.data?.params?.scene?.shots ?? n1?.params?.scene?.shots;
      if (shots) restores.push(shots.map((s: Shot) => `${s.id}:${s.prompt}`));
      return json({ ok: true });
    }
    if (path.includes('/api/graph/export')) {
      return json({ ...base, ...(options.exportGraph ? options.exportGraph() : backendGraph()), empty: false });
    }
    return json({});
  });
  return { puts, restores, release: () => release(), answerLater: (answer: () => Response) => { later = answer; } };
}

const typeIn = (shotId: string, prompt: string) => useGraphStore.getState().updateScene('n1', (current) => ({ ...current,
  shots: current.shots.map((shot) => (shot.id === shotId ? { ...shot, prompt } : shot)) }));

// -- H1 + M1: a refused removal while the person kept working ------------------------------

describe('H1: the undo stack after a refused removal (review 5)', () => {
  it('P1: typing in the scene while the removal was out; Undo and Redo after the run never drop Shot 2', async () => {
    const h = harness();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(30);
    typeIn('s1', 'typed while out');
    await sleep(30);
    h.release();
    await sleep(150);
    // Partial revert: Shot 2 back, the typing kept and sent at once without the removal.
    expect(brief()).toEqual(['s1:typed while out', 's2:b']);
    expect(h.puts).toEqual([['s1:a'], ['s1:typed while out', 's2:b']]);
    expect(said).toEqual([REMOVE_LINE]);
    expect(edgeHandles()).toEqual(['shot_s2']);
    // The run ends; its write-back gives Shot 2 its paid image.
    socketSends({ type: 'graphSync', ...base, empty: false, runParams: 'other-run',
      ...backendGraph({ id: 's1', prompt: 'typed while out' }, { id: 's2', prompt: 'b', output: { imageUrl: PAID, status: 'done' } }) });
    await sleep(60);
    expect(brief()).toEqual(['s1:typed while out', 's2:b+img']);
    // Every step left holds Shot 2.
    for (const step of [...useGraphStore.getState().undoStack, ...useGraphStore.getState().redoStack]) {
      const held = (step as { nodes?: { id: string; data: { params: { scene?: { shots: Shot[] } } } }[] }).nodes
        ?.find((n) => n.id === 'n1')?.data.params.scene?.shots.map((s) => s.id);
      if (held) expect(held).toContain('s2');
    }
    useGraphStore.getState().undo();
    await sleep(120);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's2']);
    expect(brief()[1]).toBe('s2:b+img');
    useGraphStore.getState().undo();
    await sleep(120);
    useGraphStore.getState().redo();
    await sleep(120);
    useGraphStore.getState().redo();
    await sleep(120);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's2']);
    for (const restore of h.restores) expect(restore.map((s) => s.split(':')[0])).toContain('s2');
  });

  it('P7: an edit to another node on top; Undo, Undo and Redo never drop Shot 2', async () => {
    const h = harness();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(20);
    useGraphStore.getState().updateNodeData('n2', { params: { text: 'hello' } });
    await sleep(20);
    h.release();
    await sleep(150);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's2']);
    // The refused removal's own step is gone, wherever it sat.
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    useGraphStore.getState().undo();
    await sleep(120);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's2']);
    expect(nodeOf('n2')?.data.params.text).toBe('');
    useGraphStore.getState().undo();
    await sleep(60);
    useGraphStore.getState().redo();
    await sleep(120);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's2']);
    expect(nodeOf('n2')?.data.params.text).toBe('hello');
    for (const restore of h.restores) expect(restore.map((s) => s.split(':')[0])).toContain('s2');
    expect(edgeHandles()).toEqual(['shot_s2']);
  });

  it('a later debounced typing step never overwrites the removal steps it tracks', async () => {
    const h = harness();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(20);
    // updateNodeData's debounced scene path, twice: it must not drop the removal's step from tracking.
    for (const prompt of ['x', 'xy']) {
      const n1 = nodeOf('n1')!;
      const scene = n1.data.params.scene as { shots: Shot[] };
      useGraphStore.getState().updateNodeData('n1', { params: { ...n1.data.params,
        scene: { ...scene, shots: scene.shots.map((s) => (s.id === 's1' ? { ...s, prompt } : s)) } } });
      await sleep(10);
    }
    h.release();
    await sleep(700);
    expect(brief()).toEqual(['s1:xy', 's2:b']);
    expect(h.puts.at(-1)).toEqual(['s1:xy', 's2:b']);
    useGraphStore.getState().undo();
    await sleep(120);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('M1 / GM r6 item 1: the partial revert', () => {
  it('P2: typing then a removal in one PUT: only Shot 2 comes back, the typing saves', async () => {
    const h = harness();
    const n1 = nodeOf('n1')!;
    const scene = n1.data.params.scene as { shots: Shot[] };
    useGraphStore.getState().updateNodeData('n1', { params: { ...n1.data.params,
      scene: { ...scene, shots: scene.shots.map((s) => (s.id === 's1' ? { ...s, prompt: 'typed first' } : s)) } } });
    await sleep(20);
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(20);
    h.release();
    await sleep(150);
    expect(brief()).toEqual(['s1:typed first', 's2:b']);
    expect(h.puts).toEqual([['s1:typed first'], ['s1:typed first', 's2:b']]);
    expect(said).toEqual([REMOVE_LINE]);
    expect(unsaved()).toBeNull();
  });

  it('the restored shot keeps its place, image, port and wire; the removal never goes out again', async () => {
    const h = harness({ start: backendGraph({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b',
      output: { imageUrl: PAID, status: 'done' } }) });
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(20);
    h.release();
    await sleep(150);
    expect(brief()).toEqual(['s1:a', 's2:b+img']);
    const ports = ((nodeOf('n1')?.data as { dynamicOutputPorts?: { id: string }[] }).dynamicOutputPorts ?? []).map((p) => p.id);
    expect(ports).toEqual(['shot_s1', 'shot_s2']);
    typeIn('s1', 'later');
    await sleep(120);
    expect(h.puts.every((put, index) => index === 0 || put.some((s) => s.startsWith('s2:')))).toBe(true);
  });
});

// -- GM r7 item 1: whole-save refusals ------------------------------------------------------

describe('GM r7 item 1: a refusal that can\'t be pinned keeps the edits, marked unsaved', () => {
  it('413: the edits stay, GM\'s line once, and they save once a later save fits', async () => {
    const h = harness({ first: () => json({ detail: 'graph payload contains too many values' }, 413),
      later: () => json({ detail: 'graph payload contains too many values' }, 413) });
    typeIn('s1', 'x'.repeat(50));
    await sleep(20);
    typeIn('s2', 'second field');
    await sleep(20);
    h.release();
    await sleep(150);
    expect(brief()).toEqual([`s1:${'x'.repeat(50)}`, 's2:second field']);
    expect(said).toEqual(["Couldn't save “Opening”. The project is too big to save. Remove something and Nebula will save your changes."]);
    expect(unsaved()).toBe(said[0]);
    h.answerLater(() => json({ ok: true }));
    typeIn('s2', 'shorter');
    await sleep(120);
    expect(h.puts.at(-1)).toEqual([`s1:${'x'.repeat(50)}`, 's2:shorter']);
    expect(unsaved()).toBeNull();
  });

  it('a paid start: kept, and saved by itself when the run ends', async () => {
    const h = harness({ first: () => json({ detail: 'A paid run is starting.', code: 'paid_start' }, 409),
      later: () => json({ detail: 'A paid run is starting.', code: 'paid_start' }, 409) });
    typeIn('s1', 'during the run');
    await sleep(20);
    h.release();
    await sleep(60);
    expect(brief()).toEqual(['s1:during the run', 's2:b']);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. They're kept and will save when the run finishes."]);
    h.answerLater(() => json({ ok: true }));
    socketSends({ type: 'executionComplete', runId: 'other-run' });
    socketSends({ type: 'graphSync', ...base, empty: false, ...backendGraph(), runParams: 'other-run' });
    await sleep(200);
    expect(h.puts.at(-1)).toEqual(['s1:during the run', 's2:b']);
    expect(brief()).toEqual(['s1:during the run', 's2:b']);
    expect(unsaved()).toBeNull();
    expect(said).toHaveLength(1);
  });

  it('an approved run\'s inputs: the same line', async () => {
    const h = harness({ first: () => json({ detail: 'An approved run uses this.', code: 'approved_run' }, 409),
      later: () => json({ ok: true }) });
    typeIn('s1', 'held');
    await sleep(20);
    h.release();
    await sleep(60);
    expect(said[0]).toBe("Couldn't save your changes to “Opening”. They're kept and will save when the run finishes.");
    await sleep(200);
    expect(h.puts.at(-1)).toEqual(['s1:held', 's2:b']);
    expect(unsaved()).toBeNull();
  });

  it('a server error: kept, "Nebula will try again.", and it does', async () => {
    const h = harness({ first: () => json({ detail: 'boom' }, 500), later: () => json({ ok: true }) });
    typeIn('s1', 'retry me');
    await sleep(20);
    h.release();
    await sleep(40);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. They're kept and Nebula will try again."]);
    expect(brief()[0]).toBe('s1:retry me');
    await sleep(200);
    expect(h.puts).toEqual([['s1:retry me', 's2:b'], ['s1:retry me', 's2:b']]);
    expect(unsaved()).toBeNull();
  });

  it('404: deleted in another window, no promise, nothing sent again', async () => {
    const h = harness({ first: () => json({ detail: "That node isn't on the canvas anymore." }, 404) });
    typeIn('s1', 'gone');
    await sleep(20);
    h.release();
    await sleep(150);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. It was deleted in another window."]);
    expect(brief()[0]).toBe('s1:gone');
    expect(h.puts).toHaveLength(1);
  });

  it('the workspace moved: who switched, and to what', async () => {
    const moved = (switchedBy: unknown) => () => json({ detail: 'This canvas is out of date. Open the current project before editing or running it.',
      code: 'workspace_moved', project: { id: 'B', name: 'Moodboards' }, switchedBy }, 409);
    let h = harness({ first: moved({ kind: 'agent', name: 'Codex' }) });
    typeIn('s1', 'moved');
    await sleep(20);
    h.release();
    await sleep(120);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. Codex switched to “Moodboards” first."]);
    expect(h.puts).toHaveLength(1);
    said = [];
    useGraphStore.setState({ notify: (text: string) => { said.push(text); } } as never);
    h = harness({ first: moved(null) });
    typeIn('s1', 'moved again');
    await sleep(20);
    h.release();
    await sleep(120);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. Nebula switched to “Moodboards” first."]);
  });

  it('400: our bug; kept on screen, the detail goes to the Agent log', async () => {
    const h = harness({ first: () => json({ detail: 'params.scene nested too deeply' }, 400) });
    typeIn('s1', 'bad');
    await sleep(20);
    h.release();
    await sleep(120);
    expect(said).toEqual(["Couldn't save your changes to “Opening”. Nebula ran into a problem saving them, so they're kept on screen but not saved."]);
    expect(logged.some((line) => line.includes('params.scene nested too deeply') && line.includes('n1'))).toBe(true);
    expect(brief()[0]).toBe('s1:bad');
    expect(unsaved()).toBe(said[0]);
  });

  it('params outdated: the edits stay on screen for the recovered copy, and the scene adds no line', async () => {
    const h = harness({ first: () => json({ detail: 'Nebula was updated…', code: 'params_outdated', paramsVersion: 999 }, 409) });
    typeIn('s1', 'keep for recovery');
    await sleep(20);
    h.release();
    await sleep(120);
    expect(brief()[0]).toBe('s1:keep for recovery');
    expect(said).toEqual([]);
  });

  it('any other refusal: kept, marked unsaved, the backend\'s line', async () => {
    const h = harness({ first: () => json({ detail: "Couldn't save “Opening”. It's locked." }, 409) });
    typeIn('s1', 'locked');
    await sleep(20);
    h.release();
    await sleep(120);
    expect(said).toEqual(["Couldn't save “Opening”. It's locked."]);
    expect(brief()[0]).toBe('s1:locked');
    expect(unsaved()).toBe(said[0]);
  });

  it('the copy is in constants for GM', () => {
    expect(copy.SCENE_TOO_BIG).toBe('The project is too big to save. Remove something and Nebula will save your changes.');
    expect(copy.KEPT_UNTIL_RUN_ENDS).toBe("They're kept and will save when the run finishes.");
    expect(copy.KEPT_AND_RETRYING).toBe("They're kept and Nebula will try again.");
  });

  it('a kept removal never goes out after a run paid for that shot\'s image', async () => {
    const h = harness({ first: () => json({ detail: 'graph payload contains too many values' }, 413),
      later: () => json({ ok: true }) });
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(20);
    h.release();
    await sleep(120);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1']);
    // Another window's run renders Shot 2 meanwhile and pays for its image.
    socketSends({ type: 'graphSync', ...base, empty: false, runParams: 'other-run',
      ...backendGraph({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b', output: { imageUrl: PAID, status: 'done' } }) });
    await sleep(60);
    typeIn('s1', 'later');
    await sleep(150);
    expect(brief()).toEqual(['s1:later', 's2:b+img']);
    expect(h.puts.at(-1)).toEqual(['s1:later', 's2:b']);
  });
});

// -- L1: no answer ----------------------------------------------------------------------------

describe('L1: a removal with no answer', () => {
  function offlineBackend() {
    syncs(backendGraph());
    const puts: string[][] = [];
    let offline = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'PUT' && path.includes('/api/graph/node/n1')) {
        puts.push(JSON.parse(String(init.body)).params.scene.shots.map((s: Shot) => `${s.id}:${s.prompt}`));
        if (offline) throw new TypeError('Failed to fetch');
        return json({ ok: true });
      }
      return json({});
    });
    return { puts, online: () => { offline = false; } };
  }

  it('the reconnect sync still has Shot 2 (now with its paid image): it comes back with its wire, and no edit sends the removal', async () => {
    const b = offlineBackend();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(80);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1']);
    b.online();
    socketSends({ type: 'graphSync', ...base, empty: false, runParams: 'other-run',
      ...backendGraph({ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b', output: { imageUrl: PAID, status: 'done' } }) });
    await sleep(80);
    expect(brief()).toEqual(['s1:a', 's2:b+img']);
    expect(edgeHandles()).toEqual(['shot_s2']);
    typeIn('s1', 'after');
    await sleep(120);
    expect(b.puts.at(-1)).toEqual(['s1:after', 's2:b']);
    expect(b.puts.slice(1).every((put) => put.some((s) => s.startsWith('s2:')))).toBe(true);
  });

  it('the backend shows the removal applied: it stays removed', async () => {
    const b = offlineBackend();
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(80);
    b.online();
    socketSends({ type: 'graphSync', ...base, empty: false, ...backendGraph({ id: 's1', prompt: 'a' }, null) });
    await sleep(80);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1']);
    expect(edgeHandles()).toEqual([]);
  });

  it('typing kept from the lost write is re-sent without the removal on reconnect', async () => {
    const b = offlineBackend();
    typeIn('s1', 'typed');
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(80);
    b.online();
    socketSends({ type: 'graphSync', ...base, empty: false, ...backendGraph() });
    await sleep(150);
    expect(brief()).toEqual(['s1:typed', 's2:b']);
    expect(b.puts.at(-1)).toEqual(['s1:typed', 's2:b']);
  });
});

// -- L2: the re-read fails ----------------------------------------------------------------------

describe('L2: the re-read after a refusal fails', () => {
  it('the wire comes back from the canvas\'s own record', async () => {
    const h = harness({ exportGraph: () => { throw new Error('unused'); } });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'PUT' && path.includes('/api/graph/node/n1')) {
        return h.puts.push([]) === 1 ? json(RENDERING_409, 409) : json({ ok: true });
      }
      if (path.includes('/api/graph/export')) return json({ detail: 'busy' }, 503);
      return json({});
    });
    useGraphStore.getState().removeShot('n1', 's2');
    await sleep(200);
    expect(shotsOf().map((s) => s.id)).toEqual(['s1', 's2']);
    expect(edgeHandles()).toEqual(['shot_s2']);
  });
});

// -- GM r6 naming rule ---------------------------------------------------------------------------

async function ownRun(nodes: unknown[]) {
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }], 'Opening'), ...nodes] } as never);
  fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/cinema/generate-shot')
    ? json({ status: 'started', runId: 'own-run' }) : json({})));
  void useGraphStore.getState().executeShot('n4', 's2');
  await sleep(60);
  expect(useGraphStore.getState().isExecuting).toBe(true);
}

describe('GM r6: the naming rule on both multi-delete lines', () => {
  it('own run: names up to 3, groups same titles, counts from 4', async () => {
    await ownRun([textNode('n5', 'Brief'), textNode('n6', 'Note'), textNode('n7', 'Text'), textNode('n8', 'Text')]);
    useGraphStore.getState().onNodesChange(['n5', 'n6'].map((id) => ({ id, type: 'remove' as const })));
    expect(notice()).toBe("Couldn't delete “Brief” and “Note”. Wait for the active run to finish.");
    useGraphStore.getState().onNodesChange(['n5', 'n7', 'n8'].map((id) => ({ id, type: 'remove' as const })));
    expect(notice()).toBe("Couldn't delete “Brief” and 2 “Text” nodes. Wait for the active run to finish.");
    useGraphStore.getState().onNodesChange(['n5', 'n6', 'n7', 'n8'].map((id) => ({ id, type: 'remove' as const })));
    expect(notice()).toBe("Couldn't delete 4 nodes. Wait for the active run to finish.");
    expect(notice()).not.toMatch(/n\d/);
  });

  it('another window\'s run: "Deleted “A” and “B”. “Ref scene” wasn\'t deleted because “Shot 1” is still running."', async () => {
    useGraphStore.setState({ nodes: [cinema('n4', [{ id: 's1', prompt: 'a' }], 'Ref scene'), textNode('n5', 'A'), textNode('n6', 'B'),
      textNode('n7', 'Text'), textNode('n8', 'Text')] } as never);
    const sceneLine = "Couldn't delete “Ref scene”. “Shot 1” is still running. Stop the run first.";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE' && String(url).endsWith('/api/graph/node/n4')) {
        return json({ detail: sceneLine, rendering: { shots: [1], shotIds: ['s1'], stoppable: true } }, 409);
      }
      if (init?.method === 'DELETE') return json({ removal: null });
      return json({});
    });
    useGraphStore.getState().onNodesChange(['n4', 'n5', 'n6'].map((id) => ({ id, type: 'remove' as const })));
    await sleep(80);
    expect(notice()).toBe("Deleted “A” and “B”. “Ref scene” wasn't deleted because “Shot 1” is still running.");
    useGraphStore.setState({ undoNotice: null } as never);
    useGraphStore.getState().onNodesChange(['n4', 'n7', 'n8'].map((id) => ({ id, type: 'remove' as const })));
    await sleep(80);
    expect(notice()).toBe("Deleted 2 “Text” nodes. “Ref scene” wasn't deleted because “Shot 1” is still running.");
  });

  it('a plain multi-delete names its nodes; one node keeps "Deleted the node."', async () => {
    useGraphStore.setState({ nodes: [textNode('n5', 'A'), textNode('n6', 'B'), textNode('n7', 'C')] } as never);
    fetchMock.mockImplementation(async () => json({ removal: null }));
    useGraphStore.getState().onNodesChange(['n5', 'n6'].map((id) => ({ id, type: 'remove' as const })));
    await sleep(80);
    expect(notice()).toBe('Deleted “A” and “B”.');
    useGraphStore.getState().onNodesChange([{ id: 'n7', type: 'remove' as const }]);
    await sleep(80);
    expect(notice()).toBe('Deleted the node.');
    expect(ids()).toEqual([]);
  });
});

describe('N1: a wire-only Delete during the tab\'s run says why', () => {
  it('"Couldn\'t delete the connection. Wait for the active run to finish."', async () => {
    await ownRun([textNode('n5', 'Brief')]);
    useGraphStore.setState({ edges: [{ id: 'e9', source: 'n4', sourceHandle: 'shot_s1', target: 'n5', targetHandle: 'text', selected: true }],
      nodes: useGraphStore.getState().nodes.map((node) => ({ ...node, selected: false })) } as never);
    useGraphStore.getState().deleteSelected();
    expect(notice()).toBe("Couldn't delete the connection. Wait for the active run to finish.");
    expect(useGraphStore.getState().edges).toHaveLength(1);
  });
});
