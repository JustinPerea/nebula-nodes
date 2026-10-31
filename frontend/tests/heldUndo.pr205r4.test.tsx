import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 4: review 3 of the agent's step under a Delete, and GM r6.
// - Review 3, MEDIUM-1: an agent's rename after the person's own rename
//   landed is kept through a Delete and its Undo (A3, A3b; both orders).
// - GM r6 item 1 (review 3 LOW-1): each agent edit during a Delete is its
//   own step with its own line, newest first, never merged across agents,
//   on a Delete that goes through and on one Nebula refuses.
// - GM r6 items 2-3: what Paste, Undo or Redo brings back is the one
//   selection (the UI's selected node too), whoever's step it was.
// - Review 3 LOW-2: this tab's connections in flight keep its way (U6p,
//   U7p), and the agent's step takes only its node's connections (U17).
// The harness is review 3's probe file (round 18's fake Nebula).

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
const ORDERS = [['gone sync first', true], ['answer first', false]] as const;
let clock = Date.now();

describe('PR #205 round 4: the agent edits under a Delete', () => {
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

  describe('GM r6 item 1: each agent edit is its own step, newest first', () => {
    it.each(ORDERS)('%s: Codex, then Claude, edit n1 during the Delete: Undo brings back both, then "Undid Claude’s edit.", then "Undid Codex’s edit.", each its own', async (_label, goneFirst) => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await deleteHeld();
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'CODEX' } }, 'ed_codex000000001');
      await settle();
      agentEdits(claude, { ...textFakeNode('n1'), label: 'Claude title', params: { value: 'CODEX' } }, 'ed_claude00000001');
      await settle();
      await land(goneFirst);
      await undo();
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'Claude title']);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'n1']);
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['v0', 'n1']);
      sameAsNebula();
      // Each Undo names its own edit to Nebula's undo book.
      expect(restoreEdits().slice(-2)).toEqual(['ed_claude00000001', 'ed_codex000000001']);
      // And back up, oldest first.
      await redo();
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'n1']);
      await redo();
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'Claude title']);
      sameAsNebula();
    });

    it('two edits by the same agent are two steps (as anywhere else); two syncs of one edit are one', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await deleteHeld();
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'ONE' } }, 'ed_codexA0000001');
      await settle();
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'ONE' }, position: { x: 500, y: 500 } }, 'ed_codexA0000001', [], { moved: ['n1'] });
      await settle();
      agentEdits(codex, { ...textFakeNode('n1'), label: 'Two', params: { value: 'ONE' }, position: { x: 500, y: 500 } }, 'ed_codexB0000001');
      await settle();
      await land(true);
      await undo();
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['ONE', 'Two']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([valueOf('n1'), labelOf('n1'), nodeOf('n1')?.position]).toEqual(['ONE', 'n1', { x: 500, y: 500 }]);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect([valueOf('n1'), nodeOf('n1')?.position]).toEqual(['v0', { x: 100, y: 100 }]);
      sameAsNebula();
      expect(store().undoStack).toHaveLength(0);
    });

    it('a Delete Nebula refuses: the node stays, and each agent edit made while it was held is its own step, newest first', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      fake.override = (path, init) => (init?.method === 'DELETE' && path === '/api/graph/node/n1'
        ? nebula().later('refused n1', () => new Response(JSON.stringify({ detail: 'It is running.' }), { status: 409 }))
        : null);
      nebula().holdAnswers = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      // Nebula keeps n1 (its DELETE is refused) and takes both edits.
      nebula().nodes.set('n1', { ...textFakeNode('n1'), params: { value: 'CODEX' } });
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'CODEX' } }, 'ed_codex000000002');
      await settle();
      nebula().nodes.set('n1', { ...textFakeNode('n1'), label: 'Claude title', params: { value: 'CODEX' } });
      agentEdits(claude, { ...textFakeNode('n1'), label: 'Claude title', params: { value: 'CODEX' } }, 'ed_claude00000002');
      await settle();
      nebula().holdAnswers = false;
      while (nebula().releaseAnswer()) await settle();
      await settle(); await tick(6000); await settle();
      fake.override = null;
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'Claude title']);
      await undo();
      expect(notice()).toBe('Undid Claude’s edit.');
      expect([valueOf('n1'), labelOf('n1')]).toEqual(['CODEX', 'n1']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      sameAsNebula();
    });
  });

  describe('review 3 MEDIUM-1: an agent\'s rename after the person\'s own rename landed', () => {
    it.each(ORDERS)('%s: a sync while the rename was on its way, then its echo and answer, then Codex\'s rename: Undo brings back Codex\'s name', async (_label, goneFirst) => {
      start([{ ...textFakeNode('n1'), label: 'Old' }, textFakeNode('n2')]);
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().renameNode('n1', 'Mine');
      await tick(5);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n1');
      emit({ nodes: FakeNebula.syncNodes({ nodes: [{ ...textFakeNode('n1'), label: 'Old' }, ...others], edges: [] }).map((node) => (node.id === 'n2'
        ? { ...node, data: { ...node.data, outputs: { text: { type: 'Text', value: 'ran' } }, state: 'complete' } } : node)),
      edges: [], empty: false });
      await settle();
      nebula().deliverEcho(); await settle();
      nebula().releaseAnswer(0); await settle();
      agentEdits(codex, { ...textFakeNode('n1'), label: 'Agent name' }, 'ed_rename00000001');
      await settle();
      await land(goneFirst);
      await undo();
      expect(labelOf('n1')).toBe('Agent name');
      sameAsNebula();
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(labelOf('n1')).toBe('Mine');
      sameAsNebula();
    });

    it.each(ORDERS)('%s: no other sync (the rename\'s echo, its answer, then Codex\'s rename): Undo brings back Codex\'s name', async (_label, goneFirst) => {
      start([{ ...textFakeNode('n1'), label: 'Old' }, textFakeNode('n2')]);
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().renameNode('n1', 'Mine');
      await tick(5);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      nebula().deliverEcho(); await settle();
      nebula().releaseAnswer(0); await settle();
      agentEdits(codex, { ...textFakeNode('n1'), label: 'Agent name' }, 'ed_rename00000002');
      await settle();
      await land(goneFirst);
      await undo();
      expect(labelOf('n1')).toBe('Agent name');
      sameAsNebula();
    });

    it('control: the person\'s rename still on its way when Nebula syncs the old name, no agent rename after: Undo keeps the person\'s name', async () => {
      start([{ ...textFakeNode('n1'), label: 'Old' }, textFakeNode('n2')]);
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().renameNode('n1', 'Mine');
      await tick(5);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n1');
      emit({ nodes: FakeNebula.syncNodes({ nodes: [{ ...textFakeNode('n1'), label: 'Old' }, ...others], edges: [] }), edges: [], empty: false });
      await settle();
      nebula().releaseAnswer(0); await settle();
      await land(false);
      await undo();
      expect(labelOf('n1')).toBe('Mine');
    });
  });

  describe('review 3 LOW-2: connections', () => {
    it('U7p: the person takes a connection off, then deletes n1 at once; Codex\'s sync still has it: Undo leaves it off', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [wire('n1', 'n2')]);
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().onEdgesChange([{ id: store().edges[0].id, type: 'remove' }]);
      await tick(5);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'AGENT' } }, 'ed_u7p00000000001', [wire('n1', 'n2')]);
      await settle();
      await land(false);
      await undo();
      expect(valueOf('n1')).toBe('AGENT');
      expect(wires()).toEqual([]);
    });

    it('U6p: the person connects n1 to n2, then deletes n1 at once; Codex\'s sync lacks it: Undo brings the connection back', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().onConnect({ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' });
      await tick(5);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'AGENT' } }, 'ed_u6p00000000001');
      await settle();
      await land(false);
      await undo();
      expect(valueOf('n1')).toBe('AGENT');
      expect(wires()).toEqual(['n1>n2']);
    });

    it('U17: the agent\'s step holds only its node\'s connections: Undo, then Redo of it, leaves the others as they are', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')], [wire('n2', 'n3')]);
      await deleteHeld();
      agentEdits(codex, { ...textFakeNode('n1'), params: { value: 'AGENT' } }, 'ed_u17000000000001', [wire('n1', 'n2'), wire('n2', 'n3')]);
      await settle();
      await land(true);
      await undo();
      expect(wires()).toEqual(['n1>n2', 'n2>n3']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(wires()).toEqual(['n2>n3']);
      await redo();
      expect(wires()).toEqual(['n1>n2', 'n2>n3']);
      sameAsNebula();
    });
  });

  describe('GM r6 items 2-3: one selection', () => {
    it('Undo of an agent\'s delete brings the node back selected, alone, in the UI\'s selection too', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      useUIStore.getState().selectNode('n1');
      const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n2');
      nebula().nodes.delete('n2');
      emit({ nodes: FakeNebula.syncNodes({ nodes: others, edges: [] }), edges: [], empty: false,
        edit: { ...codex, id: 'ed_agentdelete001', removals: [] } });
      await settle();
      expect(ids()).toEqual(['n1']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(selected()).toEqual(['n2']);
      expect(inUi()).toBe('n2');
    });

    it('Undo of the person\'s Delete: the restored node is the one selection (the ring and pill move off the node clicked before)', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await settle(); await tick(6000); await settle();
      useUIStore.getState().selectNode('n2');
      await undo();
      expect(selected()).toEqual(['n1']);
      expect(inUi()).toBe('n1');
    });

    it('Duplicate, as Paste: the copy is the one selection', () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      useUIStore.getState().selectNode('n2');
      store().duplicateSelected();
      const [copy] = selected();
      expect(copy).not.toBe('n1');
      expect(inUi()).toBe(copy);
    });

    it('Paste: the copy is the one selection; a paste of several leaves no single UI selection', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      store().copySelected();
      useUIStore.getState().selectNode('n2');
      const [one] = store().pasteClipboard();
      expect(selected()).toEqual([one]);
      expect(inUi()).toBe(one);
      useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: node.id === 'n1' || node.id === 'n2' })) }));
      store().copySelected();
      const two = store().pasteClipboard();
      expect(two).toHaveLength(2);
      expect(inUi()).toBeNull();
    });
  });
});
