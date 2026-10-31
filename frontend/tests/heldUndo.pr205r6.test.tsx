import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 6: review 5 of the agent steps under a hold (GM r10 item 1).
// - MEDIUM-1: a held change never goes under a step the person took during
//   the hold (O1t, O1u): it is its own step on top then, and every Undo takes
//   back only what it names.
// - LOW-1: the newest held copy keeps the person's rename in flight.
// - LOW-2: a run's write-back never folds into a sourceless sync.
// - LOW-3: Nebula's order across held nodes (O3, O3b, O8, alternation).
// - NIT-1: the newest chain step's place (O9) and the no-link gate (O11).
// The harness is round 5's (round 18's fake Nebula).

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

import { forgetHeldHistoryForTests, lastForeignToucher, useGraphStore } from '../src/store/graphStore';
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
const inUi = () => useUIStore.getState().selectedNodeId;
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

describe("PR #205 round 6: held changes in Nebula's order, never under the person's steps", () => {
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
  const deleteHeld = async (idsToDelete: string[] = ['n1']) => {
    nebula().holdAnswers = true;
    nebula().holdEchoes = true;
    store().onNodesChange(idsToDelete.map((id) => ({ id, type: 'remove' as const })));
    await tick(5);
  };
  const land = async (goneFirst: boolean) => {
    if (goneFirst) { nebula().deliverEchoes(); await settle(); }
    for (let left = nebula().answers.length; left > 0; left -= 1) { nebula().releaseAnswer(0); await settle(); }
    nebula().holdEchoes = false;
    nebula().deliverEchoes();
    await settle();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle(); await tick(6000); await settle();
  };
  /** An agent's edit to n1 as Nebula has it, synced while the Delete is on its way. */
  const agentEdits = (who: Record<string, unknown>, n1: FakeNode, id: string, edges: FakeWire[] = [], extra: Record<string, unknown> = {}) => {
    const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n1');
    emit({ nodes: FakeNebula.syncNodes({ nodes: [n1, ...others], edges: [] }), edges, empty: false, ...extra, edit: { ...who, id } });
  };

  /** Nebula changes its graph for an agent and syncs all of it (the agent's edit). */
  const agentDoes = (who: Record<string, unknown>, id: string, change: () => void, extra: Record<string, unknown> = {}) => {
    nebula().request += 1;
    change();
    emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
      empty: nebula().nodes.size === 0, ...extra, edit: { ...who, id } });
  };
  const n1 = () => nebula().nodes.get('n1')!;
  const stackKinds = () => store().undoStack.map((entry) => (entry as { kind?: string; agentName?: string }).kind === 'foreign'
    ? `F(${(entry as { agentName?: string }).agentName})` : 'own');


  /** A sync with no origin (a reconnect's): Nebula's graph as it is, nobody named. */
  const reconnectSync = (change: () => void = () => {}) => {
    nebula().request += 1;
    change();
    emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
      empty: nebula().nodes.size === 0 });
  };
  const foreignSteps = () => stackKinds().filter((kind) => kind.startsWith('F('));
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

  const gemini = { actor: { kind: 'agent', name: 'Gemini', id: 'gemini' } };
  const releaseLabelled = async (prefix: string) => {
    const at = nebula().answers.findIndex((answer) => answer.label.startsWith(prefix));
    if (at >= 0) { nebula().releaseAnswer(at); await settle(); }
    return at >= 0;
  };
  const state = () => ({ v: valueOf('n1'), l: labelOf('n1'), w: wires() });
  const typeMine = async () => {
    store().updateNodeData('n1', { params: { ...nodeOf('n1')!.data.params, value: 'mine' } });
    await tick(1100); await settle();
    await releaseLabelled('params');
  };

  describe('MEDIUM-1: the person types during the hold, above the step the agent\'s sync made', () => {
    it('O1t: Claude connects n1>n2 and renames it in one edit, the person types: each Undo takes back only what it names', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      agentDoes(claude, 'ed_r6o1tclaude001', () => { nebula().edges.push(wire('n1', 'n2')); n1().label = 'Claude'; });
      await settle();
      await typeMine();
      await releaseAll();
      expect(state()).toEqual({ v: 'mine', l: 'Claude', w: ['n1>n2'] });
      sameAsNebula();
      // The agent's held change is its own step on top (GM r10 item 1, (a)).
      expect(stackKinds()).toEqual(['F(Claude)', 'own', 'F(Claude)']);
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(state()).toEqual({ v: 'mine', l: 'n1', w: ['n1>n2'] });
      sameAsNebula();
      await undo();
      expect(state()).toEqual({ v: 'v0', l: 'n1', w: ['n1>n2'] });
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(state()).toEqual({ v: 'v0', l: 'n1', w: [] });
      sameAsNebula();
      await redo();
      await redo();
      expect(state()).toEqual({ v: 'mine', l: 'n1', w: ['n1>n2'] });
      await redo();
      expect(notice()).toBe('Redid Claude’s edit.');
      expect(state()).toEqual({ v: 'mine', l: 'Claude', w: ['n1>n2'] });
      sameAsNebula();
    });

    it('O1u: Codex renames (no step of its own), Claude connects, the person types: Codex\'s Undo never brings the typing back', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      agentDoes(codex, 'ed_r6o1ucodex0001', () => { n1().label = 'Codex'; });
      await settle();
      agentDoes(claude, 'ed_r6o1uclaude001', () => { nebula().edges.push(wire('n1', 'n2')); });
      await settle();
      await typeMine();
      await releaseAll();
      expect(state()).toEqual({ v: 'mine', l: 'Codex', w: ['n1>n2'] });
      sameAsNebula();
      expect(stackKinds()).toEqual(['F(Claude)', 'own', 'F(Codex)']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(state()).toEqual({ v: 'mine', l: 'n1', w: ['n1>n2'] });
      sameAsNebula();
      await undo();
      expect(state()).toEqual({ v: 'v0', l: 'n1', w: ['n1>n2'] });
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(state()).toEqual({ v: 'v0', l: 'n1', w: [] });
      sameAsNebula();
    });

    it('typing on another node is a step of the whole canvas: the agent\'s change goes on top of it too', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), { ...textFakeNode('n3'), params: { value: 'x0' } }]);
      await restoreHeld();
      agentDoes(claude, 'ed_r6o1oclaude001', () => { nebula().edges.push(wire('n1', 'n2')); n1().label = 'Claude'; });
      await settle();
      store().updateNodeData('n3', { params: { ...nodeOf('n3')!.data.params, value: 'mine3' } });
      await tick(1100); await settle();
      await releaseLabelled('params');
      await releaseAll();
      expect(stackKinds()).toEqual(['F(Claude)', 'own', 'F(Claude)']);
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect([labelOf('n1'), valueOf('n3')]).toEqual(['n1', 'mine3']);
      await undo();
      expect([labelOf('n1'), valueOf('n3')]).toEqual(['n1', 'x0']);
      await undo();
      expect(state()).toEqual({ v: 'v0', l: 'n1', w: [] });
      sameAsNebula();
    });
  });

  describe('LOW-1: the newest held copy keeps the person\'s rename in flight', () => {
    it('a stale sourceless sync, then Codex sets a value: the name stays the person\'s, never Codex\'s', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      agentDoes(claude, 'ed_r6l1claude0001', () => { n1().label = 'C0'; });
      await settle();
      await restoreHeld();
      nebula().holdEchoes = true;
      store().renameNode('n1', 'Mine');
      await settle();
      emit({ nodes: FakeNebula.syncNodes({ nodes: [{ ...textFakeNode('n1'), label: 'C0', params: { value: 'v0' } }, textFakeNode('n2')], edges: [] }), edges: [], empty: false });
      await settle();
      nebula().holdEchoes = false; nebula().deliverEchoes(); await settle();
      agentDoes(codex, 'ed_r6l1codex00001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      expect(await releaseLabelled('restore')).toBe(true);
      await settle(); await tick(100); await settle();
      // The rename is still on its way: the canvas keeps it at the hold's end.
      expect(labelOf('n1')).toBe('Mine');
      await releaseAll();
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['Mine', 'CODEX']);
      expect(lastForeignToucher('n1', 'label')).toEqual({ kind: 'agent', name: 'Claude' });
      const step = store().undoStack.at(-1) as unknown as { after: { nodes: Record<string, { data: { label: string } }> } };
      expect(step.after.nodes.n1?.data.label).toBe('Mine');
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      await redo();
      expect(notice()).toBe('Redid Codex’s edit.');
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['Mine', 'CODEX']);
      sameAsNebula();
    });
  });

  describe('LOW-2: a run\'s write-back next to a sourceless sync, during a refused Delete', () => {
    it.each([['an output sync, then the write-back', 'outFirst'], ['the write-back, then an output sync', 'runFirst']] as const)('%s: the value stays Codex\'s and its Redo keeps the run\'s value', async (_label, order) => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      agentDoes(codex, 'ed_r6l2codex00001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      refuseDelete();
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      const writeBack = () => {
        nebula().request += 1;
        n1().params = { value: 'RUN' };
        emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
          empty: false, runParams: 'run_1' });
      };
      if (order === 'outFirst') { reconnectSync(); await settle(); writeBack(); await settle(); }
      else { writeBack(); await settle(); reconnectSync(); await settle(); }
      await releaseAll();
      fake.override = null;
      expect(valueOf('n1')).toBe('RUN');
      expect(lastForeignToucher('n1', 'value')).toEqual({ kind: 'agent', name: 'Codex' });
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      await redo();
      expect(valueOf('n1')).toBe('RUN');
      sameAsNebula();
    });
  });

  describe('LOW-3: Nebula\'s order across held nodes', () => {
    const twoBack = async () => {
      store().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
      await settle(); await tick(6000); await settle();
      nebula().holdAnswers = true;
      store().undo();
      await settle();
      expect(cliIds()).toEqual(['n1', 'n2', 'n3']);
    };
    const n2 = () => nebula().nodes.get('n2')!;
    const undoLines = async (count: number) => {
      const lines: string[] = [];
      for (let i = 0; i < count; i += 1) { await undo(); lines.push(String(notice())); sameAsNebula(); }
      return lines;
    };

    it('O3: a restore of two nodes, Claude sets n2, then Codex sets n1: Undo takes Codex first', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
      await twoBack();
      agentDoes(claude, 'ed_r6o3claude0001', () => { n2().params = { value: 'CLAUDE2' }; });
      await settle();
      agentDoes(codex, 'ed_r6o3codex00001', () => { n1().params = { value: 'CODEX1' }; });
      await settle();
      await releaseAll();
      sameAsNebula();
      expect(await undoLines(2)).toEqual(['Undid Codex’s edit.', 'Undid Claude’s edit.']);
    });

    it('two held nodes edited in alternation: four steps in Nebula\'s order, Undo and Redo each its own', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
      await twoBack();
      agentDoes(codex, 'ed_r6altcodex0001', () => { n1().params = { value: 'A1' }; });
      await settle();
      agentDoes(claude, 'ed_r6altclaude001', () => { n2().params = { value: 'B2' }; });
      await settle();
      agentDoes(gemini, 'ed_r6altgemini001', () => { n1().params = { value: 'C1' }; });
      await settle();
      agentDoes(codex, 'ed_r6altcodex0002', () => { n2().params = { value: 'D2' }; });
      await settle();
      await releaseAll();
      sameAsNebula();
      expect(foreignSteps()).toEqual(['F(Codex)', 'F(Claude)', 'F(Gemini)', 'F(Codex)']);
      expect(await undoLines(4)).toEqual(['Undid Codex’s edit.', 'Undid Gemini’s edit.', 'Undid Claude’s edit.', 'Undid Codex’s edit.']);
      expect([valueOf('n1'), valueOf('n2')]).toEqual(['v0', 'w0']);
      for (let i = 0; i < 4; i += 1) { await redo(); sameAsNebula(); }
      expect([valueOf('n1'), valueOf('n2')]).toEqual(['C1', 'D2']);
    });

    it('a held change goes under a later agent edit to a node nothing held (that sync is a link of the held node too)', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), { ...textFakeNode('n3'), params: { value: 'x0' } }]);
      await restoreHeld();
      agentDoes(codex, 'ed_r6freecodex001', () => { n1().params = { value: 'CODEX1' }; });
      await settle();
      agentDoes(claude, 'ed_r6freeclaude01', () => { nebula().nodes.get('n3')!.params = { value: 'CLAUDE3' }; });
      await settle();
      await releaseAll();
      sameAsNebula();
      expect(await undoLines(2)).toEqual(['Undid Claude’s edit.', 'Undid Codex’s edit.']);
      expect([valueOf('n1'), valueOf('n3')]).toEqual(['v0', 'x0']);
    });

    it('O3b: a refused Delete of two nodes, Claude sets n2, then Codex sets n1: Undo takes Codex first', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
      fake.override = (path, init) => (init?.method === 'DELETE' && /^\/api\/graph\/node\/n[12]$/.test(path)
        ? nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }))
        : null);
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
      await tick(5);
      agentDoes(claude, 'ed_r6o3bclaude001', () => { n2().params = { value: 'CLAUDE2' }; });
      await settle();
      agentDoes(codex, 'ed_r6o3bcodex0001', () => { n1().params = { value: 'CODEX1' }; });
      await settle();
      await releaseAll();
      fake.override = null;
      sameAsNebula();
      expect(await undoLines(2)).toEqual(['Undid Codex’s edit.', 'Undid Claude’s edit.']);
    });

    it.each([['the restore answers first', 'restoreFirst'], ['the refusal first', 'refuseFirst']] as const)('O8: a refused Delete inside a restore hold, %s: Codex connects n1>n2, Claude sets n1, Gemini sets n2', async (_label, order) => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }]);
      await restoreHeld();
      fake.override = (path, init) => (init?.method === 'DELETE' && path === '/api/graph/node/n2'
        ? nebula().later('refused n2', () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }))
        : null);
      store().onNodesChange([{ id: 'n2', type: 'remove' }]);
      await tick(5);
      agentDoes(codex, 'ed_r6o8codex00001', () => { nebula().edges.push(wire('n1', 'n2')); });
      await settle();
      agentDoes(claude, 'ed_r6o8claude0001', () => { n1().params = { value: 'CLAUDE' }; });
      await settle();
      agentDoes(gemini, 'ed_r6o8gemini0001', () => { n2().params = { value: 'GEM2' }; });
      await settle();
      if (order === 'restoreFirst') { await releaseLabelled('restore'); await releaseLabelled('refused'); }
      else { await releaseLabelled('refused'); await releaseLabelled('restore'); }
      await releaseAll();
      fake.override = null;
      sameAsNebula();
      expect(foreignSteps()).toEqual(['F(Codex)', 'F(Claude)', 'F(Gemini)']);
      expect(await undoLines(3)).toEqual(['Undid Gemini’s edit.', 'Undid Claude’s edit.', 'Undid Codex’s edit.']);
      for (let i = 0; i < 3; i += 1) { await redo(); sameAsNebula(); }
    });
  });

  describe('NIT-1: the guards review 5 found load-bearing', () => {
    it('O9: Codex moves n1, then Claude renames it under a Delete that goes through: the node stays where Codex put it', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await deleteHeld();
      agentEdits(codex, { ...textFakeNode('n1'), position: { x: 500, y: 400 } }, 'ed_r6o9codex00001', [], { moved: ['n1'] });
      await settle();
      agentEdits(claude, { ...textFakeNode('n1'), label: 'Claude', position: { x: 500, y: 400 } }, 'ed_r6o9claude0001');
      await settle();
      await land(true);
      const pos = () => nodeOf('n1')?.position;
      await undo();
      expect(pos()).toEqual({ x: 500, y: 400 });
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect([pos(), labelOf('n1')]).toEqual([{ x: 500, y: 400 }, 'n1']);
      await redo();
      expect([pos(), labelOf('n1')]).toEqual([{ x: 500, y: 400 }, 'Claude']);
    });

    it('O11: the person renames a node its restore holds and no one else edits it: the name is theirs, no "someone" on it', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      agentDoes(claude, 'ed_r6o11claude001', () => { n1().label = 'C0'; });
      await settle();
      await restoreHeld();
      store().renameNode('n1', 'Mine');
      await settle();
      await releaseAll();
      expect(labelOf('n1')).toBe('Mine');
      expect(lastForeignToucher('n1')).toEqual({ kind: 'agent', name: 'Claude' });
    });
  });

  describe('GM r10 items 2-3: the pinned Inspector when its node goes, every way', () => {
    const pin = (id: string) => {
      useUIStore.getState().selectNode(id);
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().setInspectorVisible(true);
    };
    const emptyAndPinned = () => expect([inUi(), useUIStore.getState().inspectorPinned, useUIStore.getState().panels.inspector.visible])
      .toEqual([null, true, true]);

    it('an Undo of a Paste of one node: the Inspector is empty, its pin kept', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      pin('n1');
      store().copySelected();
      store().pasteClipboard();
      await settle(); await tick(6000); await settle();
      const copy = inUi();
      expect(copy).not.toBe('n1');
      expect(ids()).toContain(copy);
      await undo();
      expect(ids()).not.toContain(copy);
      emptyAndPinned();
    });

    it('the person deletes the node it shows: empty, pin kept', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      pin('n1');
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await settle(); await tick(6000); await settle();
      emptyAndPinned();
    });

    it('an agent deletes the node it shows: empty, pin kept', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      pin('n1');
      agentDoes(codex, 'ed_r6pincodex0001', () => { nebula().nodes.delete('n1'); });
      await settle();
      expect(cliIds()).toEqual(['n2']);
      emptyAndPinned();
    });

    it('the store\'s project canvas load keeps the pin (opening another project resets the panels and unpins, in projectStore)', () => {
      start([textFakeNode('n1')]);
      pin('n1');
      expect(store().loadProjectGraph([], [], [])).toBe(true);
      emptyAndPinned();
    });

    it('control: a node that stays leaves the Inspector on it', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      pin('n1');
      agentDoes(codex, 'ed_r6pincodex0002', () => { nebula().nodes.delete('n2'); });
      await settle();
      expect([inUi(), useUIStore.getState().inspectorPinned]).toEqual(['n1', true]);
    });
  });
});
