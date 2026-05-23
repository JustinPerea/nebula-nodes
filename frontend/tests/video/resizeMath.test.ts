import { describe, expect, it } from 'vitest';
import { computeResizeScale } from '../../src/lib/video/resizeMath';

const rect = { width: 200, height: 100 };

describe('computeResizeScale', () => {
  it('scales a corner proportionally by default using the larger width/height ratio', () => {
    expect(
      computeResizeScale({
        handle: 'corner-br',
        startScale: [1, 1, 1],
        rect,
        dxScreen: 40,
        dyScreen: 10,
        shiftKey: false,
      }),
    ).toEqual([1.2, 1.2, 1]);
  });

  it('lets Shift release corner proportional scaling into independent X/Y ratios', () => {
    expect(
      computeResizeScale({
        handle: 'corner-br',
        startScale: [1, 1, 1],
        rect,
        dxScreen: 40,
        dyScreen: 10,
        shiftKey: true,
      }),
    ).toEqual([1.2, 1.1, 1]);
  });

  it('inverts deltas for the top-left corner so outward drag grows the layer', () => {
    expect(
      computeResizeScale({
        handle: 'corner-tl',
        startScale: [1, 1, 1],
        rect,
        dxScreen: -20,
        dyScreen: -15,
        shiftKey: false,
      }),
    ).toEqual([1.15, 1.15, 1]);
  });

  it('updates only scale.x for the right edge', () => {
    expect(
      computeResizeScale({
        handle: 'edge-right',
        startScale: [2, 3, 4],
        rect,
        dxScreen: 40,
        dyScreen: 80,
        shiftKey: false,
      }),
    ).toEqual([2.4, 3, 4]);
  });

  it('inverts dx for the left edge', () => {
    expect(
      computeResizeScale({
        handle: 'edge-left',
        startScale: [2, 3, 4],
        rect,
        dxScreen: -20,
        dyScreen: 0,
        shiftKey: false,
      }),
    ).toEqual([2.2, 3, 4]);
  });

  it('updates only scale.y for the bottom edge', () => {
    const scale = computeResizeScale({
      handle: 'edge-bottom',
      startScale: [2, 3, 4],
      rect,
      dxScreen: 40,
      dyScreen: 20,
      shiftKey: false,
    });
    expect(scale[0]).toBe(2);
    expect(scale[1]).toBeCloseTo(3.6);
    expect(scale[2]).toBe(4);
  });

  it('inverts dy for the top edge', () => {
    const scale = computeResizeScale({
      handle: 'edge-top',
      startScale: [2, 3, 4],
      rect,
      dxScreen: 0,
      dyScreen: -10,
      shiftKey: false,
    });
    expect(scale[0]).toBe(2);
    expect(scale[1]).toBeCloseTo(3.3);
    expect(scale[2]).toBe(4);
  });

  it('returns the starting scale when rect dimensions are zero', () => {
    expect(
      computeResizeScale({
        handle: 'corner-br',
        startScale: [2, 3, 4],
        rect: { width: 0, height: 100 },
        dxScreen: 40,
        dyScreen: 20,
        shiftKey: false,
      }),
    ).toEqual([2, 3, 4]);
  });
});
