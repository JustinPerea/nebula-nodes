import { describe, it, expect } from 'vitest';
import { interpolateScalar, interpolateVec3 } from '../../src/lib/video/keyframeInterp';
import type { KeyframeData } from '../../src/types/video';

describe('interpolateScalar', () => {
  it('returns the fallback when keyframes is empty', () => {
    expect(interpolateScalar(10, [], 0.5)).toBe(0.5);
  });

  it('returns the only keyframe value when there is exactly one', () => {
    const kfs: KeyframeData[] = [{ frame: 0, value: 42, easing: 'linear' }];
    expect(interpolateScalar(50, kfs, 0)).toBe(42);
  });

  it('clamps before the first keyframe to that keyframe value', () => {
    const kfs: KeyframeData[] = [
      { frame: 30, value: 1, easing: 'linear' },
      { frame: 60, value: 5, easing: 'linear' },
    ];
    expect(interpolateScalar(10, kfs, 0)).toBe(1);
  });

  it('clamps after the last keyframe to that keyframe value', () => {
    const kfs: KeyframeData[] = [
      { frame: 30, value: 1, easing: 'linear' },
      { frame: 60, value: 5, easing: 'linear' },
    ];
    expect(interpolateScalar(120, kfs, 0)).toBe(5);
  });

  it('linearly interpolates between two scalar keyframes', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: 0, easing: 'linear' },
      { frame: 60, value: 100, easing: 'linear' },
    ];
    expect(interpolateScalar(30, kfs, 0)).toBe(50);
  });

  it('throws if a vec3 keyframe is fed to scalar interpolation', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: [1, 2, 3], easing: 'linear' },
    ];
    expect(() => interpolateScalar(10, kfs, 0)).toThrow(/scalar/);
  });
});

describe('interpolateVec3', () => {
  it('returns the fallback when keyframes is empty', () => {
    expect(interpolateVec3(10, [], [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('linearly interpolates each component independently', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: [0, 0, 0], easing: 'linear' },
      { frame: 60, value: [100, 200, 300], easing: 'linear' },
    ];
    expect(interpolateVec3(30, kfs, [0, 0, 0])).toEqual([50, 100, 150]);
  });

  it('throws if a scalar keyframe is fed to vec3 interpolation', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: 42, easing: 'linear' },
    ];
    expect(() => interpolateVec3(10, kfs, [0, 0, 0])).toThrow(/vec3/);
  });
});

describe('interpolateScalar — per-segment easing', () => {
  it('uses the segment-start keyframes easing, not the first overall', () => {
    // Three keyframes with different easings. Frame 45 is in segment 1 (kf1→kf2).
    // Linear interp between (30, 0) and (60, 100) at frame 45 → 50.
    // If the bug were still present, the bezier from kf0 would distort this.
    const kfs: KeyframeData[] = [
      { frame: 0, value: 0, easing: 'spring' },
      { frame: 30, value: 0, easing: 'linear' },
      { frame: 60, value: 100, easing: 'linear' },
    ];
    expect(interpolateScalar(45, kfs, 0)).toBe(50);
  });

  it('clamp easing kind interpolates without throwing', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: 0, easing: 'clamp' },
      { frame: 60, value: 100, easing: 'clamp' },
    ];
    expect(interpolateScalar(30, kfs, 0)).toBe(50);
  });

  it('spring easing kind produces a non-linear curve', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: 0, easing: 'spring' },
      { frame: 60, value: 100, easing: 'spring' },
    ];
    // The bezier(0.16, 1, 0.3, 1) curve eases out fast then settles.
    // At t=0.5 (frame 30), the value should be > 50 (not the linear midpoint).
    const v = interpolateScalar(30, kfs, 0);
    expect(v).toBeGreaterThan(50);
    expect(v).toBeLessThanOrEqual(100);
  });
});

describe('assertVec3', () => {
  it('rejects vec3 containing non-numeric elements', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: ['a', 'b', 'c'] as unknown as [number, number, number], easing: 'linear' },
    ];
    expect(() => interpolateVec3(10, kfs, [0, 0, 0])).toThrow(/number/);
  });
});
