import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { deserializeGraph, GRAPH_PARAMS_VERSION, serializeGraph } from '../src/lib/graphFile';

// A .nebula file records which one-time param upgrades its values already have
// (backend services/saved_graph_upgrades.py), so POST /api/graph/import upgrades
// only files saved before them.
const claude: Node<NodeData> = { id: 'chat', type: 'model-node', position: { x: 0, y: 0 }, data: {
  definitionId: 'claude-chat', label: 'Claude', state: 'idle', outputs: {},
  params: { model: 'claude-opus-4-6', extended_thinking: true, max_tokens: 4096 },
} };

describe('graph file paramsVersion', () => {
  it('writes the current version, and a saved file reads it back', () => {
    const file = serializeGraph([claude], []);
    expect(file.paramsVersion).toBe(GRAPH_PARAMS_VERSION);
    const restored = deserializeGraph(JSON.parse(JSON.stringify(file)));
    expect(restored.paramsVersion).toBe(GRAPH_PARAMS_VERSION);
    // The canvas never rewrites params itself; the backend import does.
    expect(restored.nodes[0].data.params.max_tokens).toBe(4096);
  });

  it('reads a file saved before the marker as version 0', () => {
    const file = serializeGraph([claude], []);
    delete file.paramsVersion;
    expect(deserializeGraph(file).paramsVersion).toBe(0);
  });
});
