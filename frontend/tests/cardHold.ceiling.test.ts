/**
 * The pure core of the hold's ceiling (lib/cardHold.ts): a whole graph that
 * waits on a chunk is held back until `ceilingPassed`, then handed over with
 * the nodes whose chunks are in as their cards and the others as fallback
 * frames. No chunk is preloaded here, so the Character card's is pending.
 */
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { CARD_FALLBACK_TYPE } from '../src/lib/cardFallback';
import { HOLD_CEILING_MS, holdCards, type HoldState } from '../src/lib/cardHold';

const START: HoldState = { generation: -1, handed: [], placeholders: new Set() };
const text = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', params: {} } } as Node;
const character = { id: 'n2', type: 'characterNode', position: { x: 300, y: 0 }, data: { definitionId: 'character', params: {} } } as Node;

describe('holdCards and the ceiling', () => {
  it('is 8,000 ms', () => {
    expect(HOLD_CEILING_MS).toBe(8000);
  });

  it('holds a whole graph while the ceiling has not passed', () => {
    const held = holdCards([text, character], [], 5, START, false);
    expect(held.wholeGraph).toBe(true);
    expect(held.nodes).toEqual([]);
    expect(held.waiting.length).toBeGreaterThan(0);
  });

  it('past the ceiling hands the graph over: ready nodes as cards, waiting ones as frames', () => {
    const held = holdCards([text, character], [], 5, START, true);
    expect(held.wholeGraph).toBe(false);
    expect(held.nodes.map((node) => [node.id, node.type])).toEqual([['n1', 'model-node'], ['n2', CARD_FALLBACK_TYPE]]);
    expect(held.waiting.length).toBeGreaterThan(0);
    expect(held.state.generation).toBe(5);
    expect([...held.state.placeholders]).toEqual(['n2']);
    // The frame stays while the chunk is out, with the ceiling still passed for this generation.
    const again = holdCards([text, character], [], 5, held.state, true);
    expect(again.nodes.map((node) => node.type)).toEqual(['model-node', CARD_FALLBACK_TYPE]);
  });

  it('a new generation without the ceiling passed is held again', () => {
    const handed = holdCards([text, character], [], 5, START, true);
    const next = holdCards([text, character], [], 6, handed.state, false);
    expect(next.wholeGraph).toBe(true);
    expect(next.nodes).toEqual([]);
  });
});
