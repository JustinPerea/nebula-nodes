/**
 * Round 22 of PR #195 (review 21, L-a and L-b), against the fake Nebula of
 * round 17. Nebula restarted without canvas-revisions.json, so its canvas
 * revisions start again from a boot-unique base and every sync says
 * `canvasRevisionRestored: false` for that run.
 * - L-a: typing sent before the socket's first sync is refused as out of
 *   date (the old canvas header). It is kept and sent again under the
 *   adopted revision once that sync shows the same canvas; when the sync is
 *   another canvas, the line names it. Never lost with no line.
 * - L-b: the same-canvas adoption happens only across an actual restart
 *   (the sync's `bootId` differs from the one the canvas last synced with),
 *   once per boot. A missed agent clear in the same boot that re-adds the
 *   same ids reads as a replacement: old typing never lands on its n1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

const fake = vi.hoisted(() => ({
  backend: null as unknown as FakeNebula,
  sent: [] as Array<{ method: string; path: string; context: unknown }>,
  ctxNow: (() => null) as () => unknown,
  override: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit, options?: { project?: unknown }) => {
    const context = options && 'project' in options ? options.project : fake.ctxNow();
    fake.sent.push({ method: init?.method ?? 'GET', path, context });
    return fake.override ? fake.override(path, init) : fake.backend.apiFetch(path, init);
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { STALE_CANVAS_DETAIL, getProjectContext, setProjectContext } from '../src/lib/projectContext';
import { resetBackendConnectionForTests } from '../src/lib/backendConnection';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const store = () => useGraphStore.getState();
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const nodeOf = (id: string) => store().nodes.find((node) => node.id === id);
const lines = () => [store().undoNotice?.text, store().messageNotice?.text].filter(Boolean);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const type = (id: string, value: string) => { store().updateNodeData(id, { params: { ...nodeOf(id)!.data.params, value } }); };
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
/** The graph Nebula holds, as a sync carries it. */
const sync = (canvas: string, extra: Record<string, unknown> = {}) => emit({
  nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
  empty: nebula().nodes.size === 0, workspaceRevision: 'r1', canvasRevision: canvas, ...extra });
const puts = (id: string) => fake.sent.filter((s) => s.method === 'PUT' && s.path === `/api/graph/node/${id}`)
  .map((s) => (s.context as { canvas?: string } | null)?.canvas);
/** A param write naming `canvas` is refused as out of date, as Nebula answers it. */
const refuseCanvas = (canvas: string) => {
  fake.override = (path, init) => {
    const context = fake.sent[fake.sent.length - 1]?.context as { canvas?: string } | null;
    if (init?.method === 'PUT' && path.startsWith('/api/graph/node/') && context?.canvas === canvas) {
      nebula().calls.push({ path, method: 'PUT' });
      return nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: STALE_CANVAS_DETAIL }), { status: 409 }));
    }
    return nebula().apiFetch(path, init);
  };
};

const BASE = '1793000000000';
let clock = Date.now();

describe('review 21: a restart that lost the canvas revisions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    clock += 600_000;
    vi.setSystemTime(clock);
    resetBackendConnectionForTests();
    nebula().tab = TAB_ID;
    nebula().emit = emit;
    fake.sent = [];
    fake.ctxNow = getProjectContext;
    fake.override = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    fake.override = null;
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer());
    await settle();
    await tick(20_000);
    store().finishCanvasReplacement?.(null);
    setProjectContext(null);
    resetBackendConnectionForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const start = (nodes: FakeNode[], canvas: string, boot: string) => {
    setProjectContext({ id: 'p1', revision: 'r1', canvas });
    nebula().reset(nodes, []);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node)), edges: [], isExecuting: false,
      backendFreshStartPending: false, undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
    // The socket's first message from the process the tab is on.
    sync(canvas, { bootId: boot });
  };

  it('L5W: typing refused before the first sync goes out again under the adopted revision and lands', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')], '1', 'boot-A');
    await settle();
    // Nebula restarts (boot-B) with no revisions file: a write naming "1" is out of date.
    refuseCanvas('1');
    type('n2', 'Typed after the restart');
    await tick(1200);
    await settle();
    expect(puts('n2')).toEqual(['1']);
    // The reconnected socket's first sync: the same canvas, the boot's base.
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(getProjectContext()?.canvas).toBe(BASE);
    expect(puts('n2')).toEqual(['1', BASE]);
    expect(nebula().valueOf('n2')).toBe('Typed after the restart');
    expect(valueOf('n2')).toBe('Typed after the restart');
    expect(lines()).toEqual([]);
  });

  it('L5W, the answer after the sync: the refused typing is sent again at once', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')], '1', 'boot-A');
    await settle();
    refuseCanvas('1');
    nebula().holdAnswers = true;
    type('n2', 'Typed after the restart');
    await tick(1200);
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer());
    await settle();
    await tick(6000);
    expect(puts('n2')).toEqual(['1', BASE]);
    expect(nebula().valueOf('n2')).toBe('Typed after the restart');
    expect(lines()).toEqual([]);
  });

  it('L5W, another canvas after the restart: the refused typing is named, never lost silently', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')], '1', 'boot-A');
    await settle();
    refuseCanvas('1');
    type('n2', 'Typed after the restart');
    await tick(1200);
    await settle();
    // Nebula came back with another canvas (other nodes).
    nebula().reset([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')], []);
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(puts('n2')).toEqual(['1']);
    expect(nebula().valueOf('n2')).toBe('n2');
    expect(lines()).toEqual(["Couldn't save “Text” for “n2”."]);
  });

  it('typing still in its debounce when the restart shows another canvas is named too', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')], '1', 'boot-A');
    await settle();
    type('n2', 'Typing');
    await tick(50);
    nebula().reset([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')], []);
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(puts('n2')).toEqual([]);
    expect(lines()).toEqual(["Couldn't save “Text” for “n2”."]);
  });

  it('L4P: in the same boot, a missed agent clear that re-added the same ids reads as a replacement', async () => {
    start([textFakeNode('n1')], '1', 'boot-A');
    await settle();
    // The restart: adopted once, as the same canvas.
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    expect(getProjectContext()?.canvas).toBe(BASE);
    type('n1', 'Mine (typed for the old n1)');
    await tick(50);
    // A socket gap in the same process: an agent cleared (base+1) and re-added n1 = "AG".
    const n1 = nebula().nodes.get('n1')!;
    nebula().nodes.set('n1', { ...n1, params: { ...n1.params, value: 'AG' } });
    sync('1793000000001', { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(puts('n1')).toEqual([]);
    expect(nebula().valueOf('n1')).toBe('AG');
    expect(valueOf('n1')).toBe('AG');
  });

  it('L4P: a broadcast sync with no bootId in the same boot is the same process too', async () => {
    start([textFakeNode('n1')], '1', 'boot-A');
    await settle();
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    type('n1', 'Mine');
    await tick(50);
    const n1 = nebula().nodes.get('n1')!;
    nebula().nodes.set('n1', { ...n1, params: { ...n1.params, value: 'AG' } });
    sync('1793000000001', { canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(puts('n1')).toEqual([]);
    expect(nebula().valueOf('n1')).toBe('AG');
  });

  it('RSTB: a write still waiting in the tab goes out under the adopted revision', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')], '2', 'boot-A');
    await settle();
    type('n2', 'Typed');
    await tick(50);
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(puts('n2')).toEqual([BASE]);
    expect(nebula().valueOf('n2')).toBe('Typed');
    expect(lines()).toEqual([]);
  });
});
