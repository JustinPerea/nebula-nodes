import { describe, it, expect } from 'vitest';
import { clampPercent } from '../src/components/nodes/beforeAfter';

describe('clampPercent', () => {
  it('passes through values in range', () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(100)).toBe(100);
    expect(clampPercent(37.5)).toBe(37.5);
  });

  it('clamps out-of-range values', () => {
    expect(clampPercent(-20)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });

  it('falls back to 50 for NaN', () => {
    expect(clampPercent(NaN)).toBe(50);
  });
});
