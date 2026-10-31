import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 5: review 4 of the agent steps under a hold, and GM r7/r8.
// - Review 4, MEDIUM-1: two agent edits to a node an Undo's restore holds:
//   the canvas keeps Nebula's connections, one step per edit (R1, R1b);
//   a refused Delete's connections (R6, R12, and an earlier link's).
// - Review 4, LOW-1: the chain's intermediate connections, the order across
//   nodes (R9), and the selection after an agent step's Undo (R8).
// - GM r7 item 1: a sync with no origin (a reconnect's) is someone's, held
//   or not: never credited to an agent, never folded into an agent's step.
// - GM r8 items 1-2: several nodes brought back leave a pinned Inspector
//   pinned; a real multi-selection draws a ring and a pill per node.
// The harness is review 4's probe file (round 18's fake Nebula).

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
import { droppedRenameLine } from '../src/lib/canvasUndo';
import { cleanup, render } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { ModelNode } from '../src/components/nodes/ModelNode';
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
const selected = () => store().nodes.filter((node) => node.selected).map((node) => node.id).sort();
const inUi = () => useUIStore.getState().selectedNodeId;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const undo = async () => { store().undo(); await settle(); await tick(6000); await settle(); };
const redo = async () => { store().redo(); await settle(); await tick(6000); await settle(); };
const restoreEdits = () => nebula().calls.filter((call) => call.path === '/api/graph/restore')
  .map((call) => (JSON.parse(call.body ?? '{}') as { edit?: string | null }).edit ?? null);
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

