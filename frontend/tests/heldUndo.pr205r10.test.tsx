import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { ownAddStep } from '../src/lib/canvasUndo';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 10: tests for the held-undo mutants round 9's mutation run left alive (each named
// in its test). Harness as heldUndo.pr205r9.test.tsx: a fake Nebula, echoes and agents' syncs on one
// socket queue, each numbered when Nebula read the graph.

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
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

import { deleteInFlightForTests, forgetHeldHistoryForTests, resetDeletedSceneEditsForTests, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { setProjectContext } from '../src/lib/projectContext';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const initialUi = useUIStore.getState();
const CLI = /^n\d+$/;
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const cliIds = () => ids().filter((id) => CLI.test(id));
const nodeOf = (id: string) => store().nodes.find((node) => node.id === id);
const valueOf = (id: string) => nodeOf(id)?.data.params.value;
const labelOf = (id: string) => nodeOf(id)?.data.label;
const wires = () => store().edges.map((edge) => `${edge.source}>${edge.target}`).sort();
const cliWires = () => wires().filter((wire) => wire.split('>').every((end) => CLI.test(end)));
const notice = () => store().undoNotice?.text ?? null;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const sameAsNebula = () => {
  expect(cliIds()).toEqual(nebula().ids());
  for (const id of cliIds()) {
    expect(valueOf(id)).toEqual(nebula().valueOf(id));
    expect(labelOf(id)).toEqual(nebula().nodes.get(id)?.label);
  }
  expect(cliWires()).toEqual(nebula().wires());
};
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
const claude = { actor: { kind: 'agent', name: 'Claude', id: 'claude' } };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let clock = Date.now();

describe('PR #205 round 9: no sync older than an edit Nebula answered OK undoes it', () => {
  const snapGraph = () => ({ nodes: [...nebula().nodes.values()].map(clone), edges: clone(nebula().edges) });
  const fireOf = (graph: ReturnType<typeof snapGraph>, seq: number | null, edit?: Record<string, unknown>) => () => emit({
    nodes: FakeNebula.syncNodes(graph), edges: graph.edges, empty: graph.nodes.length === 0,
    ...(seq === null ? {} : { syncSeq: seq }), ...(edit ? { edit } : {}) });

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
    delete (nebula() as unknown as { broadcast?: unknown }).broadcast;
    fake.override = null;
    nebula().holdEchoes = false;
    nebula().holdAnswers = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer()) await settle();
    await settle();
    await tick(20_000);
    forgetHeldHistoryForTests();
    resetDeletedSceneEditsForTests();
    setProjectContext(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
    useUIStore.setState(initialUi, true);
  });
  const start = (nodes: FakeNode[], edges: FakeWire[] = []) => {
    nebula().reset(nodes, edges);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node)),
      edges: edges.map((edge) => ({ ...edge, type: 'typed-edge', data: { dataType: 'Text' } })) as Edge[],
      isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  const two = () => start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
  /** An agent's edit synced at once (numbered now). */
  /** An agent's edit synced at once (numbered now). */
  const agentDoes = (who: Record<string, unknown>, id: string, change: () => void) => {
    nebula().request += 1;
    change();
    fireOf(snapGraph(), nebula().nextSyncSeq(), { ...who, id })();
  };
  const releaseAll = async () => {
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle(); await tick(6000); await settle();
  };
  const deleteLanded = async (id: string) => {
    store().onNodesChange([{ id, type: 'remove' }]);
    await settle(); await tick(6000); await settle();
  };
  const undo = async () => { store().undo(); await settle(); await tick(6000); await settle(); };
  const refuseLabel = (path: string, init?: RequestInit) => (init?.method === 'PUT' && /\/label$/.test(path)
    ? nebula().later('label refused', () => new Response(JSON.stringify({ detail: 'No.' }), { status: 500 })) : null);
  const refuseRestore = (path: string) => (path === '/api/graph/restore'
    ? Promise.resolve(new Response(JSON.stringify({ detail: 'No.' }), { status: 409 })) : null);

  // ---- whenSyncedNullWaits ----
  // Nebula's answer names no sync, and this tab has applied no numbered one yet: nothing else would
  // ever end a wait, so the answer is handled at once. (A wait for "a sync" whose number is none
  // would hang here: newestSyncSeq is still null.)
  it('whenSyncedNullWaits: a Delete whose answer names no sync is handled at once, before any numbered sync', async () => {
    two();
    nebula().emit = () => {};
    fake.override = (path, init) => (init?.method === 'DELETE' && path === '/api/graph/node/n1'
      ? fake.backend.apiFetch(path, init).then(() => new Response(JSON.stringify({ status: 'deleted', id: 'n1' }), { status: 200 })) : null);
    await deleteLanded('n1');
    expect(deleteInFlightForTests()).toBe(false);
    expect(notice()).toBe('Deleted the node.');
    expect(cliIds()).toEqual(['n2']);
  });

  // ---- restoreRefusedWiresKept ----
  // A refused restore ends the wire holds it took. The person connected n1 to n2 (Nebula has it) and
  // Undo asks Nebula to take it off: that hold wants it off. Nebula refuses, the canvas puts the
  // connection back, and no hold may remain that would take it off again on the next sync.
  it('restoreRefusedWiresKept: a refused Undo of a connection leaves no hold: the next sync keeps it, as Nebula has it', async () => {
    two();
    store().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' });
    await settle(); await tick(6000); await settle();
    expect(nebula().wires()).toEqual(['n1>n2']);
    fake.override = refuseRestore;
    await undo();
    fake.override = null;
    expect(nebula().wires()).toEqual(['n1>n2']);
    expect(cliWires()).toEqual(['n1>n2']);
    agentDoes(claude, 'ed_r10wires00001', () => { nebula().nodes.get('n2')!.label = 'Claude'; }); await settle();
    expect(cliWires()).toEqual(['n1>n2']);
    sameAsNebula();
  });

  // ---- acceptedNotUnnamed ----
  // A refused rename takes the name out of every step that captured it, an accepted add's node too.
  it('acceptedNotUnnamed: a refused rename goes out of an accepted add\'s node as well', async () => {
    two();
    const before = nodeOf('n1')!;
    const accepted = { ...before, data: { ...before.data, label: 'MINE' } };
    const step = ownAddStep(['n1'], [], [accepted]);
    useGraphStore.setState({ undoStack: [step] } as never);
    fake.override = refuseLabel;
    nebula().holdAnswers = true;
    store().renameNode('n1', 'MINE'); await settle();
    await releaseAll(); fake.override = null;
    expect(labelOf('n1')).toBe(before.data.label);
    expect(step.accepted?.n1.data.label).toBe(before.data.label);
  });
});
