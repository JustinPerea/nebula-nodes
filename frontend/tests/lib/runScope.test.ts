import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { describeRunScope, summarizeRunScope } from '../../src/lib/runScope';
import type { NodeData } from '../../src/types';

const node = (id: string, definitionId: string, label = ''): Node<NodeData> => ({
  id, position: { x: 0, y: 0 }, data: { definitionId, label, params: {} } as unknown as NodeData,
});

// prompt -> image -> claude, plus an unconnected second image.
const nodes = [
  node('prompt', 'text-input'),
  node('image', 'gpt-image-1-generate', 'Hero shot'),
  node('chat', 'claude-chat'),
  node('stray', 'gpt-image-1-generate'),
];
const edges: Edge[] = [
  { id: 'e1', source: 'prompt', target: 'image' },
  { id: 'e2', source: 'image', target: 'chat' },
];

describe('run scope', () => {
  it('counts the whole graph and names paid nodes by label, then definition name', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'graph' });
    expect(summary.total).toBe(4);
    expect(summary.paid).toHaveLength(3);
    expect(summary.paid[0]).toBe('Hero shot');
  });

  it('runs one node with everything feeding it, and nothing downstream', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'image' });
    expect(summary).toEqual({ total: 2, paid: ['Hero shot'] });
  });

  it('runs a cluster exactly as selected', () => {
    expect(summarizeRunScope(nodes, edges, { kind: 'cluster', nodeIds: ['prompt'] })).toEqual({ total: 1, paid: [] });
  });

  it('describes free and paid scopes in plain language', () => {
    expect(describeRunScope({ total: 1, paid: [] })).toBe('Runs 1 node · no paid providers');
    expect(describeRunScope({ total: 2, paid: ['Hero shot'] })).toBe('Runs 2 nodes · 1 calls a paid provider: Hero shot');
    expect(describeRunScope({ total: 5, paid: ['a', 'b', 'c', 'd'] })).toBe('Runs 5 nodes · 4 call paid providers: a, b, c and 1 more');
  });
});
