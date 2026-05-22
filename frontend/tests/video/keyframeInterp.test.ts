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
