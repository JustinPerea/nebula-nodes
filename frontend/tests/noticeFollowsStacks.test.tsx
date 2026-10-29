/**
 * A notice whose Undo or Redo no longer applies clears when a new undo step
 * lands (GM - Design, 2026-10-23: "The stale-notice fix is approved as you
 * describe it: a notice whose button no longer applies clears when a new
 * undo step lands").
 *
 * The bug: after Cmd+Z of a delete, the canvas says "Restored the node." with
 * Redo. A quick delete of another node takes its undo step before it asks the
 * backend (the step clears the redo stack), so the old line stayed up with its
 * Redo hidden until "Deleted the node." arrived. The rule: a notice with an
 * offer shows only while its step is the top of its stack (undoStack for
 * Undo, redoStack for Redo), enforced once in the store for every writer of
 * either stack, and a late restore answer never brings it back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
}));
const net = vi.hoisted(() => ({
  restoreAnswers: [] as Array<Record<string, unknown>>,
  seq: 0,
  // Hold the delete answers (or the restore answers) until a test lets them land.
  holdDeletes: false,
  heldDeletes: [] as Array<() => void>,
  holdRestores: false,
  heldRestores: [] as Array<() => void>,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      net.seq += 1;
      const id = `rm_${String(net.seq).padStart(16, '0')}`;
      const response = new Response(JSON.stringify({ status: 'deleted', id: deleted[1],
        removal: { id, nodeId: deleted[1], pins: [], proposals: ['p_shared'] } }), { status: 200 });
      if (!net.holdDeletes) return response;
      return new Promise<Response>((resolve) => { net.heldDeletes.push(() => resolve(response)); });
    }
    if (path === '/api/graph/restore') {
      const answer = net.restoreAnswers.shift() ?? {};
      const response = new Response(JSON.stringify({ status: 'restored', reattached: [], reopened: [], notReopened: [],
        pinsLeft: [], removals: [], ...answer }), { status: 200 });
      if (!net.holdRestores) return response;
      return new Promise<Response>((resolve) => { net.heldRestores.push(() => resolve(response)); });
    }
    return new Response('{}', { status: 200 });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';

const CLAUDE = { kind: 'agent', id: 'claude-code', name: 'Claude Code', color: '#d97757' };
const initialGraph = { ...useGraphStore.getState() };

function textNode(id: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, outputs: {}, state: 'idle' } };
}
function sync(nodes: Node<NodeData>[], edges: Edge[], extra: Record<string, unknown> = {}) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes),
    edges: structuredClone(edges), empty: nodes.length === 0, ...extra } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const notice = () => useGraphStore.getState().undoNotice;
const top = (stack: 'undoStack' | 'redoStack') => useGraphStore.getState()[stack].at(-1);
/** The person's own step: a param edit in the Inspector. */
const ownStep = () => useGraphStore.getState().beginUndoStep();

beforeEach(() => {
  net.restoreAnswers.length = 0;
  net.seq = 0;
  net.holdDeletes = false;
  net.heldDeletes.length = 0;
  net.holdRestores = false;
  net.heldRestores.length = 0;
  useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2')], edges: [], undoStack: [], redoStack: [],
    undoNotice: null, isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] });
});
afterEach(async () => {
  cleanup();
  // A test that failed midway leaves answers held; undo and redo queue behind them.
  net.holdDeletes = false;
  net.holdRestores = false;
  for (const release of [...net.heldDeletes.splice(0), ...net.heldRestores.splice(0)]) release();
  await settle();
  useGraphStore.setState(initialGraph, true);
});

