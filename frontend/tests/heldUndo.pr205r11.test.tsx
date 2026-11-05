import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 11: the held-undo mutants rounds 9 and 10 left alive (each test names its mutant).
// - gap_emptyNoBind: a sync that empties the canvas binds the held links it made to its own step.
// - clearHeldOffEdgeEndsOff: an agent's clear brings back a deleted node's connections only to nodes
//   the clear's Undo also brings back.
// - syncForgetsClearedHeldOffOff: what a clear set aside for its step never reaches a later sync's step.
// The harness is round 8's (round 18's fake Nebula).

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

import { forgetHeldHistoryForTests, useGraphStore } from '../src/store/graphStore';
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
const notice = () => store().undoNotice?.text ?? null;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const undo = async () => { store().undo(); await settle(); await tick(6000); await settle(); };
const redo = async () => { store().redo(); await settle(); await tick(6000); await settle(); };
const sameAsNebula = () => {
  expect(cliIds()).toEqual(nebula().ids());
  for (const id of cliIds()) {
    expect(valueOf(id)).toEqual(nebula().valueOf(id));
    expect(labelOf(id)).toEqual(nebula().nodes.get(id)?.label);
  }
  expect(wires().filter((wire) => wire.split('>').every((end) => CLI.test(end)))).toEqual(nebula().wires());
};
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
const codex = { actor: { kind: 'agent', name: 'Codex', id: 'codex' } };
const claude = { actor: { kind: 'agent', name: 'Claude', id: 'claude' } };
const wire = (source: string, target: string): FakeWire => ({ id: `w-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'text' });
let clock = Date.now();

describe("PR #205 round 11: the held-undo mutants rounds 9 and 10 left alive", () => {
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
    useUIStore.setState(initialUi, true);
  });
  const start = (nodes: FakeNode[], edges: FakeWire[] = [], chosen: string[] = []) => {
    nebula().reset(nodes, edges);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node, chosen.includes(node.id) ? { selected: true } : {})),
      edges: edges.map((edge) => ({ ...edge, type: 'typed-edge', data: { dataType: 'Text' } })) as Edge[],
      isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  /** Nebula changes its graph for an agent and syncs all of it (the agent's edit). */
  const agentDoes = (who: Record<string, unknown>, id: string, change: () => void, extra: Record<string, unknown> = {}) => {
    nebula().request += 1;
    change();
    emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
      empty: nebula().nodes.size === 0, ...extra, edit: { ...who, id } });
  };

  /** Delete n1 and undo it, the restore's answer held after Nebula applied it. */
  const restoreHeld = async () => {
    store().onNodesChange([{ id: 'n1', type: 'remove' }]);
    await settle(); await tick(6000); await settle();
    expect(cliIds()).not.toContain('n1');
    nebula().holdAnswers = true;
    store().undo();
    await settle();
    expect(cliIds()).toContain('n1');
  };
  const releaseAll = async () => {
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle(); await tick(6000); await settle();
  };
  const refuseDelete = (id = 'n1') => {
    fake.override = (path, init) => (init?.method === 'DELETE' && path === `/api/graph/node/${id}`
      ? nebula().later(`refused ${id}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }))
      : null);
  };

  const kinds = () => store().undoStack.map((entry) => { const e = entry as { kind?: string; agentName?: string };
    return e.kind === 'foreign' ? `F(${e.agentName})` : e.kind === 'own-add' ? 'add' : 'own'; });

  const n1 = () => nebula().nodes.get('n1')!;
  const deleteLanded = async (id: string) => {
    store().onNodesChange([{ id, type: 'remove' }]);
    await settle(); await tick(6000); await settle();
  };
  it('gap_emptyNoBind: Claude deletes both nodes in one sync that empties the canvas (same canvas), one of them held by a restore: one step, and one Undo brings both back', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
    await restoreHeld();
    agentDoes(claude, 'ed_r11bind0000001', () => { nebula().nodes.clear(); nebula().edges.length = 0; }, { canvasRevision: 'canvas-1' });
    await settle();
    // The sync took n2 off and left n1 on the canvas, its restore still on its way.
    expect(cliIds()).toEqual(['n1']);
    expect(kinds()).toEqual(['F(Claude)']);
    await releaseAll();
    sameAsNebula();
    expect(cliIds()).toEqual([]);
    // n1's removal joins the step the sync made: one edit, one step.
    expect(kinds()).toEqual(['F(Claude)']);
    await undo();
    expect(notice()).toBe('Undid Claude\u2019s edit.');
    sameAsNebula();
    expect(cliIds()).toEqual(['n1', 'n2']);
    await redo();
    sameAsNebula();
    expect(cliIds()).toEqual([]);
  });

  it('clearHeldOffEdgeEndsOff: an agent clears the canvas while the person\'s Delete of n1 is on its way; n1\'s synced copy still names a wire to n2, which the person deleted (answered, its echo not here yet): the clear\'s Undo brings n1 back without that wire', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')], [wire('n1', 'n2')]);
    let letGo: () => void = () => {};
    const gate = new Promise<void>((resolve) => { letGo = resolve; });
    fake.override = (path, init) => (init?.method === 'DELETE' && path === '/api/graph/node/n1'
      ? gate.then(() => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 })) : null);
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(codex, 'ed_r11edge0000001', () => { n1().params = { value: 'CODEX' }; }); await settle();
    expect(nebula().wires()).toEqual(['n1>n2']);
    nebula().holdEchoes = true;
    await deleteLanded('n2');
    expect(cliIds()).toEqual([]);
    agentDoes(claude, 'ed_r11edge0000002', () => { nebula().nodes.clear(); nebula().edges.length = 0; }); await settle();
    nebula().echoes = [];
    nebula().holdEchoes = false;
    letGo(); await settle(); await tick(6000); await settle();
    expect(cliIds()).toEqual([]);
    expect((store().undoStack.at(-1) as { agentName?: string }).agentName).toBe('Claude');
    // n2 is back in Nebula by a sync nobody signed (no step is made for it).
    nebula().nodes.set('n2', textFakeNode('n2'));
    emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges, empty: false });
    await settle();
    await undo();
    expect(notice()).toBe('Undid Claude\u2019s edit.');
    // n1 comes back as Codex left it; the wire to n2 was gone before the clear, so it is not drawn.
    sameAsNebula();
    expect(cliIds()).toEqual(['n1', 'n2']);
    expect(nebula().valueOf('n1')).toBe('CODEX');
    expect(wires()).toEqual([]);
    expect(nebula().wires()).toEqual([]);
  });

  it('syncForgetsClearedHeldOffOff: an agent\'s clear sync throws after it set aside the node whose Delete was on its way: the next sync\'s step never carries that node', async () => {
    start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
    refuseDelete('n1');
    nebula().holdAnswers = true;
    store().onNodesChange([{ id: 'n1', type: 'remove' }]); await tick(5);
    agentDoes(codex, 'ed_r11thrw0000001', () => { n1().params = { value: 'CODEX' }; }); await settle();
    // Something inside the clear's sync throws once, after the clear took n1 (hydrateProviderStartAmbiguities).
    const real = store().hydrateProviderStartAmbiguities;
    useGraphStore.setState({ hydrateProviderStartAmbiguities: () => { throw new Error('stubbed step'); } } as never);
    expect(() => agentDoes(claude, 'ed_r11thrw0000002', () => { nebula().nodes.clear(); nebula().edges.length = 0; })).toThrow('stubbed step');
    useGraphStore.setState({ hydrateProviderStartAmbiguities: real } as never);
    await settle();
    await releaseAll(); fake.override = null;
    nebula().nodes.set('n3', textFakeNode('n3'));
    agentDoes(codex, 'ed_r11thrw0000003', () => {}); await settle();
    expect(cliIds()).toEqual(['n3']);
    sameAsNebula();
    await undo();
    // The clear that was cut short set n1 aside for its own step; Codex's step was taken without it,
    // so its Undo never puts n1 back, on the canvas or in Nebula.
    expect(notice()).toBe('Undid Codex\u2019s edit.');
    expect(cliIds()).not.toContain('n1');
    expect(nebula().ids()).not.toContain('n1');
    sameAsNebula();
  });
});
