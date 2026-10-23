/**
 * Undo puts back everything a delete removed (GM - Design, 2026-10-23, item 1):
 * "Make undo complete. ... When it lands, every delete path becomes "Deleted
 * {n} nodes." / "Deleted the node." with Undo. ... If one can't be reopened,
 * the Undo notice says so: "Restored {n} nodes. 1 proposal couldn't be
 * reopened.""
 *
 * The delete's answer names what it removed (a removal record per node: the
 * pins it detached, the proposals it closed). The canvas keeps the records in
 * the undo step, and the restore that brings the nodes back names them, so
 * the backend can put the pins back and reopen the proposals that still fit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
}));
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  restoreAnswers: [] as Array<Record<string, unknown>>,
  seq: 0,
  // Second review: hold the delete answers until a test lets them land.
  hold: false,
  held: [] as Array<() => void>,
  removalExtra: {} as Record<string, unknown>,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    net.calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      net.seq += 1;
      const id = `rm_${String(net.seq).padStart(16, '0')}`;
      const response = new Response(JSON.stringify({ status: 'deleted', id: deleted[1],
        removal: { id, nodeId: deleted[1], pins: [`pin_${deleted[1]}`], proposals: ['p_shared'], ...net.removalExtra } }),
      { status: 200 });
      if (!net.hold) return response;
      return new Promise<Response>((resolve) => { net.held.push(() => resolve(response)); });
    }
    if (path === '/api/graph/restore') {
      const answer = net.restoreAnswers.shift() ?? {};
      return new Response(JSON.stringify({ status: 'restored', reattached: [], reopened: [], notReopened: [],
        pinsLeft: [], removals: [], ...answer }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';
import { StudioNotice } from '../src/components/canvas/StudioNotice';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { deletedNoticeText, notRestoredText, restoredNoticeText } from '../src/lib/deleteNotice';

const CLAUDE = { kind: 'agent', id: 'claude', name: 'Claude', color: '#d97757' };
const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };

function textNode(id: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, outputs: {}, state: 'idle' } };
}
function wire(source: string, target: string): Edge {
  return { id: `e-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'prompt', type: 'typed-edge' };
}
function sync(nodes: Node<NodeData>[], edges: Edge[], extra: Record<string, unknown> = {}) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes),
    edges: structuredClone(edges), empty: nodes.length === 0, ...extra } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const restores = () => net.calls.filter((call) => call.path === '/api/graph/restore')
  .map((call) => call.body as { action: string; nodes: Array<{ id: string }>; remove: string[]; removals?: unknown[] });
const ids = () => useGraphStore.getState().nodes.map((node) => node.id).sort();
const notice = () => useGraphStore.getState().undoNotice;

let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  net.calls.length = 0;
  net.restoreAnswers.length = 0;
  net.seq = 0;
  net.hold = false;
  net.held.length = 0;
  net.removalExtra = {};
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2')], edges: [], undoStack: [], redoStack: [],
    undoNotice: null, isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] });
});
afterEach(() => {
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
});

describe("GM's lines", () => {
  it('names one node and many', () => {
    expect(deletedNoticeText(1)).toBe('Deleted the node.');
    expect(deletedNoticeText(3)).toBe('Deleted 3 nodes.');
    expect(restoredNoticeText(1, 0)).toBe('Restored the node.');
    expect(restoredNoticeText(3, 0)).toBe('Restored 3 nodes.');
    expect(restoredNoticeText(3, 1)).toBe("Restored 3 nodes. 1 proposal couldn't be reopened.");
    expect(restoredNoticeText(1, 2)).toBe("Restored the node. 2 proposals couldn't be reopened.");
  });

  // GM, 2026-10-23: a pin whose node came back as another model is counted like proposals.
  it('counts pins that couldn\'t go back, alone and with proposals', () => {
    expect(restoredNoticeText(1, 0, 1)).toBe("Restored the node. 1 pin couldn't be re-attached.");
    expect(restoredNoticeText(2, 0, 2)).toBe("Restored 2 nodes. 2 pins couldn't be re-attached.");
    expect(restoredNoticeText(3, 2, 1)).toBe("Restored 3 nodes. 1 pin and 2 proposals couldn't be restored.");
    expect(restoredNoticeText(1, 1, 2)).toBe("Restored the node. 2 pins and 1 proposal couldn't be restored.");
    expect(notRestoredText(0, 0)).toBe('');
    expect(notRestoredText(1, 0)).toBe("1 pin couldn't be re-attached.");
    expect(notRestoredText(0, 1)).toBe("1 proposal couldn't be reopened.");
  });
});

describe('every delete path: no confirm, a notice with Undo', () => {
  it('the context menu deletes at once and offers Undo', async () => {
    useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n1', null);
    render(<ContextMenu />);
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await settle();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ids()).toEqual(['n2']);
    expect(notice()).toMatchObject({ text: 'Deleted the node.', offer: 'undo' });
  });

  it('the selection toolbar deletes at once: "Deleted 2 nodes."', async () => {
    useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2', true)] });
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Delete selected nodes'));
    await settle();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ids()).toEqual([]);
    expect(notice()?.text).toBe('Deleted 2 nodes.');
  });

  it('the Delete key no longer asks', () => {
    expect(useGraphStore.getState().allowCanvasDelete(['n1', 'n2'])).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("the notice's Undo runs the same undo as Cmd+Z, naming what the delete removed", async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    render(<CanvasUndoNotice />);
    net.restoreAnswers.push({ reattached: ['pin_n1'], reopened: ['p_shared'] });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(ids()).toEqual(['n1', 'n2']);
    await settle();
    const [body] = restores();
    expect(body.nodes.map((node) => node.id)).toEqual(['n1']);
    expect(body.removals).toEqual([{ id: 'rm_0000000000000001', nodeId: 'n1', pins: ['pin_n1'], proposals: ['p_shared'] }]);
    expect(notice()).toMatchObject({ text: 'Restored the node.', offer: 'redo' });
  });

  it("says when a proposal couldn't be reopened", async () => {
    useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2', true)] });
    useGraphStore.getState().deleteSelected();
    await settle();
    net.restoreAnswers.push({ reopened: [], notReopened: [{ id: 'p_shared', reason: 'it expired' }] });
    useGraphStore.getState().undo();
    await settle();
    expect(restores()[0].removals).toHaveLength(2);
    expect(notice()?.text).toBe("Restored 2 nodes. 1 proposal couldn't be reopened.");
  });

  it("counts a pin whose node came back as another model, and stays quiet about one deleted since", async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    net.restoreAnswers.push({ pinsLeft: [
      { id: 'pin_n1', reason: 'its node came back as another model', code: 'another-model' },
      { id: 'pin_gone', reason: 'deleted since', code: 'deleted' },
      { id: 'pin_moved', reason: 'changed since', code: 'changed' },
    ] });
    useGraphStore.getState().undo();
    await settle();
    expect(notice()?.text).toBe("Restored the node. 1 pin couldn't be re-attached.");
  });

  it('says pins and proposals together when both couldn\'t go back', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    net.restoreAnswers.push({ notReopened: [{ id: 'p_shared', reason: 'it expired' }, { id: 'p_2', reason: 'it expired' }],
      pinsLeft: [{ id: 'pin_n1', reason: 'its node came back as another model', code: 'another-model' }] });
    useGraphStore.getState().undo();
    await settle();
    expect(notice()?.text).toBe("Restored the node. 1 pin and 2 proposals couldn't be restored.");
  });

  it('never counts by the reason text: a pin left without a code is quiet', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    net.restoreAnswers.push({ pinsLeft: [{ id: 'pin_n1', reason: 'its node came back as another model' }] });
    useGraphStore.getState().undo();
    await settle();
    expect(notice()?.text).toBe('Restored the node.');
  });

  it('redo deletes again, and the next undo names the new removal', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    useGraphStore.getState().undo();
    await settle();
    net.restoreAnswers.push({ removals: [{ id: 'rm_00000000000000aa', nodeId: 'n1', pins: ['pin_n1'], proposals: [] }] });
    useGraphStore.getState().redo();
    await settle();
    expect(ids()).toEqual(['n2']);
    expect(notice()).toMatchObject({ text: 'Deleted the node.', offer: 'undo' });
    useGraphStore.getState().undo();
    await settle();
    expect(restores()[2].removals).toEqual([{ id: 'rm_00000000000000aa', nodeId: 'n1', pins: ['pin_n1'], proposals: [] }]);
  });

  it("Create Studio's result delete gets the same notice, with Undo off the canvas too", async () => {
    useGraphStore.setState({ nodes: [textNode('n1'), { ...textNode('n2'), data: { ...textNode('n2').data,
      definitionId: 'nano-banana', label: 'Nano Banana' } }], edges: [wire('n1', 'n2')] });
    useGraphStore.getState().deleteGeneration(['n2']);
    await settle();
    expect(ids()).toEqual([]);
    expect(notice()).toMatchObject({ text: 'Deleted 2 nodes.', offer: 'undo' });
    render(<StudioNotice />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});

describe("an agent's delete, undone by the person", () => {
  it('keeps the removal from the sync and names it in the restore', async () => {
    const removal = { id: 'rm_00000000000000bb', nodeId: 'n1', pins: ['pin_n1'], proposals: ['p_1'] };
    sync([textNode('n2')], [], { edit: { actor: CLAUDE, id: 'ed_0123456789abcdef', removals: [removal] } });
    expect(ids()).toEqual(['n2']);
    net.restoreAnswers.push({ reopened: [], notReopened: [{ id: 'p_1', reason: 'it expired' }] });
    useGraphStore.getState().undo();
    await settle();
    expect(restores()[0].removals).toEqual([removal]);
    expect(notice()?.text).toBe("Undid Claude’s edit. 1 proposal couldn't be reopened.");
  });

  it('counts a pin that came back on another model there too', async () => {
    const removal = { id: 'rm_00000000000000bc', nodeId: 'n1', pins: ['pin_n1'], proposals: ['p_1'] };
    sync([textNode('n2')], [], { edit: { actor: CLAUDE, id: 'ed_0123456789abcdee', removals: [removal] } });
    net.restoreAnswers.push({ notReopened: [{ id: 'p_1', reason: 'it expired' }],
      pinsLeft: [{ id: 'pin_n1', reason: 'its node came back as another model', code: 'another-model' }] });
    useGraphStore.getState().undo();
    await settle();
    expect(notice()?.text).toBe("Undid Claude’s edit. 1 pin and 1 proposal couldn't be restored.");
  });
});

describe('a node deleted again by another step', () => {
  // Review: undoing the agent's undo deleted n1 again under a new removal,
  // but only that step took it; the older step that brings n1 back still
  // named the first removal, so the pin stayed detached and the proposal closed.
  it("the agent's delete, its undo, then Cmd+Z twice names the newest removal", async () => {
    const first = { id: 'rm_00000000000000a1', nodeId: 'n1', pins: ['pin_n1'], proposals: ['p_1'] };
    // The backend's record of the delete that supersedes `first` says so (second review).
    const again = { id: 'rm_00000000000000c3', nodeId: 'n1', pins: ['pin_n1'], proposals: ['p_1'], replaces: first.id };
    sync([textNode('n2')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000e1', removals: [first] } });
    sync([textNode('n1'), textNode('n2')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000e2',
      undoes: 'ed_00000000000000e1' } });
    expect(ids()).toEqual(['n1', 'n2']);
    net.restoreAnswers.push({ removals: [again] });
    useGraphStore.getState().undo();
    await settle();
    expect(ids()).toEqual(['n2']);
    useGraphStore.getState().undo();
    await settle();
    expect(ids()).toEqual(['n1', 'n2']);
    const bodies = restores();
    expect(bodies[1].nodes.map((node) => node.id)).toEqual(['n1']);
    expect(bodies[1].removals).toEqual([again]);
  });

  it("another tab's undo then redo of this tab's delete renews this tab's step too", async () => {
    const later = { id: 'rm_00000000000000d4', nodeId: 'n1', pins: ['pin_n1'], proposals: [],
      replaces: 'rm_0000000000000001' };
    useGraphStore.getState().deleteNode('n1');
    await settle();
    const own = useGraphStore.getState().undoStack.at(-1)!;
    expect(own.removals?.[0].id).toBe('rm_0000000000000001');
    // Tab B undoes it (n1 back), then redoes it: n1 deleted again, under a new removal.
    sync([textNode('n1'), textNode('n2')], [], { edit: { actor: { kind: 'person' }, id: 'ed_00000000000000e5' } });
    sync([textNode('n2')], [], { edit: { actor: { kind: 'person' }, id: 'ed_00000000000000e6', removals: [later] } });
    expect(own.removals).toEqual([later]);
  });
});

describe('a removal record undoes one delete of one node (second review)', () => {
  // Node ids are not unique over time: an import or a clear starts the
  // backend's counter at n1 again. A record is renewed only by the delete
  // that names it in `replaces`, never by a node id alone.
  it("a pre-import step that brings back the old n1 names X's own removal", async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    const xRemoval = useGraphStore.getState().undoStack.at(-1)!.removals?.[0];
    expect(xRemoval?.id).toBe('rm_0000000000000001');
    // An agent loads a graph into the project: n1 is now Y, a different node.
    const y = { ...textNode('n1'), data: { ...textNode('n1').data, params: { value: 'Y, a different node' } } };
    sync([y], [], { graphReplaced: true, edit: { actor: CLAUDE, id: 'ed_00000000000000f1' } });
    // Cmd+Z of the import removes Y; its record replaces nothing of X's.
    net.restoreAnswers.push({ removals: [{ id: 'rm_00000000000000cc', nodeId: 'n1', pins: ['pin_Y'], proposals: ['p_on_Y'] }] });
    useGraphStore.getState().undo();
    await settle();
    expect(ids()).toEqual(['n2']);
    useGraphStore.getState().undo();
    await settle();
    const last = restores().at(-1)!;
    expect(last.nodes.map((node) => node.id)).toEqual(['n1']);
    expect(last.removals).toEqual([xRemoval]);
  });

  it('a later delete renews only the record it replaces', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    const own = useGraphStore.getState().undoStack.at(-1)!;
    const mine = own.removals![0];
    // Another tab deletes a node that is under n1 now, superseding some other removal: not this step's.
    sync([textNode('n2')], [], { edit: { actor: { kind: 'person' }, id: 'ed_00000000000000e7',
      removals: [{ id: 'rm_00000000000000e7', nodeId: 'n1', pins: [], proposals: [], replaces: 'rm_00000000000000ff' }] } });
    expect(own.removals).toEqual([mine]);
    // The delete that supersedes this step's record does renew it.
    const next = { id: 'rm_00000000000000e8', nodeId: 'n1', pins: ['pin_n1'], proposals: [], replaces: mine.id };
    sync([textNode('n2')], [], { edit: { actor: { kind: 'person' }, id: 'ed_00000000000000e8', removals: [next] } });
    expect(own.removals).toEqual([next]);
  });

  it('an undo names only the records of the model it brings back', async () => {
    net.removalExtra = { definitionId: 'nano-banana', projectId: 'prj_a' };
    useGraphStore.getState().deleteNode('n1');
    await settle();
    expect(useGraphStore.getState().undoStack.at(-1)!.removals?.[0]).toMatchObject({ definitionId: 'nano-banana' });
    useGraphStore.getState().undo();
    await settle();
    // n1 comes back as a Text Input: the record of a Nano Banana's delete isn't its.
    expect(restores()[0].removals ?? []).toEqual([]);
  });

  it("keeps a record's project, model and replaces through to the restore", async () => {
    net.removalExtra = { definitionId: 'text-input', projectId: 'prj_a', replaces: 'rm_00000000000000aa' };
    useGraphStore.getState().deleteNode('n1');
    await settle();
    useGraphStore.getState().undo();
    await settle();
    expect(restores()[0].removals).toEqual([{ id: 'rm_0000000000000001', nodeId: 'n1', pins: ['pin_n1'],
      proposals: ['p_shared'], definitionId: 'text-input', projectId: 'prj_a', replaces: 'rm_00000000000000aa' }]);
  });

  it("a delete's answer that lands after a project switch leaves the new project's steps alone", async () => {
    net.hold = true;
    useGraphStore.getState().deleteNode('n1');
    await settle();
    // Another project opens: the stacks empty, and its own history starts.
    sync([textNode('n1'), textNode('n2')], [], { graphReplaced: true });
    expect(useGraphStore.getState().undoStack).toEqual([]);
    const theirs = { id: 'rm_00000000000000b7', nodeId: 'n1', pins: ['pin_b'], proposals: [] };
    sync([textNode('n2')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000b7', removals: [theirs] } });
    const step = useGraphStore.getState().undoStack.at(-1)!;
    expect(step.removals).toEqual([theirs]);
    for (const release of net.held.splice(0)) release();
    await settle();
    expect(step.removals).toEqual([theirs]);
  });

  it("a delete's answer that lands after a project switch doesn't take the new project's node", async () => {
    net.hold = true;
    useGraphStore.getState().deleteNode('n1');
    await settle();
    sync([textNode('n1'), textNode('n2')], [], { graphReplaced: true });
    for (const release of net.held.splice(0)) release();
    await settle();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(notice()?.text).not.toBe('Deleted the node.');
  });
});