describe('a notice whose button no longer applies', () => {
  it('restore, then a quick delete: clears the moment the delete takes its step, then says "Deleted the node." with Undo', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    useGraphStore.getState().undo();
    await settle();
    expect(notice()).toMatchObject({ text: 'Restored the node.', offer: 'redo' });
    net.holdDeletes = true;
    useGraphStore.getState().deleteNode('n2');
    // The DELETE is still on its way; the step that holds it has landed.
    expect(net.heldDeletes).toHaveLength(1);
    expect(useGraphStore.getState().redoStack).toEqual([]);
    expect(notice()).toBeNull();
    for (const release of net.heldDeletes.splice(0)) release();
    await settle();
    expect(notice()).toMatchObject({ text: 'Deleted the node.', offer: 'undo' });
    expect(notice()?.entry).toBe(top('undoStack'));
  });

  it("an agent's edit notice with Undo, then the person's own step: it clears", () => {
    sync([textNode('n1'), textNode('n2'), textNode('n3')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000a1' } });
    expect(notice()).toMatchObject({ offer: 'undo' });
    expect(notice()?.text).toMatch(/Claude Code/);
    ownStep();
    expect(notice()).toBeNull();
  });

  it('"Undid Claude Code’s edit." with Redo, then a new step: it clears', async () => {
    sync([textNode('n1'), textNode('n2'), textNode('n3')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000a2' } });
    useGraphStore.getState().undo();
    await settle();
    expect(notice()).toMatchObject({ offer: 'redo' });
    expect(notice()?.text).toMatch(/^Undid Claude Code/);
    ownStep();
    expect(notice()).toBeNull();
  });

  it('a step that empties the stacks (a graph replaced, not an edit) clears an offer too', () => {
    sync([textNode('n1'), textNode('n2'), textNode('n3')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000a3' } });
    expect(notice()).toMatchObject({ offer: 'undo' });
    sync([textNode('n9')], [], { graphReplaced: true });
    expect(useGraphStore.getState().undoStack).toEqual([]);
    expect(notice()).toBeNull();
  });

  it('a notify error, then a new step: it stays', () => {
    useGraphStore.getState().notify("Couldn't save the graph. Try again.");
    const shown = notice();
    expect(shown).toMatchObject({ offer: null, tone: 'error' });
    ownStep();
    expect(notice()).toBe(shown);
  });

  it('a late restore answer after a new step brings nothing back', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    net.holdRestores = true;
    net.restoreAnswers.push({ notReopened: [{ id: 'p_shared', reason: 'it expired' }] });
    useGraphStore.getState().undo();
    await settle();
    // The restored line waits for the backend's answer (it counts the proposals).
    expect(net.heldRestores).toHaveLength(1);
    ownStep();
    expect(notice()).toBeNull();
    for (const release of net.heldRestores.splice(0)) release();
    await settle();
    expect(notice()).toBeNull();
  });

  it('without a new step, the late answer still says what couldn\'t be reopened, with Redo', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    net.holdRestores = true;
    net.restoreAnswers.push({ notReopened: [{ id: 'p_shared', reason: 'it expired' }] });
    useGraphStore.getState().undo();
    await settle();
    for (const release of net.heldRestores.splice(0)) release();
    await settle();
    expect(notice()).toMatchObject({ text: "Restored the node. 1 proposal couldn't be reopened.", offer: 'redo' });
    expect(notice()?.entry).toBe(top('redoStack'));
  });

  it('undo, redo, undo: each shows its own notice and button', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    useGraphStore.getState().undo();
    await settle();
    expect(notice()).toMatchObject({ text: 'Restored the node.', offer: 'redo' });
    expect(notice()?.entry).toBe(top('redoStack'));
    useGraphStore.getState().redo();
    await settle();
    expect(notice()).toMatchObject({ text: 'Deleted the node.', offer: 'undo' });
    expect(notice()?.entry).toBe(top('undoStack'));
    useGraphStore.getState().undo();
    await settle();
    expect(notice()).toMatchObject({ text: 'Restored the node.', offer: 'redo' });
    expect(notice()?.entry).toBe(top('redoStack'));
  });

  it("an agent's undo answer appends to its own notice only while that notice is up", async () => {
    sync([textNode('n2')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000a4',
      removals: [{ id: 'rm_00000000000000a4', nodeId: 'n1', pins: [], proposals: ['p_1'] }] } });
    net.holdRestores = true;
    net.restoreAnswers.push({ notReopened: [{ id: 'p_1', reason: 'it expired' }] });
    useGraphStore.getState().undo();
    await settle();
    expect(notice()?.text).toBe('Undid Claude Code’s edit.');
    ownStep();
    expect(notice()).toBeNull();
    for (const release of net.heldRestores.splice(0)) release();
    await settle();
    expect(notice()).toBeNull();
  });

  it('the notice renders nothing once a new step lands', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    useGraphStore.getState().undo();
    await settle();
    render(<CanvasUndoNotice />);
    expect(screen.getByText('Restored the node.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument();
    act(() => { ownStep(); });
    expect(screen.queryByText('Restored the node.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