describe('PR #205 round 5: holds, someone, and the selection', () => {
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

  describe('review 4 MEDIUM-1: the restore hold with two agent edits', () => {
    it('R1: Codex sets a value, then Codex connects n1 to n2: the canvas keeps the connection, as Nebula; one step each', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      agentDoes(codex, 'ed_r1val000000001', () => { n1().params = { value: 'AGENT' }; });
      await settle();
      agentDoes(codex, 'ed_r1con000000001', () => { nebula().edges.push(wire('n1', 'n2')); });
      await settle();
      await releaseAll();
      expect(valueOf('n1')).toBe('AGENT');
      expect(wires()).toEqual(['n1>n2']);
      sameAsNebula();
      expect(foreignSteps()).toEqual(['F(Codex)', 'F(Codex)']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(wires()).toEqual([]);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      sameAsNebula();
      // Each Undo named its own edit, newest first.
      expect(restoreEdits().slice(-2)).toEqual(['ed_r1con000000001', 'ed_r1val000000001']);
    });

    it('R1b: Claude connects n1 to n2 and renames, then Codex takes it off and sets a value: no connection, as Nebula; no duplicate step', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      agentDoes(claude, 'ed_r1bcon00000001', () => { nebula().edges.push(wire('n1', 'n2')); n1().label = 'Claude'; });
      await settle();
      agentDoes(codex, 'ed_r1bval00000001', () => { nebula().edges = []; n1().params = { value: 'CODEX' }; });
      await settle();
      await releaseAll();
      expect(wires()).toEqual([]);
      sameAsNebula();
      expect(foreignSteps()).toEqual(['F(Claude)', 'F(Codex)']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([valueOf('n1'), wires()]).toEqual(['v0', ['n1>n2']]);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect([labelOf('n1'), wires()]).toEqual(['n1', []]);
      sameAsNebula();
      await redo();
      expect([labelOf('n1'), wires()]).toEqual(['Claude', ['n1>n2']]);
      sameAsNebula();
      await redo();
      expect([valueOf('n1'), wires()]).toEqual(['CODEX', []]);
      sameAsNebula();
    });
  });

  describe('mutation guards (round 5)', () => {
    it('one edit synced twice during a restore\'s hold (its connection, then again with nothing new) stays one step', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      agentDoes(codex, 'ed_twice000000001', () => { nebula().edges.push(wire('n1', 'n2')); n1().params = { value: 'CODEX' }; });
      await settle();
      agentDoes(codex, 'ed_twice000000001', () => {});
      await settle();
      await releaseAll();
      expect(foreignSteps()).toEqual(['F(Codex)']);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([valueOf('n1'), wires()]).toEqual(['v0', []]);
      sameAsNebula();
    });

    it('a refused Delete: a stale sync while the person\'s rename was on its way, then Codex\'s value: Codex\'s Undo keeps the person\'s name', async () => {
      start([{ ...textFakeNode('n1'), label: 'Old', params: { value: 'v0' } }, textFakeNode('n2')]);
      refuseDelete();
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().renameNode('n1', 'Mine');
      await tick(5);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n1');
      emit({ nodes: FakeNebula.syncNodes({ nodes: [{ ...textFakeNode('n1'), label: 'Old', params: { value: 'v0' } }, ...others], edges: [] }),
        edges: [], empty: false });
      await settle();
      nebula().deliverEcho(); await settle();
      nebula().releaseAnswer(0); await settle();
      agentDoes(codex, 'ed_stale000000001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      nebula().holdEchoes = false; nebula().deliverEchoes(); await settle();
      await releaseAll();
      fake.override = null;
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['Mine', 'CODEX']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['Mine', 'v0']);
      sameAsNebula();
    });

    it('Nebula takes Codex\'s rename, then the person\'s typing, then the Delete: Redo of Codex\'s step keeps the typing', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      let sendPut: (() => void) | null = null;
      let applyDelete: (() => void) | null = null;
      fake.override = (path, init) => {
        if (init?.method === 'PUT' && path === '/api/graph/node/n1' && !sendPut) {
          return new Promise<Response>((resolve) => { sendPut = () => resolve(fake.backend.apiFetch(path, init)); });
        }
        if (init?.method === 'DELETE' && path === '/api/graph/node/n1') {
          nebula().calls.push({ path, method: 'DELETE' });
          return new Promise<Response>((resolve) => {
            applyDelete = () => {
              nebula().request += 1;
              nebula().nodes.delete('n1');
              nebula().broadcast();
              resolve(new Response(JSON.stringify({ status: 'deleted', id: 'n1' }), { status: 200 }));
            };
          });
        }
        return null;
      };
      store().updateNodeData('n1', { params: { value: 'TYPED' } });
      for (let i = 0; i < 40 && !sendPut; i += 1) await tick(100);
      expect(sendPut).not.toBeNull();
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      agentDoes(codex, 'ed_typed000000001', () => { n1().label = 'Codex'; });
      await settle();
      sendPut!();
      await settle();
      applyDelete!();
      await settle(); await tick(6000); await settle();
      fake.override = null;
      await undo();
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['Codex', 'TYPED']);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['n1', 'TYPED']);
      sameAsNebula();
      await redo();
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['Codex', 'TYPED']);
      sameAsNebula();
    });
  });

  describe('review 4 MEDIUM-1: a refused Delete\'s connections', () => {
    it('R6: a multi-node Delete, n1 goes, n2 refused, two agents edit n2: their steps on top, each Undo matches Nebula', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
      refuseDelete('n2');
      await deleteHeld(['n1', 'n2']);
      nebula().holdEchoes = false; nebula().deliverEchoes(); await settle();
      agentDoes(codex, 'ed_r6codex0000001', () => { nebula().nodes.get('n2')!.params = { value: 'CODEX2' }; nebula().edges.push(wire('n2', 'n3')); });
      await settle();
      agentDoes(claude, 'ed_r6claude000001', () => { nebula().nodes.get('n2')!.label = 'Claude2'; });
      await settle();
      await releaseAll();
      fake.override = null;
      expect([valueOf('n2'), labelOf('n2'), wires()]).toEqual(['CODEX2', 'Claude2', ['n2>n3']]);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([valueOf('n2'), wires()]).toEqual(['w0', []]);
      sameAsNebula();
      await undo();
      expect(cliIds()).toEqual(['n1', 'n2', 'n3']);
      sameAsNebula();
    });

    it('R12: Codex connects, then Claude renames: "Undid Claude’s edit." keeps the connection, "Undid Codex’s edit." takes it off', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      refuseDelete();
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      agentDoes(codex, 'ed_r12con00000001', () => { nebula().edges.push(wire('n1', 'n2')); });
      await settle();
      agentDoes(claude, 'ed_r12ren00000001', () => { n1().label = 'Claude'; });
      await settle();
      await releaseAll();
      fake.override = null;
      expect(wires()).toEqual(['n1>n2']);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect([labelOf('n1'), wires()]).toEqual(['n1', ['n1>n2']]);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(wires()).toEqual([]);
      sameAsNebula();
    });

    it('an earlier link\'s connection the newest takes off: Codex connects, Claude takes it off; "Undid Claude’s edit." puts it back, as Nebula', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      refuseDelete();
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      agentDoes(codex, 'ed_m25con00000001', () => { nebula().edges.push(wire('n1', 'n2')); });
      await settle();
      agentDoes(claude, 'ed_m25off00000001', () => { nebula().edges = []; n1().label = 'Claude'; });
      await settle();
      await releaseAll();
      fake.override = null;
      expect(wires()).toEqual([]);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect([labelOf('n1'), wires()]).toEqual(['n1', ['n1>n2']]);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(wires()).toEqual([]);
      sameAsNebula();
    });
  });

  describe('review 4 LOW-1: the chain under a confirmed Delete', () => {
    it('the later agent changes the connections: Codex connects n1>n2, Claude connects n1>n3; each Undo takes off its own', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), textFakeNode('n3')]);
      await deleteHeld();
      agentEdits(codex, { ...textFakeNode('n1') }, 'ed_m24a0000000001', [wire('n1', 'n2')]);
      await settle();
      agentEdits(claude, { ...textFakeNode('n1') }, 'ed_m24b0000000001', [wire('n1', 'n2'), wire('n1', 'n3')]);
      await settle();
      await land(true);
      await undo();
      expect(wires()).toEqual(['n1>n2', 'n1>n3']);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(wires()).toEqual(['n1>n2']);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(wires()).toEqual([]);
      sameAsNebula();
    });

    it('R8: an agent step\'s Undo brings nothing back, and the selection stays on the restored node', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await deleteHeld();
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'CODEX' } }, 'ed_r8codex0000001');
      await settle();
      await land(true);
      await undo();
      expect(inUi()).toBe('n1');
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(selected()).toEqual(['n1']);
      expect(inUi()).toBe('n1');
    });

    describe('R9: two nodes under one Delete, in Nebula\'s order across nodes', () => {
      const slowDeletes = () => {
        const waiting: Array<() => void> = [];
        fake.override = (path, init) => {
          const m = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
          if (init?.method === 'DELETE' && m) {
            nebula().calls.push({ path, method: 'DELETE' });
            return new Promise<Response>((resolve) => {
              waiting.push(() => {
                nebula().request += 1;
                nebula().nodes.delete(m[1]);
                nebula().broadcast();
                resolve(new Response(JSON.stringify({ status: 'deleted', id: m[1] }), { status: 200 }));
              });
            });
          }
          return null;
        };
        return waiting;
      };
      it.each([['Codex n2 then Claude n1', 'codexFirst'], ['Claude n1 then Codex n2', 'claudeFirst']] as const)('%s: Undo D, then the newest, then the older', async (_label, which) => {
        start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
        const waiting = slowDeletes();
        store().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
        await tick(5);
        const codexEdit = () => agentDoes(codex, 'ed_r9codex0000001', () => { nebula().nodes.get('n2')!.params = { value: 'CODEX2' }; });
        const claudeEdit = () => agentDoes(claude, 'ed_r9claude000001', () => { nebula().nodes.get('n1')!.params = { value: 'CLAUDE1' }; });
        if (which === 'codexFirst') { codexEdit(); await settle(); claudeEdit(); await settle(); }
        else { claudeEdit(); await settle(); codexEdit(); await settle(); }
        while (waiting.length) { waiting.shift()!(); await settle(); }
        await settle(); await tick(6000); await settle();
        fake.override = null;
        await undo();
        expect([valueOf('n1'), valueOf('n2')]).toEqual(['CLAUDE1', 'CODEX2']);
        sameAsNebula();
        await undo();
        expect(notice()).toBe(which === 'codexFirst' ? 'Undid Claude’s edit.' : 'Undid Codex’s edit.');
        await undo();
        expect(notice()).toBe(which === 'codexFirst' ? 'Undid Codex’s edit.' : 'Undid Claude’s edit.');
        expect([valueOf('n1'), valueOf('n2')]).toEqual(['v0', 'w0']);
        sameAsNebula();
      });
    });
  });

  describe('GM r7 item 1: a sync with no origin is someone\'s, held or not', () => {
    const someoneLine = 'This node was renamed “Reconnect” while Nebula was offline, so your rename to “Draft” wasn\'t saved.';
    const expectSomeone = () => {
      expect(lastForeignToucher('n1')).toEqual({ kind: 'unknown' });
      expect(droppedRenameLine(lastForeignToucher('n1'), labelOf('n1')!, 'Draft')).toBe(someoneLine);
    };
    /** Codex sets a value, then a reconnect's sync renames n1: Codex's step keeps only the value. */
    const codexThenReconnect = async () => {
      agentDoes(codex, 'ed_gm7val00000001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      reconnectSync(() => { n1().label = 'Reconnect'; });
      await settle();
    };
    /** Codex's step holds Codex's change alone: the rename is in none of its slices. */
    const codexStepAlone = () => {
      const steps = store().undoStack.filter((entry) => (entry as { kind?: string }).kind === 'foreign') as unknown as
        Array<{ agentName: string; before: { nodes: Record<string, { data: { label: string } } | null> }; after: { nodes: Record<string, { data: { label: string; params: { value: unknown } } } | null> } }>;
      expect(steps.map((step) => step.agentName)).toEqual(['Codex']);
      expect(steps[0].after.nodes.n1?.data.label).toBe('n1');
      expect(steps[0].after.nodes.n1?.data.params.value).toBe('CODEX');
    };
    // Undo puts back a step's whole node, as it does for every step (lib/canvasUndo
    // applySlice): Codex's Undo takes the name back too, held or not. Asked as a question.
    const undoCodexKeepsRename = async () => {
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'Reconnect']);
      expectSomeone();
      sameAsNebula();
      codexStepAlone();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      sameAsNebula();
    };

    it('no hold: Codex sets a value, a reconnect renames: "someone" for the name, Codex\'s step holds only its value', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await codexThenReconnect();
      await undoCodexKeepsRename();
    });

    it('a Delete Nebula refuses: the same', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      refuseDelete();
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      await codexThenReconnect();
      await releaseAll();
      fake.override = null;
      await undoCodexKeepsRename();
    });

    it('a restore\'s hold (an Undo of a Delete on its way): the same', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      await codexThenReconnect();
      await releaseAll();
      await undoCodexKeepsRename();
    });

    it('a Delete that goes through: Undo brings both back; "someone" for the name; Codex\'s step holds only its value', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await deleteHeld();
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'CODEX' } }, 'ed_gm7del00000001');
      await settle();
      const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n1');
      emit({ nodes: FakeNebula.syncNodes({ nodes: [{ ...textFakeNode('n1'), label: 'Reconnect', params: { value: 'CODEX' } }, ...others], edges: [] }),
        edges: [], empty: false });
      await settle();
      await land(true);
      await undo();
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'Reconnect']);
      expectSomeone();
      sameAsNebula();
      codexStepAlone();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      sameAsNebula();
    });

    it.each([['no hold', false], ['a Delete Nebula refuses', true]] as const)('%s: a run\'s own write-back (no origin, runParams) is nobody\'s change: the value\'s toucher stays Codex', async (_label, held) => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      agentDoes(codex, 'ed_gm7run00000001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      expect(lastForeignToucher('n1', 'value')).toEqual({ kind: 'agent', name: 'Codex' });
      if (held) {
        refuseDelete();
        nebula().holdAnswers = true;
        store().onNodesChange([{ id: 'n1', type: 'remove' }]);
        await tick(5);
      }
      nebula().request += 1;
      n1().params = { value: 'RUN' };
      emit({ nodes: FakeNebula.syncNodes({ nodes: [...nebula().nodes.values()], edges: nebula().edges }), edges: nebula().edges,
        empty: false, runParams: 'run_1' });
      await settle();
      if (held) { await releaseAll(); fake.override = null; }
      expect(valueOf('n1')).toBe('RUN');
      expect(lastForeignToucher('n1', 'value')).toEqual({ kind: 'agent', name: 'Codex' });
      expect(foreignSteps()).toEqual(['F(Codex)']);
    });

    it('an agent rename, then a reconnect renames during a refused Delete: the agent is never named for it', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      agentDoes(codex, 'ed_gm7ren00000001', () => { n1().label = 'Codex name'; });
      await settle();
      expect(lastForeignToucher('n1')).toEqual({ kind: 'agent', name: 'Codex' });
      refuseDelete();
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      reconnectSync(() => { n1().label = 'Reconnect'; });
      await settle();
      await releaseAll();
      fake.override = null;
      expect(labelOf('n1')).toBe('Reconnect');
      expectSomeone();
    });
  });

  describe('GM r8 items 1-2: several nodes back', () => {
    const pin = (id: string) => {
      useUIStore.getState().selectNode(id);
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().setInspectorVisible(true);
      expect([useUIStore.getState().inspectorPinned, useUIStore.getState().panels.inspector.visible]).toEqual([true, true]);
    };
    const stillPinned = () => expect([inUi(), useUIStore.getState().inspectorPinned, useUIStore.getState().panels.inspector.visible])
      .toEqual([null, true, true]);
    /** Each node as drawn: [its ring, its own "…" pill]. */
    const drawn = (id: string) => {
      const node = nodeOf(id)!;
      const { container } = render(<ModelNode {...({ id, data: node.data, selected: node.selected ?? false } as NodeProps)} />);
      const look = [container.querySelector('.model-node')!.classList.contains('model-node--selected'),
        container.querySelector('.model-node__settings-bar') !== null];
      cleanup();
      return look;
    };

    it('a Paste of several leaves a pinned Inspector pinned and open, with nothing in it', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')], [], ['n1', 'n2']);
      store().copySelected();
      pin('n3');
      store().pasteClipboard();
      await settle();
      stillPinned();
    });

    it('an Undo bringing several back leaves a pinned Inspector pinned; each draws its own ring and pill, the node clicked before none', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')], [], ['n1', 'n2']);
      store().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n2', type: 'remove' }]);
      await settle(); await tick(6000); await settle();
      useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n3' })) }));
      pin('n3');
      await undo();
      expect(selected()).toEqual(['n1', 'n2']);
      stillPinned();
      expect([drawn('n1'), drawn('n2'), drawn('n3')]).toEqual([[true, true], [true, true], [false, false]]);
    });

    it('one node back: the one ring and pill move to it; a pinned Inspector stays pinned on it', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await settle(); await tick(6000); await settle();
      useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n2' })) }));
      pin('n2');
      await undo();
      expect([inUi(), useUIStore.getState().inspectorPinned]).toEqual(['n1', true]);
      expect([drawn('n1'), drawn('n2')]).toEqual([[true, true], [false, false]]);
    });

    it('control: clearing the selection the person\'s way still unpins (main\'s rule)', () => {
      start([textFakeNode('n1')]);
      pin('n1');
      useUIStore.getState().selectNode(null);
      expect(useUIStore.getState().inspectorPinned).toBe(false);
    });
  });
});
