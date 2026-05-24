import { describe, it, expect } from 'vitest';
import { snapMovementToCenter } from '../../src/lib/video/snapGuides';

describe('snapMovementToCenter', () => {
  it('snaps each axis independently when the dragged anchor is near center', () => {
    expect(snapMovementToCenter({
      anchorStartX: 10,
      anchorStartY: -20,
      dx: -8,
      dy: 17,
      thresholdX: 3,
      thresholdY: 4,
    })).toEqual({
      dx: -10,
      dy: 20,
      snappedX: true,
      snappedY: true,
    });
  });

  it('leaves movement unchanged outside the center threshold', () => {
    expect(snapMovementToCenter({
      anchorStartX: 10,
      anchorStartY: -20,
      dx: -5,
      dy: 10,
      thresholdX: 3,
      thresholdY: 4,
    })).toEqual({
      dx: -5,
      dy: 10,
      snappedX: false,
      snappedY: false,
    });
  });
});
