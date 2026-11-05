import { describe, expect, it } from 'vitest';
import { bringIntoView } from './bringIntoView';

// A citation chip's click moves the camera only when the tile isn't wholly
// in view (GM, Read the board section 3), and never zooms in.

const view = { x: 0, y: 0, zoom: 1 };

describe('bringIntoView', () => {
  it('leaves the camera alone when the tile is wholly in view', () => {
    expect(bringIntoView({ x: 10, y: 10, width: 100, height: 100 }, view, 800, 600, 0.12)).toBeNull();
    expect(bringIntoView({ x: 0, y: 0, width: 800, height: 600 }, view, 800, 600, 0.12)).toBeNull();
  });

  it('centres a tile that is partly out, at the same zoom', () => {
    expect(bringIntoView({ x: 750, y: 100, width: 100, height: 100 }, view, 800, 600, 0.12))
      .toEqual({ zoom: 1, x: 400 - 800, y: 300 - 150 });
  });

  it('reads the view at the camera’s pan and zoom', () => {
    const camera = { x: -1000, y: -500, zoom: 0.5 };
    // Visible: x 2000..3600, y 1000..2200.
    expect(bringIntoView({ x: 2100, y: 1100, width: 200, height: 200 }, camera, 800, 600, 0.12)).toBeNull();
    expect(bringIntoView({ x: 1900, y: 1100, width: 200, height: 200 }, camera, 800, 600, 0.12)).not.toBeNull();
  });

  it('zooms out just enough for a tile bigger than the view, never in', () => {
    const to = bringIntoView({ x: 0, y: 0, width: 2000, height: 1000 }, view, 800, 600, 0.12)!;
    expect(to.zoom).toBeCloseTo(800 / (2000 * 1.24));
    const small = bringIntoView({ x: 5000, y: 0, width: 10, height: 10 }, { x: 0, y: 0, zoom: 0.25 }, 800, 600, 0.12)!;
    expect(small.zoom).toBe(0.25);
  });

  it('does nothing for a view with no size yet', () => {
    expect(bringIntoView({ x: 5000, y: 0, width: 10, height: 10 }, view, 0, 0, 0.12)).toBeNull();
  });
});
