import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 7: review 6 of the agent steps under a hold.
// - MEDIUM-1: a refused Delete of nodes with a connection between them
//   places every held edit in one pass, in Nebula's order (K5, the random
//   interleavings): canvas = Nebula after each Undo and Redo, and each Undo
//   takes back only what it names.
// - MEDIUM-2: the join clears Redo, as every landed agent change does (K4).
// - LOW-1: a refused rename leaves no trace on a held copy (K3).
// - LOW-2: the reachable survivors (K1, K2, K7).
// - P-A: a restore Nebula applied after the limit never makes a step whose
//   Undo deletes a node that exists (K6). P-B: an agent's clear during a
//   restore hold keeps another agent's held edit (P13).
// The harness is round 6's (round 18's fake Nebula).

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

describe("PR #205 round 7: held edits in one pass, in Nebula's order", () => {
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
  const n1 = () => nebula().nodes.get('n1')!;

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

  const kinds = () => store().undoStack.map((entry) => { const e = entry as { kind?: string; agentName?: string };
    return e.kind === 'foreign' ? `F(${e.agentName})` : e.kind === 'own-add' ? 'add' : 'own'; });
  const undoAllLines = async () => {
    const lines: string[] = [];
    while (store().undoStack.length > 0) { await undo(); lines.push(String(notice())); sameAsNebula(); }
    return lines;
  };

  describe('MEDIUM-1: a refused Delete of nodes with a connection between them', () => {
    const refuse = (pattern: RegExp) => {
      fake.override = (path, init) => (init?.method === 'DELETE' && pattern.test(path)
        ? nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 })) : null);
    };
    it('K5: n2 and n3 refused, Codex sets n1, Claude connects n3>n2: one step each, and Codex\'s Undo leaves the connection off', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, { ...textFakeNode('n3'), params: { value: 'x0' } }]);
      refuse(/^\/api\/graph\/node\/n[23]$/);
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n2', type: 'remove' }, { id: 'n3', type: 'remove' }]);
      await tick(5);
      agentDoes(codex, 'ed_r7k5codex00001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      agentDoes(claude, 'ed_r7k5claude0001', () => { nebula().edges.push(wire('n3', 'n2')); });
      await settle();
      await releaseAll();
      fake.override = null;
      sameAsNebula();
      expect(kinds()).toEqual(['F(Codex)', 'F(Claude)']);
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(wires()).toEqual([]);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([valueOf('n1'), wires()]).toEqual(['v0', []]);
      sameAsNebula();
      await redo();
      expect([valueOf('n1'), wires()]).toEqual(['CODEX', []]);
      sameAsNebula();
      await redo();
      expect(wires()).toEqual(['n3>n2']);
      sameAsNebula();
    });

    it('three nodes: Codex sets n1, Claude connects n2>n3 and n3>n4, Gemini renames n4: each Undo only its own', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), textFakeNode('n3'), textFakeNode('n4')]);
      refuse(/^\/api\/graph\/node\/n[234]$/);
      nebula().holdAnswers = true;
      store().onNodesChange(['n2', 'n3', 'n4'].map((id) => ({ id, type: 'remove' as const })));
      await tick(5);
      agentDoes(codex, 'ed_r7tncodex00001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      agentDoes(claude, 'ed_r7tnclaude0001', () => { nebula().edges.push(wire('n2', 'n3'), wire('n3', 'n4')); });
      await settle();
      agentDoes(gemini, 'ed_r7tngemini0001', () => { nebula().nodes.get('n4')!.label = 'Gemini'; });
      await settle();
      await releaseAll();
      fake.override = null;
      sameAsNebula();
      expect(kinds()).toEqual(['F(Codex)', 'F(Claude)', 'F(Gemini)']);
      expect(await undoAllLines()).toEqual(['Undid Gemini’s edit.', 'Undid Claude’s edit.', 'Undid Codex’s edit.']);
      expect([valueOf('n1'), labelOf('n4'), wires()]).toEqual(['v0', 'n4', []]);
    });

    it('a connection an edit took off and a later one put back: each Undo takes back only its own', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')], [wire('n2', 'n3')]);
      refuse(/^\/api\/graph\/node\/n[23]$/);
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n2', type: 'remove' }, { id: 'n3', type: 'remove' }]);
      await tick(5);
      agentDoes(codex, 'ed_r7rrcodex00001', () => { nebula().edges.length = 0; });
      await settle();
      agentDoes(claude, 'ed_r7rrclaude0001', () => { nebula().edges.push(wire('n2', 'n3')); });
      await settle();
      await releaseAll();
      fake.override = null;
      sameAsNebula();
      expect(wires()).toEqual(['n2>n3']);
      await undo();
      expect([notice(), wires()]).toEqual(['Undid Claude’s edit.', []]);
      sameAsNebula();
      await undo();
      expect([notice(), wires()]).toEqual(['Undid Codex’s edit.', ['n2>n3']]);
      sameAsNebula();
    });
  });

  // The reviewer's generator (review 6, held-undo): 2-3 agents mixing
  // values, renames and connections, on every kind of hold.
  describe('random interleavings: canvas = Nebula after each Undo and Redo, and each takes back only its edit', () => {
    const ALL = ['n1', 'n2', 'n3', 'n4'];
    const nebState = () => JSON.stringify({ n: ALL.map((id) => [id, nebula().valueOf(id) ?? null, nebula().nodes.get(id)?.label ?? null]), w: nebula().wires() });
    const canvasState = () => JSON.stringify({ n: ALL.map((id) => [id, valueOf(id) ?? null, labelOf(id) ?? null]), w: wires().filter((x) => x.split('>').every((e) => CLI.test(e))) });
    const agents = { codex, claude, gemini } as const;
    type Op = { who: keyof typeof agents; kind: 'value' | 'rename' | 'connect'; a: string; b?: string };
    const rng = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
    const gen = (seed: number, count: number, who: (keyof typeof agents)[], held: string[]): Op[] => {
      const r = rng(seed); const ops: Op[] = []; const wired = new Set<string>();
      for (let i = 0; i < count; i += 1) {
        const k = r();
        const a = held[Math.floor(r() * held.length)];
        const agent = who[i % who.length === 0 ? 0 : Math.floor(r() * who.length)];
        if (k < 0.25) {
          const targets = ALL.filter((t) => t !== a && !wired.has(`${a}>${t}`) && !wired.has(`${t}>${a}`));
          if (targets.length) { const b = targets[Math.floor(r() * targets.length)]; wired.add(`${a}>${b}`); ops.push({ who: agent, kind: 'connect', a, b }); continue; }
        }
        ops.push({ who: agent, kind: k < 0.6 ? 'value' : 'rename', a });
      }
      return ops;
    };
    const doOp = (op: Op, i: number, tag: string) => {
      const id = `ed_${tag}${String(i).padStart(3, '0')}xxxxxx`;
      agentDoes(agents[op.who], id, () => {
        const node = nebula().nodes.get(op.a)!;
        if (op.kind === 'value') node.params = { value: `${op.who}${i}` };
        else if (op.kind === 'rename') node.label = `${op.who}L${i}`;
        else nebula().edges.push(wire(op.a, op.b!));
      });
      return id;
    };
    const editIds = () => store().undoStack.filter((e) => (e as { kind?: string }).kind === 'foreign').map((e) => (e as { editId?: string }).editId);
    type Hold = 'restore' | 'refused' | 'mixedRestoreFirst' | 'mixedRefusedFirst';
    const begin = async (hold: Hold) => {
      if (hold !== 'refused') {
        const off = hold === 'restore' ? ['n1', 'n2', 'n3'] : ['n1', 'n2'];
        store().onNodesChange(off.map((id) => ({ id, type: 'remove' as const })));
        await settle(); await tick(6000); await settle();
        nebula().holdAnswers = true;
        store().undo();
        await settle();
      }
      if (hold !== 'restore') {
        const off = hold === 'refused' ? ['n1', 'n2', 'n3'] : ['n3'];
        fake.override = (path, init) => (init?.method === 'DELETE' && off.some((id) => path === `/api/graph/node/${id}`)
          ? nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 })) : null);
        nebula().holdAnswers = true;
        store().onNodesChange(off.map((id) => ({ id, type: 'remove' as const })));
        await tick(5);
      }
    };
    const finish = async (hold: Hold) => {
      if (hold === 'mixedRestoreFirst') { await releaseLabelled('restore'); await releaseLabelled('refused'); }
      if (hold === 'mixedRefusedFirst') { await releaseLabelled('refused'); await releaseLabelled('restore'); }
      await releaseAll();
      fake.override = null;
    };
    const scenario = async (tag: string, hold: Hold, ops: Op[]) => {
      start(ALL.map((id, i) => ({ ...textFakeNode(id), params: { value: `${id}v0` }, position: { x: 100 + 200 * i, y: 100 } })));
      await begin(hold);
      const states = [nebState()];
      const order: string[] = [];
      for (const [i, op] of ops.entries()) { order.push(doOp(op, i, tag)); await settle(); states.push(nebState()); }
      await finish(hold);
      const problems: string[] = [];
      if (canvasState() !== nebState()) problems.push(`end canvas ${canvasState()} != nebula ${nebState()}`);
      if (JSON.stringify(editIds()) !== JSON.stringify(order)) problems.push(`steps ${JSON.stringify(editIds())} != nebula's order ${JSON.stringify(order)}`);
      const agentSteps = store().undoStack.filter((e) => (e as { kind?: string }).kind === 'foreign').length;
      for (let k = 1; k <= agentSteps; k += 1) {
        const top = store().undoStack.at(-1) as { editId?: string };
        await undo();
        if (canvasState() !== nebState()) problems.push(`U${k} canvas != nebula`);
        const at = order.indexOf(top.editId ?? '');
        if (at >= 0 && nebState() !== states[at]) problems.push(`U${k} (${top.editId}) ${nebState()} != before it ${states[at]}`);
      }
      for (let k = 1; k <= agentSteps; k += 1) {
        const next = store().redoStack.at(-1) as { editId?: string };
        await redo();
        if (canvasState() !== nebState()) problems.push(`R${k} canvas != nebula`);
        const at = order.indexOf(next.editId ?? '');
        if (at >= 0 && nebState() !== states[at + 1]) problems.push(`R${k} (${next.editId}) ${nebState()} != after it ${states[at + 1]}`);
      }
      return problems;
    };
    const holds: Hold[] = ['refused', 'restore', 'mixedRestoreFirst', 'mixedRefusedFirst'];
    const fixed: [string, Op[]][] = [
      ['twowires', [{ who: 'codex', kind: 'value', a: 'n1' }, { who: 'claude', kind: 'connect', a: 'n2', b: 'n3' }, { who: 'codex', kind: 'value', a: 'n3' }, { who: 'claude', kind: 'rename', a: 'n2' }, { who: 'codex', kind: 'connect', a: 'n1', b: 'n4' }, { who: 'claude', kind: 'value', a: 'n1' }]],
      ['freewire', [{ who: 'claude', kind: 'connect', a: 'n4', b: 'n1' }, { who: 'codex', kind: 'value', a: 'n2' }, { who: 'claude', kind: 'value', a: 'n1' }, { who: 'codex', kind: 'connect', a: 'n3', b: 'n2' }]],
    ];
    for (const hold of holds) {
      for (const [label, ops] of fixed) {
        it(`${label}, ${hold}`, async () => { expect(await scenario(`${label.slice(0, 4)}${hold.slice(0, 3)}`, hold, ops)).toEqual([]); });
      }
      for (let seed = 1; seed <= 12; seed += 1) {
        it(`random ${seed}, ${hold}`, async () => {
          const ops = gen(seed * 7919 + holds.indexOf(hold), 5 + (seed % 3), seed % 2 ? ['codex', 'claude'] : ['codex', 'claude', 'gemini'], ['n1', 'n2', 'n3']);
          expect(await scenario(`r${seed}${hold.slice(0, 3)}`, hold, ops)).toEqual([]);
        });
      }
    }
  });

  describe('MEDIUM-2: the join clears Redo, as every landed agent change does', () => {
    it('K4: the person types then undoes it during the hold; after Claude\'s change joins, Redo has nothing to take it off', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      agentDoes(claude, 'ed_r7k4claude0001', () => { nebula().edges.push(wire('n1', 'n2')); n1().label = 'Claude'; });
      await settle();
      await typeMine();
      store().undo(); await settle(); await tick(1100); await settle();
      expect(store().redoStack).toHaveLength(1);
      await releaseAll();
      expect(state()).toEqual({ v: 'v0', l: 'Claude', w: ['n1>n2'] });
      sameAsNebula();
      // As outside a hold: an agent's change landing after the Undo drops it.
      expect(store().redoStack).toEqual([]);
      await redo();
      expect(state()).toEqual({ v: 'v0', l: 'Claude', w: ['n1>n2'] });
      sameAsNebula();
    });
  });

  describe('LOW-1: a refused rename leaves no trace on a held copy', () => {
    it.each([['500', 500], ['409', 409], ['a network failure', 0]] as const)('K3 (%s): the canvas ends as Nebula, and Codex\'s Undo and Redo never write the refused name', async (_label, status) => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      fake.override = (path, init) => {
        if (init?.method === 'DELETE' && path === '/api/graph/node/n1') return nebula().later('refused n1', () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }));
        if (init?.method === 'PUT' && path === '/api/graph/node/n1/label') {
          return nebula().later('label refused', () => status).then((code) => {
            if (code === 0) throw new TypeError('Failed to fetch');
            return new Response(JSON.stringify({ detail: 'No.' }), { status: code });
          });
        }
        return null;
      };
      nebula().holdAnswers = true;
      store().renameNode('n1', 'Mine');
      await settle();
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      agentDoes(codex, 'ed_r7k3codex00001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      await releaseLabelled('label refused');
      await settle();
      await releaseAll();
      fake.override = null;
      expect([labelOf('n1'), nebula().nodes.get('n1')?.label]).toEqual(['n1', 'n1']);
      sameAsNebula();
      // Its Undo puts the node back whole, as the Delete found it (the
      // decided whole-node model); its value goes back with it.
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      sameAsNebula();
      await redo();
      expect(notice()).toBe('Redid Codex’s edit.');
      expect([labelOf('n1'), nebula().nodes.get('n1')?.label, valueOf('n1')]).toEqual(['n1', 'n1', 'CODEX']);
      sameAsNebula();
    });
  });

  describe('LOW-2: the paths the notes called unreachable', () => {
    it('K1: a Paste during the restore hold sits above the agent\'s step; the held rename joins that step under it', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), { ...textFakeNode('n3'), params: { value: 'x0' } }], [], ['n3']);
      store().copySelected();
      await restoreHeld();
      agentDoes(claude, 'ed_r7k1claude0001', () => { nebula().edges.push(wire('n1', 'n2')); n1().label = 'Claude'; });
      await settle();
      store().pasteClipboard();
      await settle();
      await releaseAll();
      expect(kinds()).toEqual(['F(Claude)', 'add']);
      await undo();
      expect(store().nodes).toHaveLength(3);
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(state()).toEqual({ v: 'v0', l: 'n1', w: [] });
      sameAsNebula();
    });

    it('K2: a Delete chain step left on top by an Undo of its Delete: an earlier held change goes under it', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, { ...textFakeNode('n2'), params: { value: 'w0' } }, textFakeNode('n3')]);
      fake.override = (path, init) => (init?.method === 'DELETE' && path === '/api/graph/node/n1'
        ? nebula().later('refused n1', () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 })) : null);
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      agentDoes(claude, 'ed_r7k2claude0001', () => { n1().params = { value: 'CLAUDE1' }; });
      await settle();
      nebula().holdEchoes = true;
      store().onNodesChange([{ id: 'n2', type: 'remove' }]);
      await tick(5);
      emit({ nodes: FakeNebula.syncNodes({ nodes: [nebula().nodes.get('n1')!, { ...textFakeNode('n2'), params: { value: 'CODEX2' } }, nebula().nodes.get('n3')!], edges: [] }), edges: [], empty: false, edit: { ...codex, id: 'ed_r7k2codex00001' } });
      await settle();
      nebula().holdEchoes = false; nebula().deliverEchoes(); await settle();
      expect(await releaseLabelled('delete n2')).toBe(true);
      await settle(); await tick(100); await settle();
      store().undo();
      await settle();
      await releaseLabelled('restore');
      await settle(); await tick(100); await settle();
      await releaseAll();
      fake.override = null;
      sameAsNebula();
      expect(kinds().slice(-2)).toEqual(['F(Claude)', 'F(Codex)']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      sameAsNebula();
    });

    it('K7: the person renames after the last held sync: the name stays theirs, and Codex\'s step holds only its value', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await restoreHeld();
      agentDoes(codex, 'ed_r7k7codex00001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      store().renameNode('n1', 'Mine');
      await settle();
      expect(await releaseLabelled('restore')).toBe(true);
      await settle(); await tick(100); await settle();
      expect(labelOf('n1')).toBe('Mine');
      const step = store().undoStack.at(-1) as unknown as { after: { nodes: Record<string, { data: { label: string } }> } };
      expect(step.after.nodes.n1?.data.label).toBe('Mine');
      await releaseAll();
      expect([labelOf('n1'), valueOf('n1')]).toEqual(['Mine', 'CODEX']);
      sameAsNebula();
    });
  });

  describe('already on main: the late restore (P-A) and the clear (P-B)', () => {
    it('K6: a restore Nebula applied answers after the limit, Claude connected and renamed n1 meanwhile: no Undo deletes n1', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await settle(); await tick(6000); await settle();
      nebula().holdAnswers = true;
      store().undo();
      await settle();
      agentDoes(claude, 'ed_r7k6claude0001', () => { nebula().edges.push(wire('n1', 'n2')); n1().label = 'Claude'; });
      await settle();
      await tick(16_000); await settle();
      // Nebula applied it: the canvas shows what Nebula has.
      expect(state()).toEqual({ v: 'v0', l: 'Claude', w: ['n1>n2'] });
      sameAsNebula();
      await releaseAll();
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(state()).toEqual({ v: 'v0', l: 'n1', w: [] });
      sameAsNebula();
      // The person's Undo counted as done; Claude's change landing after it
      // dropped its Redo, as outside a hold. Redo brings Claude's back.
      expect([store().undoStack.length, store().redoStack.length]).toEqual([0, 1]);
      await redo();
      expect([notice(), state()]).toEqual(['Redid Claude’s edit.', { v: 'v0', l: 'Claude', w: ['n1>n2'] }]);
      sameAsNebula();
    });

    it('P13: Codex sets the held node, then Claude clears the canvas: each Undo brings back its own', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2'), textFakeNode('n3')]);
      await restoreHeld();
      agentDoes(codex, 'ed_r7p13codex0001', () => { n1().params = { value: 'CODEX' }; });
      await settle();
      agentDoes(claude, 'ed_r7p13claude001', () => { nebula().nodes.clear(); nebula().edges.length = 0; });
      await settle();
      await releaseAll();
      expect(cliIds()).toEqual([]);
      sameAsNebula();
      expect(kinds().slice(-2)).toEqual(['F(Codex)', 'F(Claude)']);
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect(valueOf('n1')).toBe('CODEX');
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      sameAsNebula();
    });
  });

  describe('item 6: typing queued behind a restore, then undone', () => {
    it('the typing\'s save is answered before the Undo\'s restore goes: Nebula ends where the canvas does, with no failed-save line', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'h0' } }]);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await settle(); await tick(6000); await settle();
      expect(nebula().ids()).toEqual([]);
      // The Undo of the Delete: Nebula applies the restore, its answer waits.
      nebula().holdAnswers = true;
      store().undo();
      await settle();
      expect(nebula().ids()).toEqual(['n1']);
      // The person types (the save waits behind the restore), then undoes it.
      store().updateNodeData('n1', { params: { ...nodeOf('n1')!.data.params, value: 'mine' } });
      await tick(1100); await settle();
      store().undo();
      await settle();
      expect(valueOf('n1')).toBe('h0');
      // The typing's save reaches Nebula late (the network): it is applied only when let go.
      let letGo: () => void = () => {};
      const arrived = new Promise<void>((resolve) => { letGo = resolve; });
      fake.override = (path, init) => (init?.method === 'PUT' && path === '/api/graph/node/n1'
        ? arrived.then(() => { fake.override = null; return fake.backend.apiFetch(path, init); }) : null);
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await settle();
      const restoresBefore = nebula().calls.filter((call) => call.path === '/api/graph/restore').length;
      await tick(50); await settle();
      // The second restore waits for the typing's answer.
      expect(nebula().calls.filter((call) => call.path === '/api/graph/restore').length).toBe(restoresBefore);
      letGo();
      await settle(); await tick(6000); await settle();
      expect(valueOf('n1')).toBe('h0');
      expect(nebula().valueOf('n1')).toBe('h0');
      sameAsNebula();
      expect([store().undoNotice?.text, store().messageNotice?.text].filter((line) => /Couldn’t save/.test(String(line)))).toEqual([]);
    });
  });

  describe('the Inspector: a refused Delete brings its node back unselected', () => {
    it('a node named while its refused Delete was on its way comes back with nothing selected (the put-back\'s keepPin)', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      useUIStore.getState().setInspectorPinned(true);
      refuseDelete();
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      useUIStore.getState().selectNode('n1', { keepPin: true });
      await releaseAll();
      fake.override = null;
      expect(cliIds()).toContain('n1');
      expect(nodeOf('n1')?.selected).toBeFalsy();
      expect([inUi(), useUIStore.getState().inspectorPinned]).toEqual([null, true]);
    });
  });
});
