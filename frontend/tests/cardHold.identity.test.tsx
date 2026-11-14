/**
 * With every card chunk loaded (the ordinary case once the idle preload has
 * run) the hold hands back the nodes and edges it was given, by identity, and
 * looks at no node: a new array on every render would re-render every card on
 * every drag (lib/cardHold.ts).
 */
import { renderHook } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { DEFERRED_CARD_PRELOADS } from '../src/lib/deferredChunks';
import { holdCards, resetCardHold, useCardHold } from '../src/lib/cardHold';

beforeAll(async () => { await Promise.all(DEFERRED_CARD_PRELOADS.map((preload) => preload())); });
beforeEach(resetCardHold);

/** A node that fails the test if anything reads it. */
const untouchable = (id: string): Node => new Proxy({ id } as Node, {
  get: (target, key) => {
    if (key === 'then') return undefined;
    throw new Error(`the hold read node ${id}.${String(key)}`);
  },
});

describe('the hold with every chunk loaded', () => {
  it('returns its inputs by identity and reads no node', () => {
    const nodes = [untouchable('a'), untouchable('b')];
    const edges: Edge[] = [{ id: 'e', source: 'a', target: 'b' }];
    const result = holdCards(nodes, edges, 3, { generation: -1, handed: [], placeholders: new Set() });
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
    expect(result.wholeGraph).toBe(false);
  });

  it('the hook keeps the same arrays across renders and a new generation', () => {
    const nodes = [untouchable('a')];
    const edges: Edge[] = [];
    const { result, rerender } = renderHook(({ n, e }) => useCardHold(n, e), { initialProps: { n: nodes, e: edges } });
    expect(result.current.nodes).toBe(nodes);
    expect(result.current.edges).toBe(edges);
    rerender({ n: nodes, e: edges });
    expect(result.current.nodes).toBe(nodes);
    const moved = [untouchable('a')];
    rerender({ n: moved, e: edges });
    expect(result.current.nodes).toBe(moved);
    expect(result.current.holding).toBe(false);
  });
});
