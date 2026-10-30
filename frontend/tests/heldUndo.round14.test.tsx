import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 13 (probes Q1-Q13, R1-R5), round 14. Every case checks what the
// restores sent (their bodies) and that the canvas ends where Nebula's graph
// does: a fake backend applies each delete (at its echo or its answer,
// whichever comes first), each sync (it is the backend's graph then), each
// clear and each restore, in the order they reach it.
// M-2: a held press never restores a node a delete still on its way (or
//   settled) removed. A delete's echo is when its change lands: its step is
//   placed then, and the steps taken after it lose the nodes (R1-R3); an
//   undo applied beneath another delete keeps that delete's nodes gone (R4).
// L-1: a press whose step lies under the person's own older delete, re-pushed
//   when its answer came late, still goes through (Q4).
// L-2: a held press under a clear the person issued after it is dropped: the
//   clear supersedes it (Q5).
// L-3: undoing a step taken between a delete and its echo never brings the
//   deleted node back on one side only (Q6).
// L-4: GM - Design, round 14, item 3: skipped undos and redos are counted apart (Q8).

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
import { DROPPED_REDO_TEXT, DROPPED_UNDO_TEXT, skippedPressText } from '../src/lib/deleteNotice';

const initialGraph = useGraphStore.getState();
function textNode(id: string, value = id): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 100, y: 100 }, width: 120, height: 60,
    data: { label: id, definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const backend = () => [...net.backend].sort();
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const stacks = () => ({ undo: store().undoStack.length, redo: store().redoStack.length });
const notice = () => store().undoNotice?.text ?? null;
/** GM's dropped-undo line, in either notice place. */
const dropped = () => [notice(), store().messageNotice?.text].includes(DROPPED_UNDO_TEXT);
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });
const undo = async () => { act(() => { store().undo(); }); await settle(); };
const redo = async () => { act(() => { store().redo(); }); await settle(); };
const answer = async (id: string, status = 200) => {
  const resolve = net.held.get(id);
  if (!resolve) throw new Error(`no delete of ${id} on its way`);
  net.held.delete(id);
  await act(async () => {
    resolve(status === 200 ? { status, body: { status: 'deleted', id } } : { status, body: { detail: 'It is running.' } });
  });
  await settle();
};
/** Each restore body: the nodes it brought back (id and value) and the ids it removed. */
const restores = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore')
  .map((call) => JSON.parse(call.body ?? '{}') as { nodes: Array<{ id: string; params?: { value?: string } }>; remove: string[] })
  .map((body) => ({ nodes: body.nodes.map((node) => node.id).sort(), remove: [...body.remove].sort() }));
