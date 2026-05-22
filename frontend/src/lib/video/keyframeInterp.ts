import { interpolate, Easing } from 'remotion';
import type { KeyframeData } from '../../types/video';

type Vec3 = [number, number, number];

function easingFor(kind: KeyframeData['easing']) {
  if (kind === 'linear') return Easing.linear;
  if (kind === 'clamp') return Easing.linear; // clamp = no easing curve; clamping is on extrapolate
  // 'spring' uses a cubic-bezier approximation in this phase. A true
  // Remotion spring() integration is deferred to Plan 2.1.b.
  return Easing.bezier(0.16, 1, 0.3, 1);
}

function assertScalar(v: KeyframeData['value']): asserts v is number {
  if (typeof v !== 'number') {
    throw new Error('keyframeInterp: expected scalar value, got vec3');
  }
}

function assertVec3(v: KeyframeData['value']): asserts v is Vec3 {
  if (!Array.isArray(v) || v.length !== 3) {
    throw new Error('keyframeInterp: expected vec3 value, got scalar');
  }
}

export function interpolateScalar(
  frame: number,
  keyframes: KeyframeData[],
  fallback: number,
): number {
  if (keyframes.length === 0) return fallback;
  if (keyframes.length === 1) {
    assertScalar(keyframes[0].value);
    return keyframes[0].value;
  }

  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  sorted.forEach((k) => assertScalar(k.value));

  const frames = sorted.map((k) => k.frame);
  const values = sorted.map((k) => k.value as number);

  return interpolate(frame, frames, values, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: easingFor(sorted[0].easing),
  });
}

export function interpolateVec3(
  frame: number,
  keyframes: KeyframeData[],
  fallback: Vec3,
): Vec3 {
  if (keyframes.length === 0) return fallback;
  if (keyframes.length === 1) {
    assertVec3(keyframes[0].value);
    return [...keyframes[0].value] as Vec3;
  }

  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  sorted.forEach((k) => assertVec3(k.value));

  const frames = sorted.map((k) => k.frame);
  const easing = easingFor(sorted[0].easing);

  const axis = (i: 0 | 1 | 2): number =>
    interpolate(
      frame,
      frames,
      sorted.map((k) => (k.value as Vec3)[i]),
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing },
    );

  return [axis(0), axis(1), axis(2)];
}
