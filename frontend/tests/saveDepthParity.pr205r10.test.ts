import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { undosToFitSave } from '../src/lib/saveFixStep';
import {
  assertGraphComplexityWithinLimits, GRAPH_MAX_DEPTH, GraphStructureLimitError, measureShape, serializeGraph,
} from '../src/lib/graphFileShared';

// PR #205 round 10, ruling (a): the Undo walk's "fits Save" and the Save's refusal share one
// predicate: the engine's. The engine (assertGraphComplexityWithinLimits, and the backend's
// RESTORE_MAX_GRAPH_DEPTH checks) refuses a value deeper than 64 (`depth > 64`, the file's root at
// depth 0), so a canvas at depth 64 saves and one at 65 does not. The line therefore reads "more than
// 64 levels deep". The two must agree at 63, 64 and 65.

/** A canvas whose file is exactly `depth` deep (its deepest value sits at that depth from the root). */
function canvasDeep(depth: number): Node<NodeData>[] {
  for (let levels = 0; levels <= depth; levels += 1) {
    let value: unknown = 1;
    for (let at = 0; at < levels; at += 1) value = { v: value };
    const nodes = [{
      id: 'n', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'n', definitionId: 'text-input', params: { value }, outputs: {}, state: 'idle' },
    }] as Node<NodeData>[];
    if (measureShape({ ...serializeGraph(nodes, []), version: 3 }).depth === depth) return nodes;
  }
  throw new Error(`no canvas ${depth} deep`);
}

const saveRefuses = (nodes: Node<NodeData>[]): GraphStructureLimitError | null => {
  try {
    assertGraphComplexityWithinLimits({ ...serializeGraph(nodes, []), version: 3 }, 'save');
    return null;
  } catch (error) {
    if (error instanceof GraphStructureLimitError) return error;
    throw error;
  }
};
const undoWalkFits = (nodes: Node<NodeData>[]) => undosToFitSave(nodes, [], undefined, undefined, []) === 0;

describe('the Save refusal and the Undo walk\'s "fits" agree on depth', () => {
  it('the limit is 64, refused past it', () => {
    expect(GRAPH_MAX_DEPTH).toBe(64);
  });

  for (const depth of [63, 64, 65]) {
    it(`a canvas ${depth} deep: Save refuses it exactly when the walk says it does not fit`, () => {
      const nodes = canvasDeep(depth);
      const refusal = saveRefuses(nodes);
      expect(refusal !== null).toBe(depth > 64);
      expect(undoWalkFits(nodes)).toBe(depth <= 64);
      expect(undoWalkFits(nodes)).toBe(refusal === null);
      if (refusal) expect(refusal.detail).toBe('Graph is nested more than 64 levels deep.');
    });
  }
});
