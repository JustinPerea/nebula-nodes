import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode, type FakeWire } from './helpers/undoFakeBackend';

// PR #205 round 3: review 2 of the newest-synced-copy restore, and GM r3/r4.
// - Review 2, undo MEDIUM-1: typing never sent (and a rename on its way) is
//   kept in the Delete's step when the DELETE answers before the "node gone"
//   sync (P1c, P1d; both orders, both paths: the held Undo and one after).
// - GM r4 item 1: an agent's edit landing while the Delete is on its way is
//   its own step under the Delete (the agent-edit line on its Undo); the
//   person's older steps never revert it silently.
// - GM r4 item 2: a restored node comes back selected, replacing the
//   selection, with or without a sync during its Delete.
// - GM r3 item 4: the agent's connections to it come back too, while the
//   node at the other end is there.
// - Review 2, undo NIT-2: P7 (the agent's move, mutant M4).
// The harness is the reviewer's probe (round 18's fake Nebula).

const fake = vi.hoisted(() => ({
  backend: null as unknown as FakeNebula,
  override: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => (fake.override ? fake.override(path, init) : fake.backend.apiFetch(path, init)),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { forgetHeldHistoryForTests, useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { setProjectContext } from '../src/lib/projectContext';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
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
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const undo = async () => { store().undo(); await settle(); await tick(6000); await settle(); };
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
const wire = (source: string, target: string): FakeWire => ({ id: `w-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'text' });
let clock = Date.now();

/** Both paths: the Undo held on the Delete, and an Undo pressed after its answer. */
const PATHS = [['held Undo', true], ['Undo after the answer', false]] as const;
/** Both orders on the person's machine: the "node gone" sync, then the DELETE's answer, or the answer first. */
const ORDERS = [['gone sync first', true], ['answer first', false]] as const;
const CASES = PATHS.flatMap(([path, held]) => ORDERS.map(([order, goneFirst]) => [`${path}, ${order}`, held, goneFirst] as const));

describe('PR #205 round 3: the copy a Delete brings back', () => {
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
  const start = (nodes: FakeNode[], edges: FakeWire[] = [], chosen: string[] = []) => {
    nebula().reset(nodes, edges);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node, chosen.includes(node.id) ? { selected: true } : {})),
      edges: edges.map((edge) => ({ ...edge, type: 'typed-edge', data: { dataType: 'Text' } })) as Edge[],
      isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  /** The Delete of n1 on its way: its answer and its "gone" echo both held. */
  const deleteHeld = async (id = 'n1') => {
    nebula().holdAnswers = true;
    nebula().holdEchoes = true;
    store().onNodesChange([{ id, type: 'remove' }]);
    await tick(5);
  };
  /** Then Nebula's "gone" sync and the DELETE's answer reach the page, in `goneFirst`'s order. */
  const land = async (goneFirst: boolean) => {
    if (goneFirst) { nebula().deliverEchoes(); await settle(); }
    // The answers on their way now (the Delete's, a rename's). A request they
    // start (the held Undo's restore) waits: Nebula's syncs sent before its
    // answer reach the page first, as the WebSocket and HTTP order them.
    for (let left = nebula().answers.length; left > 0; left -= 1) { nebula().releaseAnswer(0); await settle(); }
    nebula().holdEchoes = false;
    nebula().deliverEchoes();
    await settle();
    nebula().holdAnswers = false;
    while (nebula().releaseAnswer()) await settle();
    await settle(); await tick(6000); await settle();
  };
  /** A sync that still carries n1 as Nebula had it before the Delete (a run's
   * output on n2, or an agent's edit to another node). */
  const syncWithN1 = (n1: FakeNode) => {
    const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n1');
    emit({ nodes: FakeNebula.syncNodes({ nodes: [n1, ...others], edges: [] })
      .map((node) => (node.id === 'n2' ? { ...node, data: { ...node.data, outputs: { text: { type: 'Text', value: 'ran' } }, state: 'complete' } } : node)),
    edges: [], empty: false });
  };
  /** Codex's edit to n1 that Nebula took before the Delete: synced while the Delete is on its way. */
  const codexEditsN1 = (change: Partial<FakeNode>, edges: FakeWire[] = []) => {
    const others = [...nebula().nodes.values()].filter((node) => node.id !== 'n1');
    emit({ nodes: FakeNebula.syncNodes({ nodes: [{ ...textFakeNode('n1', 'v0'), ...change }, ...others], edges: [] }),
      edges, empty: false, ...(change.position ? { moved: ['n1'] } : {}), edit: { ...codex, id: `ed_${Math.random()}` } });
  };

  describe('review 2, undo MEDIUM-1: the person\'s own typing and rename stay theirs', () => {
    it.each(CASES)('typing never sent, a sync with n1 during the Delete (%s): Undo brings it back as typed, here and in Nebula', async (_label, held, goneFirst) => {
      start([{ ...textFakeNode('n1'), params: { value: 'saved' } }, textFakeNode('n2')]);
      store().updateNodeData('n1', { params: { value: 'TYPED' } });
      await tick(20);
      await deleteHeld();
      if (held) { store().undo(); await settle(); }
      syncWithN1({ ...textFakeNode('n1'), params: { value: 'saved' } });
      await settle();
      await land(goneFirst);
      if (!held) await undo();
      expect(valueOf('n1')).toBe('TYPED');
      expect(nebula().valueOf('n1')).toBe('TYPED');
    });

    it.each(CASES)('a rename still on its way, a sync with the old name during the Delete (%s): Undo keeps the new name', async (_label, held, goneFirst) => {
      start([{ ...textFakeNode('n1'), label: 'Old' }, textFakeNode('n2')]);
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().renameNode('n1', 'Mine');
      await tick(5);
      store().onNodesChange([{ id: 'n1', type: 'remove' }]);
      await tick(5);
      if (held) { store().undo(); await settle(); }
      syncWithN1({ ...textFakeNode('n1'), label: 'Old' });
      await settle();
      // The rename's answer, then (as `goneFirst` says) the echoes and the Delete's.
      nebula().releaseAnswer(0); await settle();
      await land(goneFirst);
      if (!held) await undo();
      expect(labelOf('n1')).toBe('Mine');
      expect(nebula().nodes.get('n1')?.label).toBe('Mine');
    });
  });

  describe('GM r4 item 1: the agent\'s edit is its own step under the Delete', () => {
    it.each(CASES)('%s: Undo restores the agent\'s copy; the next Undo undoes only the agent\'s edit, with its line; the next, the person\'s own older step', async (_label, held, goneFirst) => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      // The person's own earlier step: an edit to n2.
      store().updateNodeData('n2', { params: { value: 'MINE2' } });
      await tick(400); await settle(); await tick(6000); await settle();
      await deleteHeld();
      if (held) { store().undo(); await settle(); }
      codexEditsN1({ label: 'Agent title', params: { value: 'AGENT' } });
      await settle();
      await land(goneFirst);
      if (!held) await undo();
      expect(valueOf('n1')).toBe('AGENT');
      expect(labelOf('n1')).toBe('Agent title');
      expect(selected()).toEqual(['n1']);
      sameAsNebula();
      // Never silently: the agent's edit is undone with the agent-edit line, alone.
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(valueOf('n1')).toBe('v0');
      expect(labelOf('n1')).toBe('n1');
      expect(valueOf('n2')).toBe('MINE2');
      sameAsNebula();
      // Then the person's own step, n2 alone.
      await undo();
      expect(valueOf('n2')).toBe('n2');
      expect(valueOf('n1')).toBe('v0');
      sameAsNebula();
    });

    it('Redo of the agent\'s step after both Undos puts the agent\'s edit back, then Redo deletes the node again', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      await deleteHeld();
      codexEditsN1({ params: { value: 'AGENT' } });
      await settle();
      await land(true);
      await undo();
      await undo();
      expect(valueOf('n1')).toBe('v0');
      store().redo(); await settle(); await tick(6000); await settle();
      expect(valueOf('n1')).toBe('AGENT');
      store().redo(); await settle(); await tick(6000); await settle();
      expect(nodeOf('n1')).toBeUndefined();
      sameAsNebula();
    });

    it('control: a sync of the person\'s own (an echo) is no agent step: one Undo restores, the next goes to the step below', async () => {
      start([{ ...textFakeNode('n1'), params: { value: 'v0' } }, textFakeNode('n2')]);
      store().updateNodeData('n2', { params: { value: 'MINE2' } });
      await tick(400); await settle(); await tick(6000); await settle();
      await deleteHeld();
      syncWithN1({ ...textFakeNode('n1'), params: { value: 'v0' } });
      await settle();
      await land(false);
      await undo();
      expect(valueOf('n1')).toBe('v0');
      await undo();
      expect(notice()).not.toBe('Undid Codex’s edit.');
      expect(valueOf('n2')).toBe('n2');
    });
  });

  describe('GM r4 item 2: a restored node comes back selected, replacing the selection', () => {
    it.each([['no sync during the Delete', false], ['a sync with n1 during the Delete', true]] as const)('%s: n1 selected, n2 (selected now) not', async (_label, withSync) => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n1']);
      await deleteHeld();
      if (withSync) syncWithN1(textFakeNode('n1'));
      await settle();
      await land(true);
      useGraphStore.setState({ nodes: store().nodes.map((node) => ({ ...node, selected: node.id === 'n2' })) });
      await undo();
      expect(selected()).toEqual(['n1']);
    });

    it('an unselected node deleted (the Inspector\'s Delete) comes back selected too', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [], ['n2']);
      await deleteHeld();
      await land(true);
      await undo();
      expect(selected()).toEqual(['n1']);
    });
  });

  describe('GM r3 item 4: the agent\'s connections to the node come back with it', () => {
    it.each(CASES)('%s: the agent connected n1 to n2 while the Delete was on its way; Undo brings the connection back, here and in Nebula', async (_label, held, goneFirst) => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      await deleteHeld();
      if (held) { store().undo(); await settle(); }
      codexEditsN1({}, [wire('n1', 'n2')]);
      await settle();
      await land(goneFirst);
      if (!held) await undo();
      expect(wires()).toEqual(['n1>n2']);
      sameAsNebula();
    });

    it('the agent took a connection off while the Delete was on its way: Undo leaves it off', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')], [wire('n1', 'n2')]);
      await deleteHeld();
      codexEditsN1({}, []);
      await settle();
      await land(true);
      await undo();
      expect(wires()).toEqual([]);
      sameAsNebula();
    });

    it('the node at the other end is gone by the Undo (the agent made it, and its Undo took it off): that connection isn\'t brought back', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      await deleteHeld();
      // Codex adds n9 and connects n1 to it while the Delete is on its way.
      nebula().nodes.set('n9', textFakeNode('n9'));
      codexEditsN1({}, [wire('n1', 'n9')]);
      await settle();
      // Nebula's "gone" sync after it is its graph with n9.
      nebula().echoes = [];
      nebula().broadcast();
      await land(true);
      expect(ids()).toEqual(['n2', 'n9']);
      await undo();
      expect(notice()).toBe('Undid Codex’s edit.');
      expect(ids()).toEqual(['n2']);
      // On the canvas at once, before Nebula's answer or sync (snapshotNext).
      store().undo();
      expect(ids()).toEqual(['n1', 'n2']);
      expect(store().edges.filter((edge) => edge.source === 'n9' || edge.target === 'n9')).toEqual([]);
      await settle(); await tick(6000); await settle();
      expect(ids()).toEqual(['n1', 'n2']);
      expect(store().edges.filter((edge) => edge.source === 'n9' || edge.target === 'n9')).toEqual([]);
      sameAsNebula();
    });

    it('both ends deleted together, and the agent\'s sync of n1 comes without n3 (its DELETE done there first): Undo keeps the n1-n3 connection', async () => {
      start([textFakeNode('n1'), textFakeNode('n2'), textFakeNode('n3')], [wire('n1', 'n3')]);
      nebula().holdAnswers = true;
      nebula().holdEchoes = true;
      store().onNodesChange([{ id: 'n1', type: 'remove' }, { id: 'n3', type: 'remove' }]);
      await tick(5);
      emit({ nodes: FakeNebula.syncNodes({ nodes: [textFakeNode('n1', 'v0'), textFakeNode('n2')], edges: [] }),
        edges: [], empty: false, edit: { ...codex, id: 'ed_there' } });
      await settle();
      await land(true);
      await undo();
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      expect(valueOf('n1')).toBe('v0');
      expect(wires()).toEqual(['n1>n3']);
      sameAsNebula();
    });
  });

  describe('review 2, undo NIT-2 (M4): the agent\'s move', () => {
    it('P7: the agent moved the node while its Delete was on its way: it comes back where the agent put it', async () => {
      start([textFakeNode('n1'), textFakeNode('n2')]);
      await deleteHeld();
      store().undo(); await settle();
      codexEditsN1({ position: { x: 900, y: 900 } });
      await settle();
      await land(true);
      expect(nodeOf('n1')?.position).toEqual({ x: 900, y: 900 });
    });
  });
});
