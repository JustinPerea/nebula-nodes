import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 14 (probes M2-M6, E2/E3, C3, C5/C5b, X1/X1b, F1), round 15. Every
// case checks the restore bodies sent to the backend, the line the person
// reads, and that the canvas ends where Nebula's graph does: a fake backend
// applies each delete (its answer), each sync (it is the backend's graph
// then), each clear and each restore, in the order they reach it.
// M-A: one delete gesture is one undo step that brings back every node it
//   removed, whatever lands between its echoes (an agent's edit, the
//   person's typing), held or not, in either echo order.
// L-A: an echo that empties the graph places the delete's step like any echo.
// L-B: a clear supersedes only the presses issued before it; a press issued
//   after it targets the clear and runs once the clear settles.
// L-C: a step taken while a clear is on its way loses the nodes the clear removes.
// L-D: undoing a delete never removes a node the delete didn't add.
// L-E: a delete whose echo already took the node off is done, whatever its answer says.

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
/** A delete's failure line, wherever it shows (the notice, or the message beside it). */
const failure = () => [notice(), message()].find((text) => text?.startsWith("Couldn't delete")) ?? null;
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });
const undo = async () => { act(() => { store().undo(); }); await settle(); };
const answer = async (id: string, status = 200) => {
  const resolve = net.held.get(id);
  if (!resolve) throw new Error(`no delete of ${id} on its way`);
  net.held.delete(id);
  await act(async () => {
    resolve(status === 200 ? { status, body: { status: 'deleted', id } } : { status, body: { detail: 'Nebula failed.' } });
  });
  await settle();
};
/** Each restore body: the nodes it brought back (id=value) and the ids it removed. */
const restores = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore')
  .map((call) => JSON.parse(call.body ?? '{}') as { nodes: Array<{ id: string; params?: { value?: string } }>; remove: string[] })
  .map((body) => ({ nodes: body.nodes.map((node) => `${node.id}=${node.params?.value}`).sort(), remove: [...body.remove].sort() }));
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, edges: [], ...event } as unknown as ExecutionEvent;
  act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full); });
};
const cli = (nodes: Node<NodeData>[]) => nodes.filter((node) => CLI.test(node.id));
/** This tab's own echo: the backend's graph (its nodes only) reaching the canvas. */
const ownSync = (nodes: Node<NodeData>[]) => {
  net.backend = new Set(cli(nodes).map((node) => node.id));
  emit({ nodes: cli(nodes), edges: [], empty: cli(nodes).length === 0, edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' } });
};
const agentSync = (nodes: Node<NodeData>[]) => {
  net.backend = new Set(nodes.map((node) => node.id));
  emit({ nodes, edges: [], empty: nodes.length === 0, edit: { actor: { kind: 'agent', name: 'Codex', color: '#ff00aa' }, id: 'ed_agent' } });
};
/** A sync with no edit origin (a reconnect's full graph). */
const plainSync = (nodes: Node<NodeData>[]) => {
  net.backend = new Set(nodes.map((node) => node.id));
  emit({ nodes, edges: [], empty: nodes.length === 0 });
};
/** Nebula's graph comes back to the canvas (the last restore's echo): nothing may change. */
const backendEcho = () => ownSync(backend().map((id) => store().nodes.find((node) => node.id === id) ?? textNode(id)));
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

describe('a held Cmd+Z, round 15 (review 14)', () => {
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
  const setGraph = (nodes: Node<NodeData>[]) => {
    net.backend = new Set(cli(nodes).map((node) => node.id));
    useGraphStore.setState({ nodes, edges: [], isExecuting: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  const sameAsBackend = () => expect(cliIds()).toEqual(backend());

  describe('M-A: one delete gesture comes back whole from one undo', () => {
    it('M2: an agent edit between the two echoes: one Cmd+Z restores both nodes, the next undoes Codex', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      agentSync([textNode('n2'), textNode('n3'), textNode('n4')]);
      ownSync([textNode('n3'), textNode('n4')]);
      await answer('n1'); await answer('n2');
      net.holdDeletes = false;
      await undo();
      expect(restores()).toEqual([{ nodes: ['n1=n1', 'n2=n2'], remove: [] }]);
      expect(notice()).toBe('Restored 2 nodes.');
      expect(ids()).toEqual(['n1', 'n2', 'n3', 'n4']);
      sameAsBackend();
      await undo();
      expect(restores()[1]).toEqual({ nodes: [], remove: ['n4'] });
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('M3: the person types between the two echoes: both nodes back, the typing kept', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      type('n3', 'F');
      ownSync([textNode('n3', 'F')]);
      await answer('n1'); await answer('n2');
      net.holdDeletes = false;
      await undo();
      expect(restores()).toEqual([{ nodes: ['n1=n1', 'n2=n2'], remove: [] }]);
      expect(notice()).toBe('Restored 2 nodes.');
      expect(valueOf('n3')).toBe('F');
      sameAsBackend();
    });

    it('M5: three nodes, Cmd+Z held from the start, an agent edit after the first echo', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3'), textNode('n4')]);
      removeTogether('n1', 'n2', 'n3'); await settle();
      await undo();
      ownSync([textNode('n2'), textNode('n3'), textNode('n4')]);
      agentSync([textNode('n2'), textNode('n3'), textNode('n4'), textNode('n5')]);
      ownSync([textNode('n3'), textNode('n4'), textNode('n5')]);
      ownSync([textNode('n4'), textNode('n5')]);
      await answer('n1'); await answer('n2'); await answer('n3');
      expect(restores()).toEqual([{ nodes: ['n1=n1', 'n2=n2', 'n3=n3'], remove: [] }]);
      expect(notice()).toBe('Restored 3 nodes.');
      expect(ids()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
      sameAsBackend();
      backendEcho();
      expect(ids()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    });

    it('M6: typing after the first echo, Cmd+Z held after both echoes', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      type('n3', 'F');
      ownSync([textNode('n3', 'F')]);
      await undo();
      await answer('n1'); await answer('n2');
      expect(restores()).toEqual([{ nodes: ['n1=n1', 'n2=n2'], remove: [] }]);
      expect(notice()).toBe('Restored 2 nodes.');
      expect(valueOf('n3')).toBe('F');
      sameAsBackend();
    });

    it('the echoes in reverse order, an agent edit between them: both back', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n1'), textNode('n3')]);
      agentSync([textNode('n1'), textNode('n3'), textNode('n4')]);
      ownSync([textNode('n3'), textNode('n4')]);
      await answer('n2'); await answer('n1');
      net.holdDeletes = false;
      await undo();
      expect(restores()).toEqual([{ nodes: ['n1=n1', 'n2=n2'], remove: [] }]);
      expect(notice()).toBe('Restored 2 nodes.');
      sameAsBackend();
    });

    it('held, the person types between the echoes in reverse order: both back, the typing kept', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      await undo();
      ownSync([textNode('n1'), textNode('n3')]);
      type('n3', 'G');
      ownSync([textNode('n3', 'G')]);
      await answer('n2'); await answer('n1');
      expect(restores()).toEqual([{ nodes: ['n1=n1', 'n2=n2'], remove: [] }]);
      expect(notice()).toBe('Restored 2 nodes.');
      expect(valueOf('n3')).toBe('G');
      sameAsBackend();
    });

    it('one DELETE answers 500 (no echo for it): its node stays, the undo restores only the other', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      type('n3', 'F');
      await answer('n2', 500); await answer('n1');
      expect(failure()).toMatch(/^Couldn't delete the node\./);
      expect(ids()).toEqual(['n2', 'n3']);
      net.holdDeletes = false;
      await undo();
      // The typing came after the delete landed: it is undone first.
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n1=n1'], remove: [] });
      expect(notice()).toBe('Restored the node.');
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('one DELETE answers 500 with an agent edit after the other echo, held: only the deleted node comes back', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      removeTogether('n1', 'n2'); await settle();
      await undo();
      ownSync([textNode('n2'), textNode('n3')]);
      agentSync([textNode('n2'), textNode('n3'), textNode('n4')]);
      await answer('n2', 500); await answer('n1');
      // Codex's edit landed after the delete's change: the held press is dropped.
      expect(restores()).toEqual([]);
      net.holdDeletes = false;
      await undo();
      await undo();
      expect(restores()).toEqual([{ nodes: [], remove: ['n4'] }, { nodes: ['n1=n1'], remove: [] }]);
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });
  });

  describe('L-A: an echo that empties the graph', () => {
    it('E2: delete the last node, type into it, the empty echo, Cmd+Z, the answer: it comes back as typed', async () => {
      setGraph([textNode('n1')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      type('n1', 'E');
      ownSync([]);
      expect(ids()).toEqual([]);
      await undo();
      await answer('n1');
      expect(restores()).toEqual([{ nodes: ['n1=E'], remove: [] }]);
      expect(notice()).toBe('Restored the node.');
      expect(ids()).toEqual(['n1']);
      sameAsBackend();
      backendEcho();
      expect(ids()).toEqual(['n1']);
    });

    it('E3: a frontend-only node typed into, the empty echo, Cmd+Z: the node back, the typing kept', async () => {
      setGraph([textNode('n1'), textNode('local-a')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      type('local-a', 'E');
      ownSync([textNode('local-a', 'E')]);
      await undo();
      await answer('n1');
      expect(restores()).toEqual([{ nodes: ['n1=n1'], remove: [] }]);
      expect(ids()).toEqual(['local-a', 'n1']);
      expect(valueOf('local-a')).toBe('E');
      sameAsBackend();
    });
  });

  describe('L-B: a clear supersedes only the presses issued before it', () => {
    it('C3: delete, Cmd+Z, clear, Cmd+Z: the first press goes, the second undoes the clear', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      const c = clearStep();
      await undo();
      await answer('n1');
      clearAnswers(c); await settle();
      expect(restores()).toEqual([{ nodes: ['n2=n2'], remove: [] }]);
      expect(notice()).toBe('Restored the node. 1 undo was skipped while a change was saving.');
      expect(ids()).toEqual(['n2']);
      sameAsBackend();
    });

    it('control: a press issued before the clear only is still dropped with the dropped line', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      const c = clearStep();
      await answer('n1');
      clearAnswers(c); await settle();
      expect(restores()).toEqual([]);
      expect(message() ?? notice()).toBe('Nothing was undone. Your last change was still saving.');
      expect(ids()).toEqual([]);
      sameAsBackend();
    });
  });

  describe('L-C: a step taken while a clear is on its way', () => {
    it('C5 held: clear, upload, Cmd+Z (the upload), the clear answers, the upload lands: the cleared node stays gone', async () => {
      setGraph([textNode('n1')]);
      const c = clearStep();
      const up = store().beginUndoStep();
      await undo();
      clearAnswers(c); await settle();
      ownSync([textNode('n2')]);
      act(() => { store().endUndoStep(up, { arrives: ['n2'] }); }); await settle();
      expect(restores()).toEqual([{ nodes: [], remove: ['n2'] }]);
      expect(ids()).toEqual([]);
      sameAsBackend();
    });

    it('C5b not held: the same, Cmd+Z after: the cleared node stays gone', async () => {
      setGraph([textNode('n1')]);
      const c = clearStep();
      const up = store().beginUndoStep();
      clearAnswers(c); await settle();
      ownSync([textNode('n2')]);
      act(() => { store().endUndoStep(up, { arrives: ['n2'] }); }); await settle();
      await undo();
      expect(restores()).toEqual([{ nodes: [], remove: ['n2'] }]);
      expect(ids()).toEqual([]);
      sameAsBackend();
      // The next Cmd+Z undoes the clear.
      await undo();
      expect(restores()[1]).toEqual({ nodes: ['n1=n1'], remove: [] });
      expect(ids()).toEqual(['n1']);
      sameAsBackend();
    });
  });

  describe("L-D: undoing a delete never removes a node it didn't add", () => {
    it('X1 held: a reconnect sync drops the deleted node and adds an agent node; the undo keeps it', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      plainSync([textNode('n2'), textNode('n3')]);
      await answer('n1');
      expect(restores()).toEqual([{ nodes: ['n1=n1'], remove: [] }]);
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
      backendEcho();
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
    });

    it('X1b not held: the same, Cmd+Z after the answer', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      plainSync([textNode('n2'), textNode('n3')]);
      await answer('n1');
      net.holdDeletes = false;
      await undo();
      expect(restores()).toEqual([{ nodes: ['n1=n1'], remove: [] }]);
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('redo of that undo deletes only the restored node again', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      net.holdDeletes = false;
      act(() => { store().deleteNode('n1'); }); await settle();
      plainSync([textNode('n2'), textNode('n3')]);
      await undo();
      plainSync([textNode('n1'), textNode('n2'), textNode('n3'), textNode('n4')]);
      act(() => { store().redo(); }); await settle();
      expect(restores()[1]).toEqual({ nodes: [], remove: ['n1'] });
      expect(ids()).toEqual(['n2', 'n3', 'n4']);
      sameAsBackend();
    });
  });

  describe('L-E: the echo is the truth', () => {
    it('F1: the echo took the node off, then the answer is 500: no failure line, the held Cmd+Z restores it', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      ownSync([textNode('n2')]);
      await answer('n1', 500);
      expect(failure()).toBeNull();
      expect(restores()).toEqual([{ nodes: ['n1=n1'], remove: [] }]);
      expect(notice()).toBe('Restored the node.');
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
    });

    it('F1 not held: the delete counts as done, and its undo step stays', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      ownSync([textNode('n2')]);
      await answer('n1', 500);
      expect(failure()).toBeNull();
      expect(notice()).toBe('Deleted the node.');
      net.holdDeletes = false;
      await undo();
      expect(restores()).toEqual([{ nodes: ['n1=n1'], remove: [] }]);
      sameAsBackend();
    });

    it('control: a 500 with no echo keeps the node and says so', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await answer('n1', 500);
      expect(failure()).toMatch(/^Couldn't delete the node\./);
      expect(ids()).toEqual(['n1', 'n2']);
      expect(store().undoStack.length).toBe(0);
      sameAsBackend();
    });
  });
});
