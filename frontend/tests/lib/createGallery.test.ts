import { describe, it, expect } from 'vitest';
import { galleryItemsFromSession, type GenerationRecord } from '../../src/lib/createGallery';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

function node(id: string, state: NodeData['state'], outputs: NodeData['outputs'] = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: id, definitionId: 'nano-banana', params: {}, state, outputs } };
}

describe('galleryItemsFromSession', () => {
  it('expands each generation into one item per model node, newest first, with live node data', () => {
    const records: GenerationRecord[] = [
      { genId: 'g1', prompt: 'cat', ts: 1, modelNodeIds: ['n2'] },
      { genId: 'g2', prompt: 'dog', ts: 2, modelNodeIds: ['n4', 'n5'] },
    ];
    const nodes = [node('n2', 'complete', { image: { type: 'Image', value: '/api/outputs/a.png' } }), node('n4', 'executing'), node('n5', 'complete')];
    const items = galleryItemsFromSession(records, nodes);
    // newest generation (g2) first; its two variations precede g1
    expect(items.map((i) => i.nodeId)).toEqual(['n4', 'n5', 'n2']);
    expect(items[2].prompt).toBe('cat');
    expect(items[2].node?.data.state).toBe('complete');
    expect(items[0].node?.data.state).toBe('executing');
  });

  it('drops model node ids that no longer exist (deleted)', () => {
    const records: GenerationRecord[] = [{ genId: 'g1', prompt: 'x', ts: 1, modelNodeIds: ['n2', 'gone'] }];
    const items = galleryItemsFromSession(records, [node('n2', 'complete')]);
    expect(items.map((i) => i.nodeId)).toEqual(['n2']);
  });
});
