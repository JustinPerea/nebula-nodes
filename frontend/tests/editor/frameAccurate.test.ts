import { describe, it, expect } from 'vitest';
import { snapToFrameGrid, hasRequestVideoFrameCallback } from '../../src/lib/editor/frameAccurate';

describe('snapToFrameGrid', () => {
  it('snaps 1.05 at 30fps to 31/30', () => {
    expect(snapToFrameGrid(1.05, 30)).toBeCloseTo(31 / 30, 5);
  });
  it('preserves frame-aligned times', () => {
    expect(snapToFrameGrid(2.0, 30)).toBe(2.0);
  });
  it('handles 0 fps gracefully', () => {
    expect(snapToFrameGrid(1.05, 0)).toBe(1.05);
  });
});

describe('hasRequestVideoFrameCallback', () => {
  it('is a boolean', () => {
    expect(typeof hasRequestVideoFrameCallback()).toBe('boolean');
  });
});
