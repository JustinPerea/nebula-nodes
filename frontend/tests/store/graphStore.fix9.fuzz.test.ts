import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 9 (review 8, H-1): the reviewer's three-actor fuzz as a
 * test. One Cinema scene, three actors on disjoint fields: the person types
 * into Shot 1 on this tab, Codex writes Shot 2 (and sometimes reorders), and
 * a second window writes Shot 3 with a conditional write. The keyed backend
 * does what main.py does (sceneKey, sceneRev, 409 scene_changed, the agent
 * rule); the socket delivers every sync late and in order, with random lag;
 * in `flaky`, 15% of the tab's saves fail with a 500.
 * Invariants at the end: every actor's last value is on the backend, in
 * Codex's order; the card shows the backend's scene; no clash (the fields
 * are disjoint); nothing said; no "Unsaved" mark.
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
let windowHandler: ((event: unknown) => void) | null = null;
const socketSends = (event: Record<string, unknown>) => {
  for (const handler of transport.handlers) handler(event);
  windowHandler?.(event);
};

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
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sceneOf = (shots: Shot[]) => ({ version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots });
const cinema = (shots: Shot[]) => ({ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
  data: { label: 'Opening', definitionId: 'cinema-scene', params: { scene: sceneOf(shots) }, state: 'idle', outputs: {} } });
const nodeOf = (id: string) => useGraphStore.getState().nodes.find((n: { id: string }) => n.id === id);
const shotsOf = () => ((nodeOf('n1')?.data.params.scene as { shots: Shot[] } | undefined)?.shots ?? []);
const brief = (shots: Shot[]) => shots.map((s) => `${s.id}:${s.prompt}`).join('|');
let said: string[] = [];
const AGENT = { edit: { id: 'ed_agent', actor: { kind: 'agent', name: 'Codex' } } };
const WINDOW = { edit: { id: 'ed_window', actor: { kind: 'person', name: 'You' }, tab: 'tab-other' } };
const OWN = () => ({ edit: { id: `ed_own${Math.random()}`, actor: { kind: 'person', name: 'You' }, tab: TAB_ID } });

function rng(seed: number) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  await apiFetch('/api/health').catch(() => null);
  fetchMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a', canvas: 'c1' } as never);
  useGraphStore.getState().resetExecution();
  store.clearCinemaScenePersistence();
  store.setSceneRetryDelaysForTests([20, 20, 20]);
  said = [];
  windowHandler = null;
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], activeRuns: [], unsavedScenes: {}, sceneClashes: {},
    stoppedScenes: {}, isExecuting: false, backendFreshStartPending: false, undoNotice: null, messageNotice: null, isImportingGraph: false,
    runHistory: [], providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null,
    notify: (text: string) => { said.push(text); } } as never);
});

type Opts = { seed: number; personOps: number; codexOps: number; windowOps: number; failRate: number; maxLat: number };
let revisionCounter = 5000;

