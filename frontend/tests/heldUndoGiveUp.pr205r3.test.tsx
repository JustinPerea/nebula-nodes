import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

// PR #205 round 3, review 2 of the held Undo's give-up line and its guards.
// - Undo LOW-1 (P11): "Try Undo again" is true only while its Delete's step
//   is next in line. A newer step above it (or a late ok with the step no
//   longer on top) takes the line off; Undo then never meets a false line.
// - Undo NIT-2: the guards with no test, M7 (forgetRemoved walks the steps
//   re-pushed in its place), M9 (a late ok on top keeps the line), M10 (only
//   that Delete's own answer takes its place) and M14 (a new canvas takes it
//   off: the line never stands over another graph).

const fake = vi.hoisted(() => ({
  backend: null as unknown as FakeNebula,
  override: null as null | ((path: string, init?: RequestInit) => Promise<Response> | null),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => fake.override?.(path, init) ?? fake.backend.apiFetch(path, init),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { forgetHeldHistoryForTests, useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { STALE_CANVAS_DETAIL, setProjectContext } from '../src/lib/projectContext';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const lines = () => [store().undoNotice?.text, store().messageNotice?.text].filter(Boolean) as string[];
const bringBack = (names: string) => `Nebula couldn’t bring back ${names}. Try Undo again.`;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
/** A Delete of `id` that Nebula refuses (409), its answer on its way like the others. */
const refuseDeleteOf = (id: string) => {
  fake.override = (path, init) => (init?.method === 'DELETE' && path === `/api/graph/node/${id}`
    ? nebula().later(`refused ${id}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }))
    : null);
};
const refuseRestores = () => {
  const before = fake.override;
  fake.override = (path, init) => (path === '/api/graph/restore'
    ? Promise.resolve(new Response(JSON.stringify({ detail: 'Nebula refused it.' }), { status: 409 }))
    : before?.(path, init) ?? null);
};
let clock = Date.now();

describe('PR #205 round 3: the give-up line', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    clock += 600_000;
    vi.setSystemTime(clock);
    nebula().tab = TAB_ID;
    nebula().emit = emit;
    fake.override = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    fake.override = null;
    nebula().holdEchoes = false;
    nebula().holdAnswers = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer()) await settle();
    await settle();
    await tick(20_000);
    forgetHeldHistoryForTests();
    setProjectContext(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const start = (nodes: FakeNode[]) => {
    nebula().reset(nodes, []);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node)), edges: [], isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  /** Delete `id` with its answer held, press Undo, and let the 15 s limit pass. */
  const giveUpOn = async (id: string) => {
    nebula().holdAnswers = true;
    store().deleteNode(id);
    await tick(10);
    store().undo();
    await tick(15_100);
    await settle();
  };

  it('P11 (undo LOW-1): a newer edit after the give-up takes "Try Undo again" off; the late ok and the next Undo never bring it back', async () => {
    start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Brief' }]);
    await giveUpOn('n2');
    expect(lines()).toEqual([bringBack('“Brief”')]);
    store().updateNodeData('n1', { params: { value: 'NEWER' } });
    await tick(400); await settle();
    expect(lines().join(' ')).not.toMatch(/Try Undo again/);
    // The Delete's late ok, then the person's edit's answer.
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await tick(6000); await settle();
    expect(lines().join(' ')).not.toMatch(/Try Undo again/);
    store().undo(); await settle(); await tick(6000); await settle();
    // Undo undid the newer edit, as the canvas no longer said otherwise.
    expect(valueOf('n1')).toBe('n1');
    expect(ids()).toEqual(['n1']);
    expect(lines().join(' ')).not.toMatch(/Try Undo again/);
  });

  it('a rewrite of the steps that leaves the Delete\'s step next in line keeps "Try Undo again" (it is still true)', async () => {
    start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Brief' }]);
    await giveUpOn('n2');
    expect(lines()).toEqual([bringBack('“Brief”')]);
    useGraphStore.setState((state) => ({ undoStack: [...state.undoStack] }));
    expect(lines()).toEqual([bringBack('“Brief”')]);
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle();
    store().undo(); await settle(); await tick(6000); await settle();
    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('M9: a late ok with the step on top keeps "Try Undo again" (still true) beside the Delete\'s own line', async () => {
    start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Brief' }]);
    nebula().holdAnswers = true;
    store().deleteNode('n2');
    await tick(10);
    store().undo();
    useGraphStore.setState({ undoNotice: { id: 9_001, text: 'Something else failed.', offer: null, tone: 'error' } } as never);
    await tick(15_100); await settle();
    expect(store().messageNotice?.text).toBe(bringBack('“Brief”'));
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle();
    expect(store().messageNotice?.text).toBe(bringBack('“Brief”'));
    expect(store().undoNotice?.text).toBe('Deleted the node.');
    // And it is true: Undo brings it back.
    store().undo(); await settle(); await tick(6000); await settle();
    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('M10: another Delete\'s late refusal never takes the place of this Delete\'s give-up line', async () => {
    start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Brief' }, { ...textFakeNode('n3'), label: 'Note' }]);
    refuseDeleteOf('n2');
    nebula().holdAnswers = true;
    store().deleteNode('n2');
    await tick(10);
    store().deleteNode('n3');
    await tick(10);
    store().undo();
    // Beside an error line, the give-up line is the message (besideFailure).
    useGraphStore.setState({ undoNotice: { id: 9_001, text: 'Something else failed.', offer: null, tone: 'error' } } as never);
    await tick(15_100); await settle();
    expect(store().messageNotice?.text).toBe(bringBack('“Note”'));
    // The Brief Delete's refusal (answered first); Note's is still on its way.
    nebula().releaseAnswer(0); await settle();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().messageNotice?.text).toBe(bringBack('“Note”'));
    expect(store().undoNotice?.text).toMatch(/^Couldn.t delete/);
  });

  it('M14: a new canvas takes the give-up line off (it named the old graph\'s node)', async () => {
    start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Brief' }]);
    await giveUpOn('n2');
    expect(lines()).toEqual([bringBack('“Brief”')]);
    store().loadGraph([canvasNode(textFakeNode('n7'))], []);
    await settle();
    expect(lines().join(' ')).not.toMatch(/Try Undo again/);
  });

  it('M12: a late refusal with no line of its own (Nebula says the canvas is out of date while a cut-off write answers) takes the give-up line off', async () => {
    start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Brief' }]);
    nebula().holdAnswers = true;
    // A write for this canvas still on its way when another canvas opens.
    store().updateNodeData('n1', { params: { value: 'TYPED' } });
    await tick(400); await settle();
    store().loadGraph([canvasNode(textFakeNode('n1')), canvasNode({ ...textFakeNode('n2'), label: 'Brief' })], []);
    await settle();
    fake.override = (path, init) => (init?.method === 'DELETE' && path === '/api/graph/node/n2'
      ? nebula().later('stale n2', () => new Response(JSON.stringify({ detail: STALE_CANVAS_DETAIL }), { status: 409 }))
      : null);
    store().deleteNode('n2');
    await tick(10);
    store().undo();
    await tick(15_100); await settle();
    expect(lines()).toContain(bringBack('“Brief”'));
    // The refusal (the newest answer held); the cut-off write is still out.
    nebula().releaseAnswer(nebula().answers.length - 1); await settle();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(lines().join(' ')).not.toMatch(/Try Undo again/);
  });

  it('M7: a two-node Delete re-pushed by one node\'s echo, the other refused: Undo names (and brings back) only the one that left', async () => {
    start([textFakeNode('n1'), { ...textFakeNode('n2'), label: 'Brief' }, { ...textFakeNode('n3'), label: 'Note' }]);
    refuseDeleteOf('n2');
    nebula().holdAnswers = true;
    nebula().holdEchoes = true;
    store().deleteCanvasElements(['n2', 'n3'], []);
    await tick(10);
    // Codex's edit to n1 lands and settles above the Delete's step.
    emit({ nodes: FakeNebula.syncNodes({ nodes: [{ ...textFakeNode('n1'), params: { value: 'AGENT' } }, ...[...nebula().nodes.values()].filter((node) => node.id !== 'n1')], edges: [] }),
      edges: [], empty: false, edit: { actor: { kind: 'agent', name: 'Codex', id: 'codex' }, id: 'ed_ag' } });
    await settle();
    // Note's echo takes it off there while the canvas still shows it, so the
    // Delete's step is re-pushed above Codex's (placeEchoedDeletes). Since
    // round 18 a Delete's nodes leave the canvas when it is pressed, so this
    // state is set by hand: the walk is kept as the guard for that path.
    useGraphStore.setState({ nodes: [...store().nodes, canvasNode({ ...textFakeNode('n3'), label: 'Note' })] });
    nebula().deliverEchoes(); await settle();
    expect(store().undoStack.at(-1)?.kind).not.toBe('foreign');
    // An Undo held on it, then the answers: Brief refused (it comes back),
    // Note ok; the held Undo's restore is refused.
    store().undo(); await settle();
    refuseRestores();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await tick(6000); await settle();
    expect(ids()).toEqual(['n1', 'n2']);
    const said = lines().join(' ');
    expect(said).toMatch(/Note/);
    expect(said).not.toMatch(/Brief/);
  });
});
