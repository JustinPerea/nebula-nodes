/**
 * Round 23 of PR #195 (review 22, L-2), against the fake Nebula of round 17:
 * the same-canvas adoption across a restart trusts `canvasSyncBoot`, the
 * backend process the canvas last took a sync from. A canvas loaded over
 * HTTP (a project load, an import) or replaced (a clear) is a new canvas:
 * nothing the tab holds says which process served it, so it never inherits
 * the boot of the canvas before. Until a sync of its own names one, a
 * restart reads as what it may be, a replacement, named (the safe side).
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

describe('review 22 L-2: a loaded or replaced canvas never inherits the previous boot', () => {
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

  const missedClearAndReadd = () => {
    const n1 = nebula().nodes.get('n1')!;
    nebula().nodes.set('n1', { ...n1, params: { ...n1.params, value: 'AG' } });
  };

  it('STALEBOOT: the project loaded in boot B before any sync of B, then a missed agent clear re-adds n1', async () => {
    start([textFakeNode('n1')], '1', 'boot-A');
    await settle();
    // Nebula restarted (boot-B, its revisions file lost); the tab was on
    // Projects and opened the project again over HTTP: B's base revision.
    setProjectContext({ id: 'p1', revision: 'r1', canvas: BASE });
    expect(store().loadProjectGraph([canvasNode(textFakeNode('n1'))], [], [])).toBe(true);
    type('n1', 'Mine (typed for the old n1)');
    await tick(50);
    missedClearAndReadd();
    sync('1793000000001', { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    // Never sent to the new canvas's n1.
    expect(puts('n1')).not.toContain('1793000000001');
    expect(nebula().valueOf('n1')).toBe('AG');
    expect(valueOf('n1')).toBe('AG');
    expect(lines()).toEqual(["Couldn't save “Text” for “n1”."]);
  });

  it('the same after an import (loadGraph) over the canvas', async () => {
    start([textFakeNode('n1')], '1', 'boot-A');
    await settle();
    setProjectContext({ id: 'p1', revision: 'r1', canvas: BASE });
    store().loadGraph([canvasNode(textFakeNode('n1'))], []);
    type('n1', 'Mine (typed for the old n1)');
    await tick(50);
    missedClearAndReadd();
    sync('1793000000001', { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(puts('n1')).not.toContain('1793000000001');
    expect(nebula().valueOf('n1')).toBe('AG');
  });

  it('a canvas that took a sync of its own after the load still adopts across a later restart (L-a holds)', async () => {
    start([textFakeNode('n1'), textFakeNode('n2')], '1', 'boot-A');
    await settle();
    expect(store().loadProjectGraph([canvasNode(textFakeNode('n1')), canvasNode(textFakeNode('n2'))], [], [])).toBe(true);
    // The loaded canvas's first sync names its process.
    sync('1', { bootId: 'boot-A' });
    await settle();
    refuseCanvas('1');
    type('n2', 'Typed after the restart');
    await tick(1200);
    await settle();
    sync(BASE, { bootId: 'boot-B', canvasRevisionRestored: false });
    await settle();
    await tick(6000);
    expect(puts('n2')).toEqual(['1', BASE]);
    expect(nebula().valueOf('n2')).toBe('Typed after the restart');
    expect(lines()).toEqual([]);
  });
});
