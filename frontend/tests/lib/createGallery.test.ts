import { describe, it, expect } from 'vitest';
import { galleryItemsFromSession, galleryItemsFromCanvas, type GenerationRecord } from '../../src/lib/createGallery';
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

// ─── galleryItemsFromCanvas ────────────────────────────────────────────────

function canvasNode(
  id: string,
  definitionId: string,
  outputs: NodeData['outputs'] = {},
  createOrigin?: { genId: string; prompt: string; ts: number },
): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      definitionId,
      params: {},
      state: 'complete',
      outputs,
      _createOrigin: createOrigin
        ? { sessionId: 'sess', genId: createOrigin.genId, ts: createOrigin.ts, prompt: createOrigin.prompt }
        : undefined,
    },
  };
}

describe('galleryItemsFromCanvas', () => {
  it('includes a node with an Image output', () => {
    const n = canvasNode('n1', 'nano-banana', { out: { type: 'Image', value: '/api/outputs/a.png' } });
    const items = galleryItemsFromCanvas([n]);
    expect(items.map((i) => i.nodeId)).toEqual(['n1']);
  });

  it('excludes a text-input node even when it has output', () => {
    const n = canvasNode('n2', 'text-input', { value: { type: 'Text', value: 'hello' } });
    const items = galleryItemsFromCanvas([n]);
    expect(items).toHaveLength(0);
  });

  it('excludes image-input and reroute nodes', () => {
    const img = canvasNode('n3', 'image-input', { out: { type: 'Image', value: '/api/outputs/b.png' } });
    const re = canvasNode('n4', 'reroute', { out: { type: 'Image', value: '/api/outputs/c.png' } });
    expect(galleryItemsFromCanvas([img, re])).toHaveLength(0);
  });

  it('excludes a node with no output value', () => {
    const n = canvasNode('n5', 'nano-banana', {});
    expect(galleryItemsFromCanvas([n])).toHaveLength(0);
  });

  it('filters to selectedIds when provided', () => {
    const n1 = canvasNode('n1', 'nano-banana', { out: { type: 'Image', value: '/api/outputs/a.png' } });
    const n2 = canvasNode('n2', 'nano-banana', { out: { type: 'Image', value: '/api/outputs/b.png' } });
    const items = galleryItemsFromCanvas([n1, n2], new Set(['n1']));
    expect(items.map((i) => i.nodeId)).toEqual(['n1']);
  });

  it('returns all nodes when selectedIds is an empty set', () => {
    const n1 = canvasNode('n1', 'nano-banana', { out: { type: 'Image', value: '/api/outputs/a.png' } });
    const n2 = canvasNode('n2', 'nano-banana', { out: { type: 'Image', value: '/api/outputs/b.png' } });
    expect(galleryItemsFromCanvas([n1, n2], new Set())).toHaveLength(2);
  });

  it('uses _createOrigin for genId/prompt/ts when present', () => {
    const n = canvasNode(
      'n1',
      'nano-banana',
      { out: { type: 'Image', value: '/api/outputs/a.png' } },
      { genId: 'g42', prompt: 'a cat', ts: 9999 },
    );
    const [item] = galleryItemsFromCanvas([n]);
    expect(item.genId).toBe('g42');
    expect(item.prompt).toBe('a cat');
    expect(item.ts).toBe(9999);
  });

  it('falls back to node id/label/0 when no _createOrigin', () => {
    const n = canvasNode('n1', 'nano-banana', { out: { type: 'Image', value: '/api/outputs/a.png' } });
    const [item] = galleryItemsFromCanvas([n]);
    expect(item.genId).toBe('n1');
    expect(item.prompt).toBe('n1');
    expect(item.ts).toBe(0);
  });
});
