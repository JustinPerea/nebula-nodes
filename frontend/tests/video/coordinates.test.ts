import { describe, it, expect } from 'vitest';
import { screenToComposition } from '../../src/lib/video/coordinates';

function mockPlayerEl(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}),
  });
  return el;
}

describe('screenToComposition', () => {
  it('returns zero deltas for zero screen deltas', () => {
    const el = mockPlayerEl(1280, 720);
    expect(screenToComposition(0, 0, el)).toEqual({ x: 0, y: 0 });
  });

  it('scales 1:1 when player rect matches composition (1280x720)', () => {
    const el = mockPlayerEl(1280, 720);
    expect(screenToComposition(100, 50, el)).toEqual({ x: 100, y: 50 });
  });

  it('scales 2x when player rect is half composition size (640x360)', () => {
    const el = mockPlayerEl(640, 360);
    expect(screenToComposition(50, 25, el)).toEqual({ x: 100, y: 50 });
  });

  it('accepts custom composition dimensions', () => {
    const el = mockPlayerEl(1920, 1080);
    expect(screenToComposition(192, 108, el, 1920, 1080)).toEqual({ x: 192, y: 108 });
  });

  it('handles negative deltas (pointer moved up/left)', () => {
    const el = mockPlayerEl(1280, 720);
    expect(screenToComposition(-200, -100, el)).toEqual({ x: -200, y: -100 });
  });
});