async function run(o: Opts): Promise<string[]> {
  const r = rng(o.seed);
  const lat = () => Math.floor(r() * o.maxLat);
  store.clearCinemaScenePersistence();
  useGraphStore.setState({ nodes: [], edges: [], sceneClashes: {}, unsavedScenes: {}, stoppedScenes: {} } as never);
  said = [];
  const state = { shots: [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }, { id: 's3', prompt: 'c' }] as Shot[], rev: (revisionCounter += 1) };
  const keyOf = () => JSON.stringify(state.shots.map((s) => [s.id, s.prompt]));
  let writer: object | null = null;
  const snapshot = () => ({ nodes: [cinema(clone(state.shots))], edges: [], sceneKeys: { n1: keyOf() }, sceneRevs: { n1: state.rev } });
  let ws: Promise<void> = Promise.resolve();
  const broadcast = (origin: object) => {
    const event = { type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...snapshot(), ...origin };
    const delay = lat();
    ws = ws.then(() => sleep(delay)).then(() => socketSends(event));
  };
  const commit = (shots: Shot[]) => {
    const before = keyOf();
    state.shots = clone(shots);
    if (keyOf() !== before) state.rev = (revisionCounter += 1);
  };
  let windowView = { shots: clone(state.shots), key: keyOf() };
  windowHandler = (event: unknown) => {
    const e = event as { nodes?: { id: string; data: { params: { scene: { shots: Shot[] } } } }[]; sceneKeys?: Record<string, string> };
    const n1 = e.nodes?.find((n) => n.id === 'n1');
    if (n1 && e.sceneKeys?.n1) windowView = { shots: clone(n1.data.params.scene.shots), key: e.sceneKeys.n1 };
  };
  socketSends({ type: 'graphSync', ...base, canvasRevision: 'c1', empty: false, ...snapshot() });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'PUT' && path.includes('/api/graph/node/n1')) {
      const body = JSON.parse(String(init.body));
      await sleep(lat());
      if (r() < o.failRate) { await sleep(lat()); return json({ detail: 'boom' }, 500); }
      if (body.ifSceneKey && body.ifSceneKey !== keyOf()) {
        const answer = { detail: 'changed', code: 'scene_changed', scene: sceneOf(clone(state.shots)), sceneKey: keyOf(),
          sceneRev: state.rev, changedBy: writer };
        await sleep(lat());
        return json(answer, 409);
      }
      commit(body.params.scene.shots);
      writer = { kind: 'person', name: 'You' };
      const answer = { id: 'n1', sceneKey: keyOf(), sceneRev: state.rev };
      broadcast(OWN());
      await sleep(lat());
      return json(answer);
    }
    if (path.includes('/api/graph/export')) return json({ ...base, canvasRevision: 'c1', empty: false, ...snapshot() });
    return json({});
  });
  const want = { s1: 'a', s2: 'b', s3: 'c', order: ['s1', 's2', 's3'] };
  let codexRead: string | null = null;
  let codexView: Shot[] = clone(state.shots);
  const person = (async () => {
    for (let i = 1; i <= o.personOps; i += 1) {
      await sleep(2 + Math.floor(r() * 25));
      const value = `p${i}`;
      useGraphStore.getState().updateScene('n1', (current: { shots: Shot[] }) => ({ ...current,
        shots: current.shots.map((shot) => (shot.id === 's1' ? { ...shot, prompt: value } : shot)) }));
      want.s1 = value;
    }
  })();
  // Codex: the agent rule (a write on a stale read is refused; it reads again).
  const codex = (async () => {
    for (let i = 1; i <= o.codexOps; i += 1) {
      await sleep(5 + Math.floor(r() * 40));
      if (codexRead === null || r() < 0.4) { codexRead = keyOf(); codexView = clone(state.shots); }
      await sleep(lat());
      const value = `c${i}`;
      const reorder = r() < 0.25;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let shots = codexView.map((s) => (s.id === 's2' ? { ...s, prompt: value } : s));
        if (reorder) { const [a, b, c] = shots; shots = [a, c, b].filter(Boolean); }
        if (codexRead !== keyOf()) { codexRead = keyOf(); codexView = clone(state.shots); continue; }
        commit(shots);
        writer = { kind: 'agent', name: 'Codex' };
        codexRead = keyOf(); codexView = clone(state.shots);
        want.s2 = value;
        want.order = state.shots.map((s) => s.id);
        broadcast(AGENT);
        break;
      }
    }
  })();
  // The second window: a conditional write from what its own socket showed.
  const win = (async () => {
    for (let i = 1; i <= o.windowOps; i += 1) {
      await sleep(5 + Math.floor(r() * 40));
      const value = `w${i}`;
      let view = clone(windowView);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const shots = view.shots.map((s) => (s.id === 's3' ? { ...s, prompt: value } : s));
        await sleep(lat());
        if (view.key !== keyOf()) { view = { shots: clone(state.shots), key: keyOf() }; await sleep(lat()); continue; }
        commit(shots);
        writer = { kind: 'person', name: 'You' };
        want.s3 = value;
        broadcast(WINDOW);
        break;
      }
    }
  })();
  await Promise.all([person, codex, win]);
  const settled = () => {
    const backendNow = { s1: state.shots.find((s) => s.id === 's1')?.prompt, s2: state.shots.find((s) => s.id === 's2')?.prompt,
      s3: state.shots.find((s) => s.id === 's3')?.prompt, order: state.shots.map((s) => s.id) };
    const problems: string[] = [];
    if (backendNow.s1 !== want.s1) problems.push(`person lost: backend s1=${backendNow.s1}, want ${want.s1}`);
    if (backendNow.s2 !== want.s2) problems.push(`codex lost: backend s2=${backendNow.s2}, want ${want.s2}`);
    if (backendNow.s3 !== want.s3) problems.push(`window lost: backend s3=${backendNow.s3}, want ${want.s3}`);
    if (JSON.stringify(backendNow.order) !== JSON.stringify(want.order)) problems.push(`order lost: ${backendNow.order}, want ${want.order}`);
    if (brief(shotsOf()) !== brief(state.shots)) problems.push(`card differs: card ${brief(shotsOf())}, backend ${brief(state.shots)}`);
    const clash = useGraphStore.getState().sceneClashes.n1 ?? null;
    if (clash) problems.push(`clash on disjoint fields: ${clash.line}`);
    // A failed save says its line while it is out (flaky); with none, nothing is said.
    if (said.length && o.failRate === 0) problems.push(`said: ${said.join(' / ')}`);
    const mark = useGraphStore.getState().unsavedScenes.n1 ?? null;
    if (mark) problems.push(`unsaved mark left: ${mark}`);
    return problems;
  };
  await ws;
  // Settle: the last save, its retries (flaky) and the last syncs.
  let problems = settled();
  for (let waited = 0; problems.length > 0 && waited < 3000; waited += 50) {
    await sleep(50);
    await ws;
    problems = settled();
  }
  return problems.map((problem) => `seed ${o.seed}: ${problem}`);
}

describe('three actors on one scene, the socket late (review 8, H-1)', () => {
  it('disjoint fields: nobody\'s change is lost, the card is the backend\'s, nothing asks', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 12; seed += 1) {
      problems.push(...await run({ seed, personOps: 14, codexOps: 5, windowOps: 4, failRate: 0, maxLat: 12 }));
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('flaky: 15% of the tab\'s saves fail; the same, once the retries land', async () => {
    const problems: string[] = [];
    for (let seed = 101; seed <= 112; seed += 1) {
      problems.push(...await run({ seed, personOps: 12, codexOps: 4, windowOps: 3, failRate: 0.15, maxLat: 12 }));
    }
    expect(problems).toEqual([]);
  }, 60_000);
});
