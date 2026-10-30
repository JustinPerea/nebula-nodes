import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';
import { clearKeptCanvas, keepCanvasLocally, releaseKeptCanvas, useGraphStore } from '../src/store/graphStore';
import { clearKeptTab, resetKeptCanvasForTests, setKeptCanvasSaving, subscribeKeptPulse } from '../src/lib/keptCanvas';

/**
 * GM r18 on PR #199, Q3: a kept tab is a full scratch canvas. Moves,
 * deletes, a clear, duplicates and Arrange change only this tab (nothing is
 * sent), and Undo and Redo walk the kept tab's own steps: they start empty
 * when the canvas is kept, so Undo never steps back into the history Nebula
 * saved. Clear canvas stays live because Undo brings the kept edits back.
 */
function node(id: string, x = 0, selected = false): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 }, selected,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, outputs: {}, state: 'idle' },
  };
}
const wire = (id: string, source: string, target: string): Edge => ({ id, source, target, type: 'typed-edge' });
/** A step of the history Nebula saved, from before the canvas was kept. */
const SAVED_STEP = { nodes: [node('n1'), node('n2', 400), node('n3', 800)], edges: [], savedHistory: true } as never;

const ids = () => useGraphStore.getState().nodes.map((n) => n.id);
const values = () => useGraphStore.getState().nodes.map((n) => String(n.data.params.value));
let fetchSpy: ReturnType<typeof vi.spyOn>;
let pulses = 0;
let stopPulses: () => void = () => {};

beforeEach(() => {
  resetKeptCanvasForTests();
  useGraphStore.setState({
    nodes: [node('n1'), node('n2', 400), node('n3', 800)], edges: [wire('e1', 'n1', 'n2'), wire('e2', 'n2', 'n3')],
    isExecuting: false, undoStack: [SAVED_STEP], redoStack: [], keptUndo: [], keptRedo: [], undoNotice: null,
  });
  keepCanvasLocally();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  pulses = 0;
  const now = vi.spyOn(Date, 'now');
  let clock = 100_000;
  now.mockImplementation(() => (clock += 2000));
  stopPulses = subscribeKeptPulse(() => { pulses += 1; });
});
afterEach(() => {
  stopPulses();
  releaseKeptCanvas();
  resetKeptCanvasForTests();
  vi.restoreAllMocks();
});

/** Nothing sent, nothing refused, Nebula's saved history never stepped
 * into (its first step is still there; typing's own steps may follow it). */
function expectTabOnly() {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(pulses).toBe(0);
  expect(useGraphStore.getState().undoStack[0]).toBe(SAVED_STEP);
  expect(useGraphStore.getState().redoStack).toEqual([]);
}

describe('GM r18, Q3: delete, move and undo are the kept tab’s own', () => {
  it('Delete takes the node and its wires off this tab, with "Deleted the node." and Undo; Undo puts them back where they were', () => {
    useGraphStore.getState().deleteCanvasElements(['n2'], []);
    expect(ids()).toEqual(['n1', 'n3']);
    expect(useGraphStore.getState().edges).toEqual([]);
    expect(useGraphStore.getState().undoNotice).toMatchObject({ text: 'Deleted the node.', offer: 'undo' });
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(useGraphStore.getState().edges.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(useGraphStore.getState().undoNotice).toMatchObject({ text: 'Restored the node.', offer: 'redo' });
    useGraphStore.getState().redo();
    expect(ids()).toEqual(['n1', 'n3']);
    expectTabOnly();
  });

  it('the toolbar, the Inspector, the context menu and React Flow’s removal delete the same way', () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((n) => ({ ...n, selected: n.id !== 'n2' })) }));
    useGraphStore.getState().deleteSelected();
    expect(ids()).toEqual(['n2']);
    expect(useGraphStore.getState().undoNotice?.text).toBe('Deleted 2 nodes.');
    useGraphStore.getState().deleteNode('n2');
    expect(ids()).toEqual([]);
    useGraphStore.getState().undo();
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    useGraphStore.getState().onNodesChange([{ id: 'n3', type: 'remove' }]);
    expect(ids()).toEqual(['n1', 'n2']);
    useGraphStore.getState().onEdgesChange([{ id: 'e1', type: 'remove' }]);
    expect(useGraphStore.getState().edges.map((e) => e.id)).toEqual([]);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().edges.map((e) => e.id)).toEqual(['e1']);
    expectTabOnly();
  });

  it('a drag moves the node on this tab; its drop is one step Undo takes back', () => {
    const store = useGraphStore.getState();
    store.onNodesChange([{ id: 'n1', type: 'position', position: { x: 50, y: 10 }, dragging: true }]);
    store.onNodesChange([{ id: 'n1', type: 'position', position: { x: 120, y: 40 }, dragging: true }]);
    store.onNodesChange([{ id: 'n1', type: 'position', position: { x: 120, y: 40 }, dragging: false }]);
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 120, y: 40 });
    expect(useGraphStore.getState().keptUndo).toHaveLength(1);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 120, y: 40 });
    expectTabOnly();
  });

  it('Arrange moves the nodes on this tab, sends no layout, and Undo puts them back', () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 }, selected: true })) }));
    useGraphStore.getState().autoLayoutSelected();
    const arranged = useGraphStore.getState().nodes.map((n) => n.position);
    expect(arranged.some((p) => p.x !== 0 || p.y !== 0)).toBe(true);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes.map((n) => n.position)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pulses).toBe(0);
  });

  it('Undo takes the typing back first, then the delete (GM r19, 5: typing is a step); a duplicate is a step too', () => {
    useGraphStore.getState().deleteNode('n1');
    useGraphStore.getState().updateNodeData('n2', { params: { value: 'n2 typed after' } });
    useGraphStore.getState().undo();
    expect(values()).toEqual(['n2', 'n3']);
    useGraphStore.getState().undo();
    expect(values()).toEqual(['n1', 'n2', 'n3']);
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((n) => ({ ...n, selected: n.id === 'n3' })) }));
    useGraphStore.getState().duplicateSelected();
    expect(ids()).toHaveLength(4);
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pulses).toBe(0);
  });
});

