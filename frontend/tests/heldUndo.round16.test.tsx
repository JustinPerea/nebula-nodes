import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 15 (probes P1, P1b, P2, P6, P7, X3, X4, Q1, Q1b, Q3, C7), round 16.
// Every case checks the restore bodies sent to the backend and that the
// canvas ends where Nebula's graph does: a fake backend applies each delete
// (its answer), each sync (it is the backend's graph then), each clear and
// each restore, in the order they reach it.
// M-A follow-up and L-1 (coordinator's decision): an undo removes only the
//   node ids its own step added. A step taken between a multi-node delete's
//   echoes (typing) never takes back a node the delete's undo restored, and
//   a typing step never takes off a node a sync brought.
// L-2: a Cmd+Z never silently does nothing. A step with nothing left to
//   change is dropped, so the press goes to the next real step; a held press
//   whose step was refused counts in the skipped line.

type Answer = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: string }>,
  held: new Map<string, (answer: Answer) => void>(),
  holdDeletes: true,
  backend: new Set<string>(),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    net.calls.push({ path, method, body });
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      const answer = net.holdDeletes
        ? await new Promise<Answer>((resolve) => { net.held.set(deleted[1], resolve); })
        : { status: 200, body: { status: 'deleted', id: deleted[1] } };
      if (answer.status === 200) net.backend.delete(deleted[1]);
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (path === '/api/graph/restore') {
      const sent = JSON.parse(body ?? '{}') as { nodes?: Array<{ id: string }>; remove?: string[] };
      for (const node of sent.nodes ?? []) net.backend.add(node.id);
      for (const id of sent.remove ?? []) net.backend.delete(id);
      return new Response(JSON.stringify({ status: 'restored', reattached: [], reopened: [], notReopened: [], pinsLeft: [], removals: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { DROPPED_UNDO_TEXT } from '../src/lib/deleteNotice';

const initialGraph = useGraphStore.getState();
function textNode(id: string, value = id): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 100, y: 100 }, width: 120, height: 60,
    data: { label: id, definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
const CLI = /^n\d+$/;
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const cliIds = () => ids().filter((id) => CLI.test(id));
const backend = () => [...net.backend].sort();
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const notice = () => store().undoNotice?.text ?? null;
const message = () => store().messageNotice?.text ?? null;
/** The dropped-press line, wherever it shows (the notice, or the message beside an error). */
const dropped = () => [notice(), message()].includes(DROPPED_UNDO_TEXT);
const edgeIds = () => store().edges.map((edge) => `${edge.source}>${edge.target}`).sort();
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });
const undo = async () => { act(() => { store().undo(); }); await settle(); };
const redo = async () => { act(() => { store().redo(); }); await settle(); };
const pause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
const answer = async (id: string, status = 200) => {
  const resolve = net.held.get(id);
  if (!resolve) throw new Error(`no delete of ${id} on its way`);
  net.held.delete(id);
  await act(async () => {
    resolve(status === 200 ? { status, body: { status: 'deleted', id } } : { status, body: { detail: 'Nebula failed.' } });
  });
  await settle();
};
/** Each restore body: the nodes it brought back (id=value), the wires it made and took off, the ids it removed. */
const restores = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore')
  .map((call) => JSON.parse(call.body ?? '{}') as { nodes: Array<{ id: string; params?: { value?: string } }>;
    wire?: Array<{ source: string; target: string }>; unwire?: Array<{ source: string; target: string }>; remove: string[] })
  .map((body) => ({ nodes: body.nodes.map((node) => `${node.id}=${node.params?.value}`).sort(),
    wire: (body.wire ?? []).map((edge) => `${edge.source}>${edge.target}`).sort(),
    unwire: (body.unwire ?? []).map((edge) => `${edge.source}>${edge.target}`).sort(),
    remove: [...body.remove].sort() }));
const restore = (nodes: string[], remove: string[] = [], wire: string[] = [], unwire: string[] = []) => ({ nodes, wire, unwire, remove });
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, edges: [], ...event } as unknown as ExecutionEvent;
  act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full); });
};
const cli = (nodes: Node<NodeData>[]) => nodes.filter((node) => CLI.test(node.id));
/** This tab's own echo: the backend's graph (its nodes, and the canvas's wires among them) reaching the canvas. */
const ownSync = (nodes: Node<NodeData>[]) => {
  const keep = new Set(cli(nodes).map((node) => node.id));
  net.backend = new Set(keep);
  const edges = store().edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
  emit({ nodes: cli(nodes), edges, empty: keep.size === 0, edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' } });
};
/** A sync with no edit origin (a reconnect's full graph). */
const plainSync = (nodes: Node<NodeData>[]) => {
  net.backend = new Set(nodes.map((node) => node.id));
  emit({ nodes, edges: [], empty: nodes.length === 0 });
};
const type = (id: string, value: string) => { act(() => { store().updateNodeData(id, { params: { value } }); }); };
const removeTogether = (...nodeIds: string[]) => {
  act(() => { store().onNodesChange(nodeIds.map((id) => ({ id, type: 'remove' as const }))); });
};
const clearStep = () => store().beginUndoStep({ clear: true });
/** The toolbar's clear answering: the backend cleared, then the canvas. */
const clearAnswers = (step: object) => {
  for (const id of [...net.backend]) if (CLI.test(id)) net.backend.delete(id);
  act(() => { store().clearGraph({ undoStep: step }); });
  act(() => { store().endUndoStep(step); });
};
const edge = (source: string, target: string): Edge => ({ id: `e-${source}-${target}`, source, target, sourceHandle: 'text', targetHandle: 'text' });

describe('round 16 (review 15): an undo takes off only what its step added; no silent Cmd+Z', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.held.clear();
    net.holdDeletes = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const [id, resolve] of [...net.held]) {
      net.held.delete(id);
      await act(async () => { resolve({ status: 200, body: { status: 'deleted', id } }); });
    }
    await settle();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const setGraph = (nodes: Node<NodeData>[], edges: Edge[] = []) => {
    net.backend = new Set(cli(nodes).map((node) => node.id));
    useGraphStore.setState({ nodes, edges, isExecuting: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  const sameAsBackend = () => expect(cliIds()).toEqual(backend());

  describe('M-A follow-up: a step taken between a delete\'s echoes', () => {
    it('P1 (r14 M3, undo2): typing between the echoes; Cmd+Z x2 then Cmd+Shift+Z x2', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      type('n3', 'F');
      ownSync([textNode('n3', 'F')]);
      await answer('n1'); await answer('n2');
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): the delete's step stays below the typing, so the first Cmd+Z undoes the typing.
      expect(restores()).toEqual([restore(['n3=n3'])]);
      expect(notice()).not.toBe('Deleted the node.');
      expect(ids()).toEqual(['n3']);
      expect(valueOf('n3')).toBe('n3');
      sameAsBackend();
      await undo();
      // Round 18 (GM option (c)): the second Cmd+Z restores both nodes.
      expect(restores()[1]).toEqual(restore(['n1=n1', 'n2=n2']));
      expect(notice()).toBe('Restored 2 nodes.');
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      expect(valueOf('n3')).toBe('n3');
      sameAsBackend();
      await redo();
      // Round 18 (GM option (c)): redo runs in the new order: the delete first.
      expect(restores()[2]).toEqual(restore([], ['n1', 'n2']));
      expect(notice()).toBe('Deleted 2 nodes.');
      expect(ids()).toEqual(['n3']);
      sameAsBackend();
      await redo();
      // Round 18 (GM option (c)): then the typing.
      expect(restores()[3]).toEqual(restore(['n3=F']));
      expect(ids()).toEqual(['n3']);
      expect(valueOf('n3')).toBe('F');
      sameAsBackend();
      expect(restores()).toHaveLength(4);
    });

    it('P1b: the same with the echoes reversed (n2 first)', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n1'), textNode('n3')]);
      type('n3', 'F');
      ownSync([textNode('n3', 'F')]);
      await answer('n2'); await answer('n1');
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): the typing is the newer step, undone first.
      expect(restores()).toEqual([restore(['n3=n3'])]);
      sameAsBackend();
      await undo();
      // Round 18 (GM option (c)): then the delete.
      expect(restores()).toEqual([restore(['n3=n3']), restore(['n1=n1', 'n2=n2'])]);
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('P2: three nodes, one DELETE answers 500 with no echo, typing between the other echoes; Cmd+Z x2, Cmd+Shift+Z', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3'), textNode('n4')]);
      removeTogether('n1', 'n2', 'n3'); await settle();
      ownSync([textNode('n2'), textNode('n3'), textNode('n4')]);
      type('n4', 'T');
      ownSync([textNode('n2'), textNode('n4', 'T')]);
      await answer('n1'); await answer('n3'); await answer('n2', 500);
      expect(ids()).toEqual(['n2', 'n4']);
      sameAsBackend();
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): the typing is the newer step, undone first.
      expect(restores()).toEqual([restore(['n4=n4'])]);
      expect(ids()).toEqual(['n2', 'n4']);
      sameAsBackend();
      await undo();
      // Round 18 (GM option (c)): then the delete, bringing back only the two it removed.
      expect(restores()[1]).toEqual(restore(['n1=n1', 'n3=n3']));
      expect(ids()).toEqual(['n1', 'n2', 'n3', 'n4']);
      sameAsBackend();
      await redo();
      // Round 18 (GM option (c)): redo runs in the new order: the delete first.
      expect(restores()[2]).toEqual(restore([], ['n1', 'n3']));
      expect(ids()).toEqual(['n2', 'n4']);
      sameAsBackend();
    });

    it('P6: wires n1>n2>n3, delete n1+n2, typing between the echoes: the second Cmd+Z keeps both nodes and their wires', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')], [edge('n1', 'n2'), edge('n2', 'n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      type('n3', 'F');
      ownSync([textNode('n3', 'F')]);
      await answer('n1'); await answer('n2');
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): the typing is the newer step, undone first.
      expect(restores()).toEqual([restore(['n3=n3'])]);
      expect(edgeIds()).toEqual([]);
      sameAsBackend();
      await undo();
      // Round 18 (GM option (c)): then the delete, with both wires.
      expect(restores()[1]).toEqual(restore(['n1=n1', 'n2=n2'], [], ['n1>n2', 'n2>n3']));
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      expect(edgeIds()).toEqual(['n1>n2', 'n2>n3']);
      sameAsBackend();
    });

    it('P7: three nodes, Cmd+Z held from the start, typing after each echo; the typing steps undo one by one', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3'), textNode('n4')]);
      removeTogether('n1', 'n2', 'n3'); await settle();
      await undo();
      // Round 18 (GM option (c)): the press during the delete's flight is dropped at once and changes nothing.
      expect(dropped()).toBe(true);
      expect(ids()).toEqual(['n4']);
      ownSync([textNode('n1'), textNode('n2'), textNode('n4')]);
      type('n4', 'A'); await pause();
      ownSync([textNode('n1'), textNode('n4', 'A')]);
      type('n4', 'AB');
      ownSync([textNode('n4', 'AB')]);
      await answer('n3'); await answer('n2'); await answer('n1');
      // Round 18 (GM option (c)): the dropped press is never applied late.
      expect(restores()).toEqual([]);
      sameAsBackend();
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): the typing steps are above the delete's, so they undo first, one by one.
      expect(restores()[0]).toEqual(restore(['n4=A']));
      expect(ids()).toEqual(['n4']);
      sameAsBackend();
      await undo();
      expect(restores()[1]).toEqual(restore(['n4=n4']));
      expect(ids()).toEqual(['n4']);
      expect(notice() ?? '').not.toMatch(/Deleted|Restored/);
      sameAsBackend();
      await undo();
      // Round 18 (GM option (c)): then one Cmd+Z restores the three.
      expect(restores()[2]).toEqual(restore(['n1=n1', 'n2=n2', 'n3=n3']));
      expect(notice()).toBe('Restored 3 nodes.');
      expect(ids()).toEqual(['n1', 'n2', 'n3', 'n4']);
      sameAsBackend();
    });
  });

  describe('L-1: a typing step never takes off a node a sync brought', () => {
    it('X3: type in n1, a reconnect\'s sync adds an agent\'s n3, Cmd+Z: the typing goes, n3 stays', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      net.holdDeletes = false;
      type('n1', 'E'); await pause();
      plainSync([textNode('n1', 'E'), textNode('n2'), textNode('n3')]);
      await undo();
      expect(restores()).toEqual([restore(['n1=n1'])]);
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      expect(notice()).not.toBe('Deleted the node.');
      sameAsBackend();
    });

    it('X4: the same while the typing is still within its step', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      net.holdDeletes = false;
      type('n1', 'E');
      plainSync([textNode('n1', 'E'), textNode('n2'), textNode('n3')]);
      await undo();
      expect(restores()).toEqual([restore(['n1=n1'])]);
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('control: a duplicate made by the person is still taken off by its undo, a node a sync brought is not', async () => {
      setGraph([textNode('n1')]);
      net.holdDeletes = false;
      act(() => { store().duplicateNode('n1'); });
      const copy = store().nodes.find((node) => node.id !== 'n1')!.id;
      plainSync([textNode('n1'), textNode('n3')]);
      await undo();
      expect(ids()).toEqual(['n1', 'n3']);
      expect(store().nodes.some((node) => node.id === copy)).toBe(false);
      sameAsBackend();
    });

    it("control: an upload's own node goes with its undo; an agent's node that arrived meanwhile stays", async () => {
      setGraph([textNode('n1')]);
      net.holdDeletes = false;
      const up = store().beginUndoStep();
      plainSync([textNode('n1'), textNode('n3')]);
      plainSync([textNode('n1'), textNode('n3'), textNode('n9')]);
      act(() => { store().endUndoStep(up, { arrives: ['n9'] }); });
      await settle();
      await undo();
      expect(restores()).toEqual([restore([], ['n9'])]);
      expect(ids()).toEqual(['n1', 'n3']);
      sameAsBackend();
    });
  });

  describe('L-2: a Cmd+Z never silently does nothing', () => {
    it('Q1: a delete answers 404 after the clear answered: one Cmd+Z puts the clear back, and no dead step is left', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      const step = clearStep();
      clearAnswers(step); await settle();
      await answer('n1', 404);
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): n1 left before the clear, so the clear's undo puts back n2 only; the delete's step stays below.
      expect(restores()).toEqual([restore(['n2=n2'])]);
      expect(notice()).toBe('Restored the node.');
      expect(store().undoStack).toHaveLength(1);
      sameAsBackend();
      await undo();
      // Round 18 (GM option (c)): the next Cmd+Z undoes the delete (a 404 counts as deleted); no dead step is left.
      expect(restores()).toEqual([restore(['n2=n2']), restore(['n1=n1'])]);
      expect(store().undoStack).toHaveLength(0);
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
    });

    it('Q1b: the same with the delete answering 200', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      const step = clearStep();
      clearAnswers(step); await settle();
      await answer('n1');
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): n1 left before the clear, so the clear's undo puts back n2 only; the delete's step stays below.
      expect(restores()).toEqual([restore(['n2=n2'])]);
      expect(store().undoStack).toHaveLength(1);
      await undo();
      // Round 18 (GM option (c)): the next Cmd+Z undoes the delete.
      expect(restores()).toEqual([restore(['n2=n2']), restore(['n1=n1'])]);
      expect(store().undoStack).toHaveLength(0);
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
    });

    it('Q3: a delete made while a clear was on its way: the first Cmd+Z puts the clear back', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      const step = clearStep();
      act(() => { store().deleteNode('n1'); }); await settle();
      clearAnswers(step); await settle();
      await answer('n1', 404);
      expect(ids()).toEqual([]);
      net.holdDeletes = false;
      await undo();
      expect(restores()).toEqual([restore(['n1=n1', 'n2=n2'])]);
      expect(notice()).toBe('Restored 2 nodes.');
      expect(ids()).toEqual(['n1', 'n2']);
      expect(store().undoStack).toHaveLength(0);
      sameAsBackend();
    });

    it('C7: a held Cmd+Z for a clear that was then refused counts in the skipped line', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      // Round 18 (GM option (c)): the press during the delete's flight is dropped at once, not held.
      expect(notice()).toBe(DROPPED_UNDO_TEXT);
      expect(ids()).toEqual(['n2']);
      // Clear that line so the held press below has to say its own.
      act(() => { useGraphStore.setState({ undoNotice: null } as never); });
      const step = clearStep();
      await undo();
      expect(dropped()).toBe(false);
      act(() => { store().cancelUndoStep(step); store().endUndoStep(step); }); await settle();
      // Round 18 (GM option (c)): the press held for the refused clear says it skipped at once (no later restore to say it beside).
      expect(notice()).toBe(DROPPED_UNDO_TEXT);
      await answer('n1');
      // Round 18 (GM option (c)): neither press is applied late.
      expect(restores()).toEqual([]);
      expect(notice()).toBe('Deleted the node.');
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): once the delete has landed, a new Cmd+Z restores the node.
      expect(restores()).toEqual([restore(['n1=n1'])]);
      expect(notice()).toBe('Restored the node.');
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
    });

    it("control (r14 Q10): a refused delete's own line stays where it was; the skipped press is said beside it", async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      type('n1', 'E1');
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo(); await undo();
      // Round 18 (GM option (c)): both presses target the delete still on its way: each is dropped at once and changes nothing.
      expect(notice()).toBe(DROPPED_UNDO_TEXT);
      expect(valueOf('n1')).toBe('E1');
      await answer('n2', 409);
      expect(notice()).toBe("Couldn't delete the node. Nebula failed.");
      // Round 18 (GM option (c)): no press was held, so nothing is said beside the failure line and nothing is applied late.
      expect(message()).toBeNull();
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n1', 'n2']);
      net.holdDeletes = false;
      await undo();
      // Round 18 (GM option (c)): the failed delete left no step, so a new Cmd+Z undoes the typing; the failure line stays.
      expect(notice()).toBe("Couldn't delete the node. Nebula failed.");
      expect(restores()).toEqual([restore(['n1=n1'])]);
      expect(store().undoStack).toHaveLength(0);
      sameAsBackend();
    });
    it('r14 C1: two clears, a Cmd+Z held for the first; the second changed nothing, so the next Cmd+Z puts the first back', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      const first = clearStep();
      await undo();
      const second = clearStep();
      clearAnswers(first); await settle();
      clearAnswers(second); await settle();
      expect(ids()).toEqual([]);
      net.holdDeletes = false;
      await undo();
      expect(restores()).toEqual([restore(['n1=n1', 'n2=n2'])]);
      expect(ids()).toEqual(['n1', 'n2']);
      expect(store().undoStack).toHaveLength(0);
      sameAsBackend();
    });

    it('control (r14 D1): a held Cmd+Shift+Z with nothing to redo when it was pressed stays quiet', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo(); await redo(); await redo();
      await answer('n2');
      expect(notice()).toBe('Deleted the node.');
      expect(message()).toBeNull();
      sameAsBackend();
    });
  });
});
