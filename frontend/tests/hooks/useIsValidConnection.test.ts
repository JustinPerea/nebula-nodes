import { describe, it, expect } from 'vitest';
import { wouldCreateCycle } from '../../src/hooks/useIsValidConnection';
import type { Node, Edge } from '@xyflow/react';

function makeNode(id: string): Node {
  return { id, position: { x: 0, y: 0 }, data: {} } as Node;
}

function makeEdge(source: string, target: string): Edge {
  return { id: `${source}-${target}`, source, target } as Edge;
}

describe('wouldCreateCycle', () => {
  it('returns false for a simple valid connection', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges: Edge[] = [];
    expect(wouldCreateCycle('a', 'b', nodes, edges)).toBe(false);
  });

  it('returns true for a direct self-loop', () => {
    const nodes = [makeNode('a')];
    const edges: Edge[] = [];
    expect(wouldCreateCycle('a', 'a', nodes, edges)).toBe(true);
  });

  it('returns true for a 2-node cycle', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b')];
    expect(wouldCreateCycle('b', 'a', nodes, edges)).toBe(true);
  });

  it('returns true for a 3-node cycle', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    expect(wouldCreateCycle('c', 'a', nodes, edges)).toBe(true);
  });

  it('returns false for a valid chain', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b')];
    expect(wouldCreateCycle('b', 'c', nodes, edges)).toBe(false);
  });

  it('returns false for independent subgraphs', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
    const edges = [makeEdge('a', 'b'), makeEdge('c', 'd')];
    expect(wouldCreateCycle('a', 'd', nodes, edges)).toBe(false);
  });
});