describe('GM r18, Q3 guard: Undo never steps back into the history Nebula saved', () => {
  it('undoing past the first kept edit stops there: the canvas stays, the saved steps stay', () => {
    useGraphStore.getState().deleteNode('n3');
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'n1 typed' } });
    const saved = useGraphStore.getState().undoStack;
    useGraphStore.getState().undo(); // the typing (GM r19, 5)
    expect(values()).toEqual(['n1', 'n2']);
    useGraphStore.getState().undo(); // the first kept edit, undone
    const afterFirst = useGraphStore.getState();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    for (let press = 0; press < 3; press += 1) useGraphStore.getState().undo();
    const after = useGraphStore.getState();
    expect(after.nodes).toBe(afterFirst.nodes);
    expect(after.edges).toBe(afterFirst.edges);
    expect(after.undoStack).toBe(saved);
    expect(after.undoStack[0]).toBe(SAVED_STEP);
    expect(after.redoStack).toEqual([]);
    expect(after.keptUndo).toEqual([]);
    expect(values()).toEqual(['n1', 'n2', 'n3']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('kept again later, the kept tab’s Undo starts empty', () => {
    useGraphStore.getState().deleteNode('n3');
    releaseKeptCanvas();
    expect(useGraphStore.getState().keptUndo).toEqual([]);
    keepCanvasLocally();
    const before = useGraphStore.getState().nodes;
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toBe(before);
  });
});

describe('GM r18, Q3 guard: Clear canvas is undoable while kept', () => {
  it('a clear takes every node and wire off this tab as one step; Undo brings the kept edits back', () => {
    useGraphStore.getState().updateNodeData('n2', { params: { value: 'kept typing' } });
    expect(clearKeptCanvas()).toBe(true);
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().edges).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toBe('Deleted 3 nodes.');
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(values()).toEqual(['n1', 'kept typing', 'n3']);
    expect(useGraphStore.getState().edges.map((e) => e.id)).toEqual(['e1', 'e2']);
    expectTabOnly();
  });

  it('the bottom bar reaches it through lib/keptCanvas (clearKeptTab), with the same one step', () => {
    expect(clearKeptTab()).toBe(true);
    expect(useGraphStore.getState().nodes).toEqual([]);
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expectTabOnly();
  });

  it('while the save is on its way, every kept edit is refused with a pulse', () => {
    setKeptCanvasSaving(true);
    expect(clearKeptCanvas()).toBe(true);
    useGraphStore.getState().deleteNode('n1');
    useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'position', position: { x: 9, y: 9 }, dragging: false }]);
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(pulses).toBeGreaterThanOrEqual(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the notice’s Undo while kept', () => {
  it('acts on the kept step; a notice for a saved step shows no button while kept', () => {
    render(<CanvasUndoNotice />);
    act(() => useGraphStore.getState().deleteNode('n1'));
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).not.toBeDisabled();
    fireEvent.click(undo);
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(screen.getByRole('button', { name: 'Redo' })).not.toBeDisabled();
    act(() => useGraphStore.setState({ undoNotice: { id: 9_999, text: 'Claude changed the canvas.', offer: 'undo', entry: SAVED_STEP } }));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(useGraphStore.getState().undoStack).toEqual([SAVED_STEP]);
  });
});
