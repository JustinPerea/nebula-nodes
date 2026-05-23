import { describe, expect, it } from 'vitest';
import { computeRotationZ } from '../../src/lib/video/rotationMath';

const RECT = { left: 100, top: 200, width: 200, height: 100 };

describe('computeRotationZ', () => {
  it('returns 0 when the pointer is above the rect center', () => {
    expect(computeRotationZ(RECT, 200, 200)).toBe(0);
  });

  it('returns 90 when the pointer is right of the rect center', () => {
    expect(computeRotationZ(RECT, 300, 250)).toBe(90);
  });

  it('returns 180 when the pointer is below the rect center', () => {
    expect(computeRotationZ(RECT, 200, 300)).toBe(180);
  });

  it('returns 270 when the pointer is left of the rect center', () => {
    expect(computeRotationZ(RECT, 100, 250)).toBe(270);
  });
});
