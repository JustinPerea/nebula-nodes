import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { deserializeGraph, serializeGraph } from '../src/lib/graphFile';

describe('Batch graph file compatibility', () => {
  it.each([1, 2, 3] as const)('restores the custom card and authoring/edge contract in version %s', (version) => {
    const batch: Node<NodeData> = { id: 'batch', type: 'batch-node', position: { x: 10, y: 20 }, data: {
      definitionId: 'batch', label: 'colors', state: 'complete',
      params: { display_name: 'colors', items_text: 'red\nred\nblue', split_mode: 'by_line', batch_size_cap: 10 },
      outputs: { set: { type: 'Text', value: 'blue' } },
      batchRunId: 'run-private', batchOutputs: [{ set: { type: 'Text', value: 'red' } }],
      batchVariants: [{ index: 0, label: 'red', lineage: [] }],
    } };
    const preview: Node<NodeData> = { id: 'preview', type: 'model-node', position: { x: 400, y: 20 }, data: {
      definitionId: 'preview', label: 'Preview', state: 'idle', params: {}, outputs: {},
    } };
    const edges = [{ id: 'wire', source: 'batch', sourceHandle: 'set', target: 'preview',
      targetHandle: 'input', type: 'typed-edge', data: { portType: 'Text' } }];
    const file = serializeGraph([batch, preview], edges);
    file.version = version;
    const restored = deserializeGraph(JSON.parse(JSON.stringify(file)));
    expect(restored.warnings).toEqual([]);
    expect(restored.nodes[0].type).toBe('batchNode');
    expect(restored.nodes[0].data.params).toEqual(batch.data.params);
    expect(restored.edges).toEqual(edges);
    // Portable graph files keep authoring and the canonical output. The
    // per-item gallery and owner stay in local immutable run history.
    expect(file.nodes[0].data).not.toHaveProperty('batchRunId');
    expect(file.nodes[0].data).not.toHaveProperty('batchOutputs');
    expect(restored.nodes[0].data.batchVariants).toBeUndefined();
  });
});
