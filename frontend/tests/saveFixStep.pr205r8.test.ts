import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { saveStepToFit, undosToFitSave, type SaveUndoWalk, type UndoWalkStep } from '../src/lib/saveFixStep';
import { assertGraphComplexityWithinLimits, saveShapeLine, serializeGraph, measureShape, GRAPH_MAX_VALUES } from '../src/lib/graphFileShared';

// GM PR #205 r16 item 1 (review 7 limits MEDIUM-4): Save names the Undo that
// brings the canvas back within its limits, not the newest step. The top step
// alone: its owner (the three endings). More: "Undo the last N changes". None
// does: the first sentence only.

const nested = (levels: number): unknown => (levels === 0 ? 'leaf' : { next: nested(levels - 1) });
const node = (id: string, params: Record<string, unknown> = {}, label = id) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label, definitionId: 'text-input', params, outputs: {}, state: 'idle' },
}) as Node<NodeData>;
// 60 below the param: 65 from the file's root, one past Save's 64.
const deepNode = (id: string) => node(id, { value: nested(60) });
const snapshot = (nodes: Node<NodeData>[], edges: Edge[] = []): UndoWalkStep => ({ nodes, edges });
const slice = (nodes: Record<string, Node<NodeData> | null>, edges: Record<string, Edge | null> = {}): UndoWalkStep => ({ before: { nodes, edges } });
const walk = (top: SaveUndoWalk['top'], steps: UndoWalkStep[]): SaveUndoWalk => ({ top, steps });
const line = (nodes: Node<NodeData>[], w: SaveUndoWalk) => {
  try {
    assertGraphComplexityWithinLimits(serializeGraph(nodes, []), 'save', () => saveStepToFit(w, nodes, [], undefined, undefined));
    return 'saved';
  } catch (error) {
    return (error as { reason: string }).reason;
  }
};

describe('Save names the Undo that fixes its refusal', () => {
  it('the reviewer\'s live order: the person\'s deep value, then Codex\'s rename on top: "Undo the last 2 changes"', () => {
    const canvas = [deepNode('a'), node('b', {}, 'Codex title')];
    // Newest first: Codex renamed b (its slice), the person typed a's value (a snapshot before it).
    const steps = [slice({ b: node('b') }), snapshot([node('a'), node('b')])];
    expect(undosToFitSave(canvas, [], undefined, undefined, steps)).toBe(2);
    expect(line(canvas, walk({ kind: 'agent', name: 'Codex' }, steps)))
      .toBe('It’s too complex to save. Undo the last 2 changes, then try again.');
  });

  it('the reverse: Codex\'s deep value on top of the person\'s rename: Codex’s, by name', () => {
    const canvas = [deepNode('a'), node('b', {}, 'Mine')];
    const steps = [slice({ a: node('a') }), snapshot([node('a'), node('b')])];
    expect(undosToFitSave(canvas, [], undefined, undefined, steps)).toBe(1);
    expect(line(canvas, walk({ kind: 'agent', name: 'Codex' }, steps)))
      .toBe('It’s too complex to save. Undo Codex’s last change, then try again.');
  });

  it('the person\'s own deep value on top: "your"; an unknown origin\'s: "the"', () => {
    const canvas = [deepNode('a')];
    expect(line(canvas, walk({ kind: 'person' }, [snapshot([node('a')])])))
      .toBe('It’s too complex to save. Undo your last change, then try again.');
    expect(line(canvas, walk({ kind: 'unknown' }, [slice({ a: node('a') })])))
      .toBe('It’s too complex to save. Undo the last change, then try again.');
  });

  it('3 steps: digits, never a number word', () => {
    const canvas = [deepNode('a'), node('b', {}, 'B2'), node('c', {}, 'C2')];
    const steps = [slice({ c: node('c') }), slice({ b: node('b') }), snapshot([node('a'), node('b'), node('c')])];
    expect(line(canvas, walk({ kind: 'agent', name: 'Claude' }, steps)))
      .toBe('It’s too complex to save. Undo the last 3 changes, then try again.');
  });

  it('no number of Undos fixes it (the value is older than every step): the first sentence only', () => {
    const canvas = [deepNode('a'), node('b', {}, 'B2')];
    const steps = [slice({ b: node('b') }), snapshot([deepNode('a'), node('b')])];
    expect(undosToFitSave(canvas, [], undefined, undefined, steps)).toBeNull();
    expect(line(canvas, walk({ kind: 'agent', name: 'Codex' }, steps))).toBe('It’s too complex to save.');
  });

  it('the value form takes the same endings', () => {
    const canvas = [node('a', { value: Infinity }), node('b', {}, 'B2')];
    const steps = [slice({ b: node('b') }), snapshot([node('a'), node('b')])];
    expect(line(canvas, walk({ kind: 'agent', name: 'Codex' }, steps)))
      .toBe('Part of it holds a value Nebula can’t save. Undo the last 2 changes, then try again.');
    expect(saveShapeLine('value', { kind: 'steps', count: 4 }))
      .toBe('Part of it holds a value Nebula can’t save. Undo the last 4 changes, then try again.');
  });

  it('an Undo that removes a node an agent added, and an add\'s step (null in its slice), count as they leave the canvas', () => {
    const canvas = [node('a'), deepNode('added')];
    expect(undosToFitSave(canvas, [], undefined, undefined, [slice({ added: null })])).toBe(1);
  });

  it('values: a count past the limit, fixed by the Undo that removes the big list, and counted as Save\'s file counts it', () => {
    const big = node('big', { value: Array.from({ length: GRAPH_MAX_VALUES }, () => 0) });
    const canvas = [node('a'), big, node('b', {}, 'B2')];
    const steps = [slice({ b: node('b') }), slice({ big: null })];
    expect(undosToFitSave(canvas, [], undefined, undefined, steps)).toBe(2);
    // The walk's count is the file's: the whole file measured at once.
    const file = { ...serializeGraph([node('a'), node('b')], [], { x: 0, y: 0, zoom: 1 }, 'n'), version: 3 };
    const parts = measureShape({ ...file, nodes: [], edges: [] }).count
      + file.nodes.reduce((sum, each) => sum + measureShape(each, 2).count, 0);
    expect(parts).toBe(measureShape(file).count);
  });
});
