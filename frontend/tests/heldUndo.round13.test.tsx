import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 12 (probes P1-P16): a held Cmd+Z, round 13.
// M-1: a press whose own step is still on its way waits for it. The person's
//   own older delete answering first and re-pushing its step is not a newer
//   edit (P1: two deletes, one Cmd+Z undoes the second delete; P2).
// L-1: each press binds to its own step: the second press to the step below
//   the first one's. The notice says what happened: a restore's line, and
//   GM's "1 undo was skipped while a change was saving." when some presses
//   went through and some didn't (P15, P16).
// L-2: GM's dropped line shows after the person's own project switch (P5,
//   P5b) and beside the agent's change notice after an agent loads a graph
//   into the same project (P14).
// L-5: a delete's re-pushed step replaces the original: no dead Cmd+Z later
//   (P1, P11, H1).
// Round 18 (GM option (c)): a deleted node leaves the canvas at Delete; a
//   Cmd+Z that hits a delete still on its way shows the dropped line at once
//   and is never applied later; the delete's step stays where it was pushed.
//   The delete scenarios below keep their sequences with those expectations.

type Answer = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: string }>,
  held: new Map<string, (answer: Answer) => void>(),
  holdDeletes: true,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    net.calls.push({ path, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      const answer = net.holdDeletes
        ? await new Promise<Answer>((resolve) => { net.held.set(deleted[1], resolve); })
        : { status: 200, body: { status: 'deleted', id: deleted[1] } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (path === '/api/graph/restore') {
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
import { DROPPED_UNDO_TEXT, SKIPPED_UNDO_TEXT, skippedUndoText } from '../src/lib/deleteNotice';

const initialGraph = useGraphStore.getState();
function textNode(id: string, value = id): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 100, y: 100 }, width: 120, height: 60,
    data: { label: value, definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
function wire(source: string, target: string): Edge {
  return { id: `e-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'prompt', type: 'typed-edge' };
}
const store = () => useGraphStore.getState();
const ids = () => store().nodes.map((node) => node.id).sort();
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const stacks = () => ({ undo: store().undoStack.length, redo: store().redoStack.length });
const notice = () => store().undoNotice?.text ?? null;
const message = () => store().messageNotice?.text ?? null;
// Round 18 (GM option (c)): a Cmd+Z that hits a delete still on its way shows
// GM's dropped line at once (in the notice, or beside an error line).
const dropped = () => notice() === DROPPED_UNDO_TEXT || message() === DROPPED_UNDO_TEXT;
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
const restores = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore')
  .map((call) => JSON.parse(call.body ?? '{}') as { nodes: Array<{ id: string }>; remove: string[] });
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, edges: [], ...event } as unknown as ExecutionEvent;
  act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full); });
};
const ownSync = (nodes: Node<NodeData>[], edges: Edge[] = []) => emit({ nodes, edges, empty: nodes.length === 0,
  edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' } });
const agentSync = (nodes: Node<NodeData>[], edges: Edge[] = []) => emit({ nodes, edges, empty: nodes.length === 0,
  edit: { actor: { kind: 'agent', name: 'Codex', color: '#ff00aa' }, id: 'ed_agent' } });

describe('a held Cmd+Z, round 13 (review 12)', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.held.clear();
    net.holdDeletes = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    // A delete left unanswered would hold every later restore (they queue behind it).
    for (const [id, resolve] of [...net.held]) {
      net.held.delete(id);
      await act(async () => { resolve({ status: 200, body: { status: 'deleted', id } }); });
    }
    await settle();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const setGraph = (nodes: Node<NodeData>[], edges: Edge[] = []) => useGraphStore.setState({ nodes, edges, isExecuting: false,
    undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [] } as never);

  it("GM's mixed-batch words, verbatim (round 13)", () => {
    expect(skippedUndoText(1)).toBe('1 undo was skipped while a change was saving.');
    expect(skippedUndoText(2)).toBe('2 undos were skipped while a change was saving.');
    expect(SKIPPED_UNDO_TEXT).toBe(skippedUndoText(1));
  });

  it('P1 two quick deletes, one Cmd+Z, answers in order: the second delete is undone; no dead presses after', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    act(() => { store().deleteNode('n2'); }); await settle();
    // Round 18 (GM option (c)): both nodes left at Delete.
    expect(ids()).toEqual(['n3']);
    await undo();
    // GM r39 item 3: the press waits for n2's delete, silently.
    expect(dropped()).toBe(false);
    await answer('n1');
    // n1's delete went through; the press still waits for n2's.
    expect(ids()).toEqual(['n3']);
    expect(notice()).not.toBe(DROPPED_UNDO_TEXT);
    await answer('n2');
    expect(ids()).toEqual(['n2', 'n3']);
    expect(stacks()).toEqual({ undo: 1, redo: 1 });
    expect(notice()).toBe('Restored the node.');
    expect(restores().map((body) => body.nodes.map((node) => node.id))).toEqual([['n2']]);
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
    // L-5: no phantom step left to cost a dead Cmd+Z.
    net.calls.length = 0;
    await undo();
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
    expect(restores()).toHaveLength(0);
  });

  it('P1, answers in reverse order: the second delete is undone too', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    // GM r39 item 3: held, silently.
    expect(dropped()).toBe(false);
    await answer('n2');
    // The held press restores n2 at once; n1 left at Delete (round 18) and is still on its way.
    expect(ids()).toEqual(['n2', 'n3']);
    await answer('n1');
    expect(ids()).toEqual(['n2', 'n3']);
    expect(stacks()).toEqual({ undo: 1, redo: 1 });
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
  });

  it('P2 a delete in flight, then an upload in flight, Cmd+Z (the upload), the delete answers first: the upload is undone', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    const up = store().beginUndoStep();
    await undo();
    await answer('n1');
    expect(ids()).toEqual(['n2']);
    expect(notice()).not.toBe(DROPPED_UNDO_TEXT);
    ownSync([textNode('n2'), textNode('n3')]);
    act(() => { store().endUndoStep(up, { arrives: ['n3'] }); }); await settle();
    // The upload is undone, and n1 stays deleted.
    expect(ids()).toEqual(['n2']);
    expect(stacks()).toEqual({ undo: 1, redo: 1 });
    expect(restores().at(-1)?.remove).toEqual(['n3']);
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('P3 redo symmetry: delete held, Cmd+Z then Cmd+Shift+Z held, then the answer: deleted again, nothing stray', async () => {
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    await redo();
    await answer('n2');
    expect(ids()).toEqual(['n1']);
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    expect(notice()).not.toBe(DROPPED_UNDO_TEXT);
  });

  it('P4 an upload then a delete in flight, Cmd+Z twice; the delete answers, then the upload: both undone', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    const up = store().beginUndoStep();
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo(); await undo();
    await answer('n1');
    expect(ids()).toEqual(['n1', 'n2']);
    act(() => { store().endUndoStep(up, { arrives: ['n3'] }); }); await settle();
    ownSync([textNode('n1'), textNode('n2'), textNode('n3')]);
    await settle();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
    expect(notice()).not.toBe(DROPPED_UNDO_TEXT);
  });

  it('P4b an upload then a delete in flight, Cmd+Z twice; the upload lands first: the first press undoes only the delete', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    const up = store().beginUndoStep();
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo(); await undo();
    ownSync([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().endUndoStep(up, { arrives: ['n3'] }); }); await settle();
    await answer('n1');
    // Undoing the delete brings n1 back and never takes the upload's n3 with it.
    expect(restores()[0]).toMatchObject({ remove: [] });
    expect(restores()[0].nodes.map((node) => node.id)).toEqual(['n1']);
    expect(ids()).toEqual(['n1', 'n2']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
    net.calls.length = 0;
    await redo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
  });

  it("P5 an upload held + Cmd+Z, then the person opens another project: GM's line shows on the new canvas", async () => {
    setGraph([textNode('n1')]);
    store().beginUndoStep();
    await undo();
    let loaded: boolean | undefined;
    act(() => { loaded = store().loadProjectGraph([textNode('n1')], [], []); });
    await settle();
    expect(loaded).toBe(true);
    expect(notice()).toBe(DROPPED_UNDO_TEXT);
  });

  it("P5b an upload held + Cmd+Z, then Load graph: GM's line shows", async () => {
    setGraph([textNode('n1')]);
    store().beginUndoStep();
    await undo();
    act(() => { store().loadGraph([textNode('n1')], []); });
    await settle();
    expect(notice()).toBe(DROPPED_UNDO_TEXT);
  });

  it("P14 an agent loads a graph into this project while a delete is held: the held press is dropped with GM's line", async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    // GM r39 item 3: the press waits, silently; n2 left at Delete (round 18).
    expect(dropped()).toBe(false);
    expect(ids()).toEqual(['n1']);
    emit({ nodes: [textNode('n1')], empty: false, graphReplaced: true,
      edit: { actor: { kind: 'agent', name: 'Codex', color: '#ff00aa' }, id: 'ed_load' } });
    // Round 18: n2 already left at Delete, so Codex's load changes nothing on the canvas (no Codex
    // step or notice). The load drops the held press (L-4), and GM's line says so.
    expect(store().undoNotice?.offer ?? null).toBeNull();
    expect(dropped()).toBe(true);
    await answer('n2');
    // The dropped press is never applied by the late answer.
    expect(dropped()).toBe(true);
    expect(ids()).toEqual(['n1']);
    expect(restores()).toHaveLength(0);
    // Once it lands, a new Cmd+Z undoes the delete.
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
  });

  it('P14b an agent loads an empty graph into this project while a delete is held: both show', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    emit({ nodes: [], empty: true, graphReplaced: true,
      edit: { actor: { kind: 'agent', name: 'Codex', color: '#ff00aa' }, id: 'ed_load' } });
    expect(notice()).toMatch(/Codex/);
    expect(message()).toBe(DROPPED_UNDO_TEXT);
  });

  it("P6 Clear canvas held: own echo, an agent adds n1, the answer: dropped with GM's line; two presses restore", async () => {
    setGraph([textNode('n1', 'Hero'), textNode('n2')], [wire('n1', 'n2')]);
    const step = store().beginUndoStep();
    await undo();
    ownSync([]);
    agentSync([textNode('n1', 'agent')]);
    act(() => { store().clearGraph({ undoStep: step }); });
    act(() => { store().endUndoStep(step); }); await settle();
    expect(ids()).toEqual(['n1']);
    expect(valueOf('n1')).toBe('agent');
    expect(notice() === DROPPED_UNDO_TEXT || message() === DROPPED_UNDO_TEXT).toBe(true);
    await undo();
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(valueOf('n1')).toBe('Hero');
  });

  it('P8 a second clear while the first is in flight: the press waits for its own clear, then the first is undone next', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    const a = store().beginUndoStep();
    ownSync([]);
    const b = store().beginUndoStep();
    await undo();
    act(() => { store().clearGraph({ undoStep: a }); }); act(() => { store().endUndoStep(a); }); await settle();
    expect(notice()).not.toBe(DROPPED_UNDO_TEXT);
    act(() => { store().clearGraph({ undoStep: b }); }); act(() => { store().endUndoStep(b); }); await settle();
    // Review 15, L-2 (round 16): the second clear changed nothing (the canvas
    // was already empty), so its step goes and the press undoes the first.
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(ids()).toEqual(['n1', 'n2']);
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('P9 an upload answered, its echo never comes: dropped at 15 s, and the next press is not held', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setGraph([textNode('n1')]);
    const up = store().beginUndoStep();
    act(() => { store().undo(); });
    act(() => { store().endUndoStep(up, { arrives: ['n9'] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(notice()).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(notice()).toBe(DROPPED_UNDO_TEXT);
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    // Review 15, L-2 (round 16): its node never came, so the step changed
    // nothing and is dropped rather than taking the press silently.
    expect(stacks()).toEqual({ undo: 0, redo: 0 });
  });

  it('P10 a configure held behind a failed request: its press goes to nothing, the next press undoes the edit below', async () => {
    setGraph([textNode('n1')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'E1' } }); });
    const step = store().beginUndoStep();
    await undo(); await undo();
    act(() => { store().cancelUndoStep(step); }); act(() => { store().endUndoStep(step); }); await settle();
    expect(valueOf('n1')).toBe('n1');
    expect(notice()).not.toBe(DROPPED_UNDO_TEXT);
    expect(message()).not.toBe(DROPPED_UNDO_TEXT);
  });

  it('P11 delete held, the person types, then the answer: the press is dropped under the typing; the typing, then the delete, undo in turn', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    // GM r39 item 3: held, silently.
    expect(dropped()).toBe(false);
    act(() => { store().updateNodeData('n1', { params: { value: 'Typed' } }); });
    await answer('n2');
    // Since r18 the delete's step is placed at Delete, so a step that settles above it
    // while it is on its way is newer: the bound press is dropped with GM's line when
    // the answer lands (review 11, M-1), never applied beneath it.
    expect(dropped()).toBe(true);
    expect(ids()).toEqual(['n1']);
    expect(valueOf('n1')).toBe('Typed');
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    expect(restores()).toHaveLength(0);
    net.holdDeletes = false;
    await undo();
    // Cmd+Z undoes the typing first, then the delete; no phantom step.
    expect(valueOf('n1')).toBe('n1');
    expect(ids()).toEqual(['n1']);
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
  });

  it("P12 delete held, own echo removes the node, an agent adds n3, the answer: dropped with GM's line", async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    ownSync([textNode('n1')]);
    agentSync([textNode('n1'), textNode('n3')]);
    await answer('n2');
    expect(ids()).toEqual(['n1', 'n3']);
    expect(notice() === DROPPED_UNDO_TEXT || message() === DROPPED_UNDO_TEXT).toBe(true);
    net.holdDeletes = false;
    await undo(); await undo();
    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('P13 delete held + Cmd+Z, own echo then the answer: undone', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    ownSync([textNode('n1')]);
    await answer('n2');
    expect(ids()).toEqual(['n1', 'n2']);
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
  });

  it("P15 delete held, Cmd+Z, an agent adds n3, Cmd+Z, the answer: both held presses are dropped under Codex's edit with GM's line", async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'E1' } }); });
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    // GM r39 item 3: held, silently.
    expect(dropped()).toBe(false);
    agentSync([textNode('n1', 'E1'), textNode('n2'), textNode('n3')]);
    // Round 18: Codex's sync still shows n2 while its delete is on its way; it stays off.
    expect(ids()).toEqual(['n1', 'n3']);
    await undo();
    // Held behind the first, bound to E1 below the delete; nothing changes yet.
    expect(ids()).toEqual(['n1', 'n3']);
    expect(dropped()).toBe(false);
    await answer('n2');
    // Since r18 the delete's step is placed at Delete, so a step that settles above it
    // while it is on its way is newer: the bound press is dropped with GM's line when
    // the answer lands (review 11, M-1), never applied beneath it.
    // None went through: the plain line, no skipped count; Codex's edit and E1 are untouched.
    expect(dropped()).toBe(true);
    expect(`${notice()} ${message()}`).not.toMatch(/skipped/);
    expect(ids()).toEqual(['n1', 'n3']);
    expect(valueOf('n1')).toBe('E1');
    expect(restores()).toHaveLength(0);
    expect(stacks()).toEqual({ undo: 3, redo: 0 });
    // After it lands, Cmd+Z undoes Codex's n3, the delete, then E1.
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1']);
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(notice()).toBe('Restored the node.');
    expect(store().undoNotice?.offer).toBe('redo');
    await undo();
    expect(valueOf('n1')).toBe('n1');
    expect(stacks()).toEqual({ undo: 0, redo: 3 });
  });

  it('P16 delete held, Cmd+Z twice, an agent adds n3, the answer: the same', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'E1' } }); });
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo(); await undo();
    // GM r39 item 3: both held, silently.
    expect(dropped()).toBe(false);
    expect(valueOf('n1')).toBe('E1');
    agentSync([textNode('n1', 'E1'), textNode('n2'), textNode('n3')]);
    await answer('n2');
    // Since r18 the delete's step is placed at Delete, so a step that settles above it
    // while it is on its way is newer: the bound press is dropped with GM's line when
    // the answer lands (review 11, M-1), never applied beneath it.
    expect(dropped()).toBe(true);
    expect(`${notice()} ${message()}`).not.toMatch(/skipped/);
    expect(ids()).toEqual(['n1', 'n3']);
    expect(valueOf('n1')).toBe('E1');
    expect(restores()).toHaveLength(0);
    expect(stacks()).toEqual({ undo: 3, redo: 0 });
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1']);
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().undoNotice?.offer).toBe('redo');
    await undo();
    expect(valueOf('n1')).toBe('n1');
    expect(stacks()).toEqual({ undo: 0, redo: 3 });
  });

  it('two presses both skipped, none applied: the plain dropped line', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'E1' } }); });
    act(() => { store().deleteNode('n2'); }); await settle();
    // Its own echo took n2 off first: the answer has nothing left to re-push.
    ownSync([textNode('n1', 'E1')]);
    await undo(); await undo();
    agentSync([textNode('n1', 'E1'), textNode('n3')]);
    await answer('n2');
    expect(notice() === DROPPED_UNDO_TEXT || message() === DROPPED_UNDO_TEXT).toBe(true);
    expect(`${notice()} ${message()}`).not.toMatch(/skipped/);
    expect(valueOf('n1')).toBe('E1');
  });

  it('three presses held on a delete, Codex edits between them: all three are dropped with the plain line', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    // Two steps of their own (two nodes), then the delete.
    act(() => { store().updateNodeData('n1', { params: { value: 'E1' } }); });
    act(() => { store().updateNodeData('n3', { params: { value: 'E3' } }); });
    act(() => { store().deleteNode('n2'); }); await settle();
    expect(stacks()).toEqual({ undo: 3, redo: 0 });
    await undo();
    // GM r39 item 3: held, silently.
    expect(dropped()).toBe(false);
    agentSync([textNode('n1', 'E1'), textNode('n2'), textNode('n3', 'E3'), textNode('n7')]);
    expect(ids()).toEqual(['n1', 'n3', 'n7']);
    await undo(); await undo();
    // Held behind the first: nothing changes yet.
    expect(ids()).toEqual(['n1', 'n3', 'n7']);
    expect(dropped()).toBe(false);
    await answer('n2');
    // Since r18 the delete's step is placed at Delete, so a step that settles above it
    // while it is on its way is newer: the bound press is dropped with GM's line when
    // the answer lands (review 11, M-1), never applied beneath it.
    expect(dropped()).toBe(true);
    expect(`${notice()} ${message()}`).not.toMatch(/skipped/);
    expect(ids()).toEqual(['n1', 'n3', 'n7']);
    expect(valueOf('n1')).toBe('E1');
    expect(valueOf('n3')).toBe('E3');
    expect(stacks()).toEqual({ undo: 4, redo: 0 });
    // After it lands: Codex's n7, the delete, E3, then E1.
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1', 'n3']);
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    await undo();
    expect(valueOf('n3')).toBe('n3');
    await undo();
    expect(valueOf('n1')).toBe('n1');
    expect(stacks()).toEqual({ undo: 0, redo: 4 });
  });

  it('H1 (L-5) a delete answered after an agent edit: the held press is dropped; Codex\'s edit, then the delete, undo in turn with no phantom step', async () => {
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    // GM r39 item 3: held, silently.
    expect(dropped()).toBe(false);
    agentSync([textNode('n1'), textNode('n2'), textNode('n3')], [wire('n1', 'n2')]);
    await answer('n2');
    // Since r18 the delete's step is placed at Delete, so a step that settles above it
    // while it is on its way is newer: the bound press is dropped with GM's line when
    // the answer lands (review 11, M-1), never applied beneath it.
    expect(dropped()).toBe(true);
    // Round 18: n2 and its wire stay off (its delete was on its way during Codex's sync).
    expect(ids()).toEqual(['n1', 'n3']);
    expect(store().edges).toEqual([]);
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    net.holdDeletes = false;
    net.calls.length = 0;
    await undo();
    expect(ids()).toEqual(['n1']);
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().edges.map((edge) => edge.id)).toEqual(['e-n1-n2']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
  });

  it('(L-5) a delete answered under newer steps keeps what it removed on its re-pushed step', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); }); await settle();
    act(() => { store().updateNodeData('n1', { params: { value: 'Typed' } }); });
    const resolve = net.held.get('n2')!;
    net.held.delete('n2');
    await act(async () => {
      resolve({ status: 200, body: { status: 'deleted', id: 'n2',
        removal: { id: 'rm_00000000000000a1', nodeId: 'n2', pins: [], proposals: [] } } });
    });
    await settle();
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    // Round 18 (GM option (c)): the delete's step is not re-pushed; it stays below the typing and keeps the removal.
    const deleteStep = store().undoStack[0] as { removals?: Array<{ id: string }> };
    expect(deleteStep.removals?.map((record) => record.id)).toEqual(['rm_00000000000000a1']);
  });
  // Review 12 probe H4, re-run in round 13: delete, Cmd+Z, delete again before
  // the first answer. Round 18 (GM option (c)): the press hits the first delete
  // on its way and is dropped at once; nothing is applied beneath the second
  // delete later. Once both land, each Cmd+Z undoes one delete, newest first.
  it('H4 delete, Cmd+Z, delete again before the first answer: the first delete is undone beneath the second', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo();
    act(() => { store().deleteNode('n3'); }); await settle();
    // Round 18: n3 left at its Delete; GM r39 item 3: the press waits silently.
    expect(dropped()).toBe(false);
    await answer('n1');
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().edges.map((edge) => edge.id)).toEqual(['e-n1-n2']);
    expect(notice()).not.toBe(DROPPED_UNDO_TEXT);
    // The second delete's step stays, and holds n1 now.
    expect(stacks()).toEqual({ undo: 1, redo: 1 });
    // The restore queues behind the delete still on its way. That delete's
    // answer is the newer event, so its line is the one showing (a restore's
    // line never covers a newer notice: withLiveNotice).
    await answer('n3');
    expect(ids()).toEqual(['n1', 'n2']);
    expect(stacks()).toEqual({ undo: 1, redo: 1 });
    expect(restores().map((body) => body.nodes.map((node) => node.id))).toEqual([['n1']]);
    expect(notice()).toBe('Deleted the node.');
    expect(store().undoNotice?.offer).toBe('undo');
    net.holdDeletes = false;
    // Undoing the second delete brings n3 back and keeps n1 (no phantom).
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
  });

  it('H4 (redo) the restore\'s redo deletes n1 again and never brings back the second delete\'s node', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo();
    act(() => { store().deleteNode('n3'); }); await settle();
    await answer('n1');
    await answer('n3');
    expect(ids()).toEqual(['n1', 'n2']);
    net.holdDeletes = false;
    await redo();
    expect(ids()).toEqual(['n2']);
  });

  it('H4b delete, Cmd+Z, delete, Cmd+Z: each press undoes its own delete', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo();
    act(() => { store().deleteNode('n3'); }); await settle();
    await undo();
    expect(dropped()).toBe(false);
    await answer('n1');
    // n1 back beneath the second delete, still on its way (n3 left at Delete, round 18).
    expect(ids()).toEqual(['n1', 'n2']);
    await answer('n3');
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
    expect(notice()).toBe('Restored the node.');
    expect(message()).toBeNull();
  });

  it('H4c the same, answers reversed: each press still undoes its own delete', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo();
    act(() => { store().deleteNode('n3'); }); await settle();
    await undo();
    expect(dropped()).toBe(false);
    await answer('n3');
    // The presses run in order: the first waits for n1's delete, so nothing yet (both nodes left at Delete, round 18).
    expect(ids()).toEqual(['n2']);
    await answer('n1');
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
    expect(notice()).toBe('Restored the node.');
  });
  // Found in the round 13 live check: the backend's own echo of a delete can
  // come before its HTTP answer. Round 18 (GM option (c)): the delete's step
  // stays where it was pushed (below Codex's), and the presses made while it
  // was on its way are dropped at once.
  it('P16 echo first: the delete\'s echo lands after Codex\'s node, then the answer: both held presses are dropped', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'E1' } }); });
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo(); await undo();
    // GM r39 item 3: both held, silently.
    expect(dropped()).toBe(false);
    expect(valueOf('n1')).toBe('E1');
    agentSync([textNode('n1', 'E1'), textNode('n2'), textNode('n3')]);
    ownSync([textNode('n1', 'E1'), textNode('n3')]);
    expect(ids()).toEqual(['n1', 'n3']);
    await answer('n2');
    // Since r18 the delete's step is placed at Delete, so a step that settles above it
    // while it is on its way is newer: the bound press is dropped with GM's line when
    // the answer lands (review 11, M-1), never applied beneath it.
    expect(dropped()).toBe(true);
    expect(ids()).toEqual(['n1', 'n3']);
    expect(valueOf('n1')).toBe('E1');
    expect(`${notice()} ${message()}`).not.toMatch(/skipped/);
    expect(restores()).toHaveLength(0);
    // No phantom: Codex's edit, then the delete, then the person's E1, then nothing.
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1']);
    await undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(store().undoNotice?.offer).toBe('redo');
    expect(restores().at(-1)?.nodes.map((node) => node.id)).toEqual(['n2']);
    await undo();
    expect(valueOf('n1')).toBe('n1');
    expect(stacks().undo).toBe(0);
  });

  it('P16 echo first, before Codex\'s node: the delete is older, both presses are skipped', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'E1' } }); });
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo(); await undo();
    ownSync([textNode('n1', 'E1')]);
    agentSync([textNode('n1', 'E1'), textNode('n3')]);
    await answer('n2');
    expect(ids()).toEqual(['n1', 'n3']);
    expect(notice() === DROPPED_UNDO_TEXT || message() === DROPPED_UNDO_TEXT).toBe(true);
  });
  it('P1 and H4 with each echo before its answer (as the live app has them): the same outcomes', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    act(() => { store().deleteNode('n2'); }); await settle();
    await undo();
    ownSync([textNode('n2'), textNode('n3')]);
    ownSync([textNode('n3')]);
    await answer('n1');
    await answer('n2');
    expect(ids()).toEqual(['n2', 'n3']);
    expect(stacks()).toEqual({ undo: 1, redo: 1 });
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(stacks()).toEqual({ undo: 0, redo: 2 });

    net.holdDeletes = true;
    setGraph([textNode('n1'), textNode('n2'), textNode('n3')]);
    act(() => { store().deleteNode('n1'); }); await settle();
    await undo();
    act(() => { store().deleteNode('n3'); }); await settle();
    ownSync([textNode('n2'), textNode('n3')]);
    await answer('n1');
    expect(ids()).toEqual(['n1', 'n2']);
    ownSync([textNode('n1'), textNode('n2')]);
    await answer('n3');
    expect(ids()).toEqual(['n1', 'n2']);
    expect(stacks()).toEqual({ undo: 1, redo: 1 });
    net.holdDeletes = false;
    await undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
  });
});
