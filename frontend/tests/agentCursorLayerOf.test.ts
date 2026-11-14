import { describe, expect, it } from 'vitest';
import { layerOf } from '../src/lib/agentCursorLayerOf';
import type { AgentCursorAnchor } from '../src/lib/wsClient';

/** Cursor Phase 3, slice 4: which layer draws a cursor. */
const board: AgentCursorAnchor = { surface: 'moodboard', itemId: 'b1/i2', part: 'note' };
const node: AgentCursorAnchor = { nodeId: 'n1', handle: 'prompt' };
const spot: AgentCursorAnchor = { x: 10, y: 20 };

describe('layerOf', () => {
  it('draws a surface target on the screen layer, with the canvas or without it', () => {
    expect(layerOf(board, { canvasMounted: true })).toBe('screen');
    expect(layerOf(board, { canvasMounted: false })).toBe('screen');
  });

  it('draws a canvas target on the canvas while it is mounted, else on the screen layer', () => {
    for (const anchor of [node, spot]) {
      expect(layerOf(anchor, { canvasMounted: true })).toBe('canvas');
      expect(layerOf(anchor, { canvasMounted: false })).toBe('screen');
    }
  });

  it('puts every cursor on exactly one layer', () => {
    for (const anchor of [board, node, spot]) {
      for (const canvasMounted of [true, false]) {
        const layers = (['canvas', 'screen'] as const).filter((layer) => layerOf(anchor, { canvasMounted }) === layer);
        expect(layers).toHaveLength(1);
      }
    }
  });
});
