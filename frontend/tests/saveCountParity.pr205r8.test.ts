import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { measureShape, serializeGraph } from '../src/lib/graphFileShared';
import shared from '../../backend/tests/fixtures/save_count_parity.json';

// Review 7 of PR #205 (limits MEDIUM-3): Save's count of a canvas, as the
// backend counts it before an agent's edit (backend
// tests/test_save_count_parity.py reads the same canvases and pins the same
// numbers).
const PINNED: Record<string, number> = {
  'no outputs, no connections': 24,
  'outputs on one node, none on another': 44,
  'connections with and without data': 53,
};

describe('Save\'s count of a canvas, as the backend counts it', () => {
  it.each(shared.cases.map((c) => [c.name, c] as const))('%s', (name, canvas) => {
    const file = { ...serializeGraph(canvas.nodes as unknown as Node<NodeData>[], canvas.edges as Edge[],
      { x: 10, y: 20, zoom: 0.5 }, 'Campaign'), version: 3 };
    expect(measureShape(file).count).toBe(PINNED[name]);
  });
});
