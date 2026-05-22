import { interpolate, Easing } from 'remotion';
import type { KeyframeData } from '../../types/video';

type Vec3 = [number, number, number];

function easingFor(kind: KeyframeData['easing']) {
  if (kind === 'linear') return Easing.linear;
  if (kind === 'clamp') return Easing.linear;
  // 'clamp' here is a hold-style modifier — the linear curve is used and the
  // clamping is enforced via extrapolateLeft/Right: 'clamp' in the call site.
  // In practice it currently behaves identically to 'linear'; if you need true
  // step/hold behavior, use a separate KeyframeData variant in Plan 2.1.b.
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
  if (!v.every((x) => typeof x === 'number')) {
    throw new Error('keyframeInterp: vec3 components must all be numbers');
  }
}

/**
 * Returns the index of the segment-start keyframe (i) and a 0-1 progress t
 * within that segment. When frame is outside the range the result is clamped:
 * before → { i: 0, t: 0 }; after → { i: last, t: 1 }.
 */
function findSegment(
  frame: number,
  sortedFrames: number[],
): { i: number; t: number } {
  if (frame <= sortedFrames[0]) return { i: 0, t: 0 };
  if (frame >= sortedFrames[sortedFrames.length - 1]) {
    return { i: sortedFrames.length - 1, t: 1 };
  }
  for (let i = 0; i < sortedFrames.length - 1; i++) {
    if (frame >= sortedFrames[i] && frame <= sortedFrames[i + 1]) {
      const span = sortedFrames[i + 1] - sortedFrames[i];
      return { i, t: span === 0 ? 0 : (frame - sortedFrames[i]) / span };
    }
  }
  // unreachable when sortedFrames is non-empty and monotonic
  return { i: sortedFrames.length - 1, t: 1 };
}

export function interpolateScalar(
  frame: number,
  keyframes: KeyframeData[],
  fallback: number,
): number {
  if (keyframes.length === 0) return fallback;
  // Single-keyframe: value wins regardless of frame. fallback applies only when keyframes is empty.
  if (keyframes.length === 1) {
    assertScalar(keyframes[0].value);
    return keyframes[0].value;
  }

  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  sorted.forEach((k) => assertScalar(k.value));

  if (frame <= sorted[0].frame) return sorted[0].value as number;
  const last = sorted[sorted.length - 1];
  if (frame >= last.frame) return last.value as number;

  // Find the bracketing segment and apply that segment-start keyframe's easing.
  // easing on a KeyframeData describes the curve *leaving* that keyframe, so
  // segment kf[i] → kf[i+1] uses kf[i].easing.
  const sortedFrames = sorted.map((k) => k.frame);
  const { i } = findSegment(frame, sortedFrames);
  const a = sorted[i];
  const b = sorted[i + 1];
  return interpolate(
    frame,
    [a.frame, b.frame],
    [a.value as number, b.value as number],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: easingFor(a.easing),
    },
  );
}

export function interpolateVec3(
  frame: number,
  keyframes: KeyframeData[],
  fallback: Vec3,
): Vec3 {
  if (keyframes.length === 0) return fallback;
  // Single-keyframe: value wins regardless of frame. fallback applies only when keyframes is empty.
  if (keyframes.length === 1) {
    assertVec3(keyframes[0].value);
    return [...keyframes[0].value] as Vec3;
  }

  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  sorted.forEach((k) => assertVec3(k.value));

  if (frame <= sorted[0].frame) return [...(sorted[0].value as Vec3)] as Vec3;
  const last = sorted[sorted.length - 1];
  if (frame >= last.frame) return [...(last.value as Vec3)] as Vec3;

  // Find the bracketing segment and apply that segment-start keyframe's easing
  // to all three axes. easing on a KeyframeData describes the curve *leaving*
  // that keyframe.
  const sortedFrames = sorted.map((k) => k.frame);
  const { i } = findSegment(frame, sortedFrames);
  const a = sorted[i];
  const b = sorted[i + 1];
  const easing = easingFor(a.easing);

  const axis = (j: 0 | 1 | 2): number =>
    interpolate(
      frame,
      [a.frame, b.frame],
      [(a.value as Vec3)[j], (b.value as Vec3)[j]],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing },
    );

  return [axis(0), axis(1), axis(2)];
}