const restoredValues = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore')
  .flatMap((call) => (JSON.parse(call.body ?? '{}').nodes ?? []) as Array<{ id: string; params?: { value?: string } }>)
  .map((node) => `${node.id}=${node.params?.value}`);
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, edges: [], ...event } as unknown as ExecutionEvent;
  act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full); });
};
/** The backend's graph reaching this tab (its own echo): it is the backend's graph now. */
const ownSync = (nodes: Node<NodeData>[]) => {
  net.backend = new Set(nodes.map((node) => node.id));
  emit({ nodes, edges: [], empty: nodes.length === 0, edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' } });
};
const agentSync = (nodes: Node<NodeData>[]) => {
  net.backend = new Set(nodes.map((node) => node.id));
  emit({ nodes, edges: [], empty: nodes.length === 0, edit: { actor: { kind: 'agent', name: 'Codex', color: '#ff00aa' }, id: 'ed_agent' } });
};
/** Nebula's graph comes back to the canvas (the last restore's echo): nothing may change. */
const backendEcho = () => ownSync(backend().map((id) => store().nodes.find((node) => node.id === id) ?? textNode(id)));
const type = (id: string, value: string) => { act(() => { store().updateNodeData(id, { params: { value } }); }); };
const clearStep = () => store().beginUndoStep({ clear: true });
/** The toolbar's clear answering: the backend cleared, then the canvas. */
const clearAnswers = (step: object) => {
  net.backend.clear();
  act(() => { store().clearGraph({ undoStep: step }); });
  act(() => { store().endUndoStep(step); });
};

describe('a held Cmd+Z, round 14 (review 13)', () => {
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
    net.backend = new Set(nodes.map((node) => node.id));
    useGraphStore.setState({ nodes, edges: [], isExecuting: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  const sameAsBackend = () => expect(ids()).toEqual(backend());

  describe("L-4: GM's skipped lines, verbatim (round 14, item 3)", () => {
    it('counts undos and redos apart, undos first, leaving out a kind with none', () => {
      expect(skippedPressText(1, 0)).toBe('1 undo was skipped while a change was saving.');
      expect(skippedPressText(2, 0)).toBe('2 undos were skipped while a change was saving.');
      expect(skippedPressText(0, 1)).toBe('1 redo was skipped while a change was saving.');
      expect(skippedPressText(0, 3)).toBe('3 redos were skipped while a change was saving.');
      expect(skippedPressText(2, 1)).toBe('2 undos and 1 redo were skipped while a change was saving.');
      expect(skippedPressText(1, 1)).toBe('1 undo and 1 redo were skipped while a change was saving.');
      expect(skippedPressText(1, 2)).toBe('1 undo and 2 redos were skipped while a change was saving.');
    });

    it('nothing went through: the undo line for undos (or both), the redo line for redos only', () => {
      expect(DROPPED_UNDO_TEXT).toBe('Nothing was undone. Your last change was still saving.');
      expect(DROPPED_REDO_TEXT).toBe('Nothing was redone. Your last change was still saving.');
    });

    it('Q8: undos and a redo held on a delete, Codex edits, the answer: all dropped with the undo line', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      type('n1', 'E1');
      act(() => { store().deleteNode('n2'); }); await settle();
      // Round 18 (GM option (c)): the node leaves the canvas at once.
      expect(ids()).toEqual(['n1']);
      await undo(); expect(dropped()).toBe(false);
      await undo(); expect(dropped()).toBe(false);
      await redo(); expect(dropped()).toBe(false);
      expect(ids()).toEqual(['n1']);
      expect(valueOf('n1')).toBe('E1');
      agentSync([textNode('n1', 'E1'), textNode('n2'), textNode('n3')]);
      await answer('n2');
      // GM r39 item 3: held, silently, until the answer. Since r18 the delete's step is placed at
      // Delete, so a step that settled above it meanwhile is newer: the bound presses are dropped with
      // GM's line when the answer lands (review 11, M-1), never applied beneath it.
      expect(dropped()).toBe(true);
      // Round 18 (GM option (c)): the sync that still showed n2 leaves it off; the presses are dropped.
      expect(notice()).not.toMatch(/skipped/);
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n1', 'n3']);
      expect(valueOf('n1')).toBe('E1');
      sameAsBackend();
      // Round 18 (GM option (c)): after the answer, presses undo Codex's edit, the delete, then the typing.
      net.holdDeletes = false;
      await undo();
      expect(ids()).toEqual(['n1']);
      sameAsBackend();
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n2'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
      await undo();
      expect(valueOf('n1')).toBe('n1');
      sameAsBackend();
    });

    it('Q7: three undos held on a delete, Codex edits, the answer: all dropped with the undo line', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      type('n1', 'E0');
      await settle(); await new Promise((r) => setTimeout(r, 1100));
      type('n1', 'E1');
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo(); await undo(); await undo();
      expect(dropped()).toBe(false);
      expect(ids()).toEqual(['n1']);
      expect(valueOf('n1')).toBe('E1');
      agentSync([textNode('n1', 'E1'), textNode('n2'), textNode('n3')]);
      await answer('n2');
      // GM r39 item 3: held, silently, until the answer. Since r18 the delete's step is placed at
      // Delete, so a step that settled above it meanwhile is newer: the bound presses are dropped with
      // GM's line when the answer lands (review 11, M-1), never applied beneath it.
      expect(dropped()).toBe(true);
      expect(notice()).not.toMatch(/skipped/);
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n1', 'n3']);
      sameAsBackend();
      // Round 18 (GM option (c)): after the answer, presses undo Codex's edit, then the delete, then each typing step.
      net.holdDeletes = false;
      await undo();
      expect(ids()).toEqual(['n1']);
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n2'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
      await undo();
      expect(valueOf('n1')).toBe('E0');
      await undo();
      expect(valueOf('n1')).toBe('n1');
      sameAsBackend();
    });
  });

  describe('M-2: an echo before the answer', () => {
    it('R1 (Q1b): two deletes, one Cmd+Z, both echoes, answers reversed: only the second delete is undone', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo();
      ownSync([textNode('n2'), textNode('n3')]);
      ownSync([textNode('n3')]);
      await answer('n2');
      await answer('n1');
      expect(restores()).toEqual([{ nodes: ['n2'], remove: [] }]);
      expect(ids()).toEqual(['n2', 'n3']);
      sameAsBackend();
      backendEcho();
      expect(ids()).toEqual(['n2', 'n3']);
      net.holdDeletes = false;
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n1'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('Q1: the same with the answers in order', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo();
      ownSync([textNode('n2'), textNode('n3')]);
      ownSync([textNode('n3')]);
      await answer('n1');
      await answer('n2');
      expect(restores()).toEqual([{ nodes: ['n2'], remove: [] }]);
      expect(ids()).toEqual(['n2', 'n3']);
      sameAsBackend();
      net.holdDeletes = false;
      await undo();
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
      expect(stacks()).toEqual({ undo: 0, redo: 2 });
    });

    it('R2: a delete in flight, a clear in flight, Cmd+Z (the clear); the delete echo, the clear answers first', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      const clear = clearStep();
      await undo();
      ownSync([textNode('n2')]);
      clearAnswers(clear); await settle();
      expect(ids()).toEqual(['n2']);
      // The restore goes out once the earlier delete answered (restores queue behind it).
      await answer('n1');
      expect(restores()).toEqual([{ nodes: ['n2'], remove: [] }]);
      expect(ids()).toEqual(['n2']);
      sameAsBackend();
    });

    it('R3: a delete in flight, an upload in flight, Cmd+Z (the upload); the delete echo, the upload lands first', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      const up = store().beginUndoStep();
      await undo();
      ownSync([textNode('n2')]);
      ownSync([textNode('n2'), textNode('n3')]);
      act(() => { store().endUndoStep(up, { arrives: ['n3'] }); }); await settle();
      expect(ids()).toEqual(['n2']);
      await answer('n1');
      expect(restores()).toEqual([{ nodes: [], remove: ['n3'] }]);
      expect(ids()).toEqual(['n2']);
      sameAsBackend();
    });

    it('R4 (H4 echo-first): delete n1, Cmd+Z, delete n2, both echoes, then the answers: n1 back, n2 gone, on both sides', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      act(() => { store().deleteNode('n2'); }); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      ownSync([textNode('n3')]);
      await answer('n1');
      expect(ids()).toEqual(['n1', 'n3']);
      await answer('n2');
      expect(restores()).toEqual([{ nodes: ['n1'], remove: [] }]);
      expect(ids()).toEqual(['n1', 'n3']);
      sameAsBackend();
      backendEcho();
      expect(ids()).toEqual(['n1', 'n3']);
      // The next Cmd+Z is not dead: it undoes the second delete.
      net.holdDeletes = false;
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n2'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('R5 (control): the second echo only after the first answer', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      act(() => { store().deleteNode('n2'); }); await settle();
      ownSync([textNode('n2'), textNode('n3')]);
      await answer('n1');
      // n1 back beneath the second delete, still on its way (n2 left at Delete, round 18).
      expect(ids()).toEqual(['n1', 'n3']);
      ownSync([textNode('n1'), textNode('n3')]);
      await answer('n2');
      expect(restores()).toEqual([{ nodes: ['n1'], remove: [] }]);
      expect(ids()).toEqual(['n1', 'n3']);
      sameAsBackend();
    });

    it('Q12: two deletes echo-first, Cmd+Z x2, an agent edit between the echoes: both presses dropped', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo(); await undo();
      expect(dropped()).toBe(false);
      expect(ids()).toEqual(['n3']);
      ownSync([textNode('n2'), textNode('n3')]);
      agentSync([textNode('n2'), textNode('n3'), textNode('n4')]);
      ownSync([textNode('n3'), textNode('n4')]);
      await answer('n1');
      await answer('n2');
      // GM r39 item 3: held, silently, until the answer. Since r18 the delete's step is placed at
      // Delete, so a step that settled above it meanwhile is newer: the bound presses are dropped with
      // GM's line when the answer lands (review 11, M-1), never applied beneath it.
      expect(dropped()).toBe(true);
      // Round 18 (GM option (c)): no press is applied late; both deletes stay.
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n3', 'n4']);
      expect(notice() ?? '').not.toMatch(/skipped/);
      sameAsBackend();
      net.holdDeletes = false;
      // Round 18 (GM option (c)): after the answers, presses undo Codex's edit, the second delete, then the first.
      await undo();
      expect(ids()).toEqual(['n3']);
      sameAsBackend();
      await undo();
      expect(ids()).toEqual(['n2', 'n3']);
      sameAsBackend();
      await undo();
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('Q2b: the echo between typing and the answer: the typing is newer, so the held press is dropped', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo();
      expect(dropped()).toBe(false);
      expect(ids()).toEqual(['n1']);
      type('n1', 'Typed');
      ownSync([textNode('n1', 'Typed')]);
      await answer('n2');
      // GM r39 item 3: held, silently, until the answer. Since r18 the delete's step is placed at
      // Delete, so a step that settled above it meanwhile is newer: the bound presses are dropped with
      // GM's line when the answer lands (review 11, M-1), never applied beneath it.
      expect(dropped()).toBe(true);
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n1']);
      expect(valueOf('n1')).toBe('Typed');
      sameAsBackend();
      // Round 18 (GM option (c)): the delete's step isn't re-pushed: the typing is newer and goes first, then the delete.
      net.holdDeletes = false;
      await undo();
      expect(restoredValues()).toEqual(['n1=n1']);
      expect(ids()).toEqual(['n1']);
      sameAsBackend();
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n2'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2']);
      expect(valueOf('n1')).toBe('n1');
      sameAsBackend();
    });

    it('Q2: the echo before the typing: the typing is newer, so the press is dropped, and both sides agree', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo();
      ownSync([textNode('n1')]);
      type('n1', 'Typed');
      await answer('n2');
      expect(notice()).toBe(DROPPED_UNDO_TEXT);
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n1']);
      sameAsBackend();
    });

    it('Q3: a delete, an upload, Cmd+Z (the upload); the delete echo and answer, then the upload', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      const up = store().beginUndoStep();
      await undo();
      ownSync([textNode('n2')]);
      await answer('n1');
      ownSync([textNode('n2'), textNode('n3')]);
      act(() => { store().endUndoStep(up, { arrives: ['n3'] }); }); await settle();
      expect(restores()).toEqual([{ nodes: [], remove: ['n3'] }]);
      expect(ids()).toEqual(['n2']);
      sameAsBackend();
      net.holdDeletes = false;
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n1'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
    });
  });

  describe('L-1: the person’s own older delete re-pushed is no newer edit', () => {
    it('Q4: delete in flight, type, upload, Cmd+Z x2, the delete answers (no echo), then the upload: both presses go through', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      type('n2', 'E');
      const up = store().beginUndoStep();
      await undo(); await undo();
      await answer('n1');
      ownSync([textNode('n2', 'E'), textNode('n3')]);
      act(() => { store().endUndoStep(up, { arrives: ['n3'] }); }); await settle();
      expect(restores()).toEqual([{ nodes: [], remove: ['n3'] }, { nodes: ['n2'], remove: [] }]);
      expect(restoredValues()).toEqual(['n2=n2']);
      expect(ids()).toEqual(['n2']);
      expect(valueOf('n2')).toBe('n2');
      expect(notice() ?? '').not.toMatch(/skipped|Nothing was/);
      sameAsBackend();
      // The delete is still one Cmd+Z away, with the old value.
      net.holdDeletes = false;
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n1'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2']);
      expect(valueOf('n2')).toBe('n2');
      sameAsBackend();
    });

    it('Q4b (control): the delete echo lands before the typing', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      ownSync([textNode('n2')]);
      type('n2', 'E');
      const up = store().beginUndoStep();
      await undo(); await undo();
      await answer('n1');
      ownSync([textNode('n2', 'E'), textNode('n3')]);
      act(() => { store().endUndoStep(up, { arrives: ['n3'] }); }); await settle();
      expect(restores()).toEqual([{ nodes: [], remove: ['n3'] }, { nodes: ['n2'], remove: [] }]);
      expect(ids()).toEqual(['n2']);
      expect(valueOf('n2')).toBe('n2');
      sameAsBackend();
    });
  });

  describe('L-2: a clear the person issued after the press supersedes it', () => {
    it('Q5: delete held + Cmd+Z, then Clear; the delete answers, then the clear: the press is dropped, the canvas ends empty', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      const clear = clearStep();
      await answer('n1');
      expect(notice()).toBe(DROPPED_UNDO_TEXT);
      expect(restores()).toEqual([]);
      sameAsBackend();
      clearAnswers(clear); await settle();
      expect(ids()).toEqual([]);
      sameAsBackend();
      net.holdDeletes = false;
      await undo();
      expect(ids()).toEqual(['n2']);
      sameAsBackend();
      await undo();
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
      expect(restores()).toEqual([{ nodes: ['n2'], remove: [] }, { nodes: ['n1'], remove: [] }]);
    });

    it('Q5b: the same, the clear answering first', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      const clear = clearStep();
      clearAnswers(clear); await settle();
      await answer('n1');
      expect(ids()).toEqual([]);
      expect(restores()).toEqual([]);
      sameAsBackend();
    });

    it('the toolbar and chat /clear mark their step as a clear', () => {
      const root = resolve(__dirname, '..');
      expect(readFileSync(resolve(root, 'src/components/panels/Toolbar.tsx'), 'utf8')).toMatch(/beginUndoStep\(\{ clear: true \}\)/);
      expect(readFileSync(resolve(root, 'src/lib/chatCanvasClear.ts'), 'utf8')).toMatch(/beginUndoStep\(\{ clear: true \}\)/);
    });
  });

  describe('L-3: a settled step between a delete and its echo', () => {
    it('Q6: type between the delete and its echo, Cmd+Z, then the answer: the canvas and Nebula agree', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n2'); }); await settle();
      type('n1', 'E');
      ownSync([textNode('n1', 'E')]);
      // Round 18 (GM option (c)): the delete's step stays where Delete was pressed, below the typing:
      // the press undoes the typing now (the delete's echo doesn't re-push it).
      await undo();
      expect(ids()).toEqual(['n1']);
      expect(valueOf('n1')).toBe('n1');
      await answer('n2');
      expect(restoredValues()).toEqual(['n1=n1']);
      expect(ids()).toEqual(['n1']);
      expect(valueOf('n1')).toBe('n1');
      sameAsBackend();
      backendEcho();
      expect(ids()).toEqual(['n1']);
      // Round 18 (GM option (c)): then the delete, with n1's value as it was then.
      net.holdDeletes = false;
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n2'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2']);
      expect(valueOf('n1')).toBe('n1');
      sameAsBackend();
    });
  });

  describe('controls (outcomes unchanged), now with canvas = backend', () => {
    it('Q9: a project switch refused while a delete is held, Codex edited: the held press is dropped', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo();
      expect(dropped()).toBe(false);
      agentSync([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().loadProjectGraph([textNode('p1')], [], []); });
      await settle();
      await answer('n2');
      // GM r39 item 3: held, silently, until the answer. Since r18 the delete's step is placed at
      // Delete, so a step that settled above it meanwhile is newer: the bound presses are dropped with
      // GM's line when the answer lands (review 11, M-1), never applied beneath it.
      expect(dropped()).toBe(true);
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n1', 'n3']);
      sameAsBackend();
      // Round 18 (GM option (c)): after the answer, presses undo Codex's edit, then the delete.
      net.holdDeletes = false;
      await undo();
      expect(ids()).toEqual(['n1']);
      sameAsBackend();
      await undo();
      expect(restores().at(-1)).toEqual({ nodes: ['n2'], remove: [] });
      expect(ids()).toEqual(['n1', 'n2']);
      sameAsBackend();
    });

    it('Q10: a refused delete: its press goes to nothing, the next undoes the edit', async () => {
      setGraph([textNode('n1'), textNode('n2')]);
      type('n1', 'E1');
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo(); await undo();
      await answer('n2', 409);
      expect(notice()).toBe("Couldn't delete the node. It is running.");
      expect(restoredValues()).toEqual(['n1=n1']);
      sameAsBackend();
    });

    it('Q11: two deletes, Cmd+Z x2, an agent edit between the answers: both presses dropped', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      act(() => { store().deleteNode('n2'); }); await settle();
      await undo(); await undo();
      expect(dropped()).toBe(false);
      expect(ids()).toEqual(['n3']);
      await answer('n1');
      agentSync([textNode('n2'), textNode('n3'), textNode('n4')]);
      await answer('n2');
      // GM r39 item 3: held, silently, until the answer. Since r18 the delete's step is placed at
      // Delete, so a step that settled above it meanwhile is newer: the bound presses are dropped with
      // GM's line when the answer lands (review 11, M-1), never applied beneath it.
      expect(dropped()).toBe(true);
      // Round 18 (GM option (c)): no press is applied late; both deletes stay.
      expect(restores()).toEqual([]);
      expect(ids()).toEqual(['n3', 'n4']);
      expect(notice() ?? '').not.toMatch(/skipped/);
      sameAsBackend();
      // Round 18 (GM option (c)): after the answers, presses undo Codex's edit, the second delete, then the first.
      net.holdDeletes = false;
      await undo();
      expect(ids()).toEqual(['n3']);
      sameAsBackend();
      await undo();
      expect(ids()).toEqual(['n2', 'n3']);
      sameAsBackend();
      await undo();
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });

    it('Q13: a redo after a held undo never brings back a node a later delete removed', async () => {
      setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
      act(() => { store().deleteNode('n1'); }); await settle();
      await undo();
      act(() => { store().deleteNode('n2'); }); await settle();
      await answer('n1');
      await answer('n2');
      expect(ids()).toEqual(['n1', 'n3']);
      sameAsBackend();
      net.holdDeletes = false;
      await redo();
      expect(ids()).toEqual(['n3']);
      sameAsBackend();
      await undo();
      await undo();
      expect(ids()).toEqual(['n1', 'n2', 'n3']);
      sameAsBackend();
    });
  });
});
