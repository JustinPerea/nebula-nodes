import {
  Euler,
  MathUtils,
  PerspectiveCamera,
  Vector2,
  Vector3,
  type Matrix4,
} from 'three';

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export interface WorldSceneBounds {
  /** Sampled robust center used by navigation when the source frame is unknown. */
  center: [number, number, number];
  /** Sampled robust horizontal radius used for navigation speed and limits. */
  radius: number;
  /** Sampled center-to-edge radius retained for conservative camera clipping. */
  clipRadius: number;
  /** Authoritative reset position when the source frame defines a capture origin. */
  resetPosition?: [number, number, number];
  /** Where the reset camera looks, for an object seen from outside (a World
   * v2 object splat). Without it the camera looks along -Z from its position,
   * as for an environment. */
  resetTarget?: [number, number, number];
  /** Orbit's farthest zoom-out, for an object framed from outside; without
   * it worldOrbitMaxDistance(radius) holds (an environment's scale). */
  orbitMaxDistance?: number;
}

export interface WorldCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  near: number;
  far: number;
}

export const WORLD_EYE_HEIGHT_METERS = 1.65;
export const WORLD_NAVIGATION_SAMPLE_LIMIT = 8_192;
const WORLD_NAVIGATION_TRIM_FRACTION = 0.02;

export interface IndexedWorldSplatSource {
  getNumSplats: () => number;
  getSplat: (index: number) => {
    center: WorldPoint;
    opacity: number;
  };
}

function finitePoint(point: WorldPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = MathUtils.clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
}

/** Read a bounded, evenly distributed sample from Spark's indexed PackedSplats. */
export function sampleWorldSplatCenters(
  splats: IndexedWorldSplatSource,
  matrixWorld: Matrix4,
): WorldPoint[] {
  const reportedCount = splats.getNumSplats();
  const splatCount = Number.isFinite(reportedCount)
    ? Math.max(0, Math.floor(reportedCount))
    : 0;
  const sampleCount = Math.min(splatCount, WORLD_NAVIGATION_SAMPLE_LIMIT);
  const sampledCenters: WorldPoint[] = [];
  const transformed = new Vector3();

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const index = sampleCount <= 1
      ? 0
      : Math.round((sampleIndex * (splatCount - 1)) / (sampleCount - 1));
    const splat = splats.getSplat(index);
    if (!Number.isFinite(splat.opacity) || splat.opacity <= 0.02 || !finitePoint(splat.center)) {
      continue;
    }
    transformed.set(splat.center.x, splat.center.y, splat.center.z).applyMatrix4(matrixWorld);
    sampledCenters.push({ x: transformed.x, y: transformed.y, z: transformed.z });
  }

  return sampledCenters;
}

/**
 * Derive speed, control, and clipping bounds from the bounded indexed sample.
 * These sampled values must not replace an authoritative capture-origin reset.
 */
export function robustWorldSceneBounds(
  sampledCenters: readonly WorldPoint[],
  fallbackCenter: WorldPoint = { x: 0, y: 0, z: 0 },
  fallbackRadius = 3,
): WorldSceneBounds {
  const safeFallbackCenter: [number, number, number] = finitePoint(fallbackCenter)
    ? [fallbackCenter.x, fallbackCenter.y, fallbackCenter.z]
    : [0, 0, 0];
  const safeFallbackRadius = Number.isFinite(fallbackRadius) && fallbackRadius > 0
    ? fallbackRadius
    : 3;
  const valid = sampledCenters.filter(finitePoint);
  if (valid.length === 0) {
    return {
      center: safeFallbackCenter,
      radius: Math.max(safeFallbackRadius, 0.25),
      clipRadius: Math.max(safeFallbackRadius, 3),
    };
  }

  const xs = valid.map((point) => point.x).sort((a, b) => a - b);
  const ys = valid.map((point) => point.y).sort((a, b) => a - b);
  const zs = valid.map((point) => point.z).sort((a, b) => a - b);
  const trim = valid.length >= 50 ? WORLD_NAVIGATION_TRIM_FRACTION : 0;
  const minX = quantile(xs, trim);
  const maxX = quantile(xs, 1 - trim);
  const minY = quantile(ys, trim);
  const maxY = quantile(ys, 1 - trim);
  const minZ = quantile(zs, trim);
  const maxZ = quantile(zs, 1 - trim);
  const center: [number, number, number] = [
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5,
    (minZ + maxZ) * 0.5,
  ];
  const radius = Math.max((maxX - minX) * 0.5, (maxZ - minZ) * 0.5, 0.25);
  const sampledClipRadius = valid.reduce((maximum, point) => Math.max(
    maximum,
    Math.hypot(point.x - center[0], point.y - center[1], point.z - center[2]),
  ), 0);

  return {
    center,
    radius,
    clipRadius: Math.max(sampledClipRadius, radius, safeFallbackRadius, 3),
  };
}

/** Reset at a known capture origin, otherwise use the sampled grounded fallback. */
export function worldCameraPose(bounds: WorldSceneBounds): WorldCameraPose {
  const radius = Math.max(bounds.radius, 0.25);
  const lookDistance = MathUtils.clamp(radius * 0.18, 2.5, 8);
  const position: [number, number, number] = bounds.resetPosition
    ? [...bounds.resetPosition]
    : [bounds.center[0], WORLD_EYE_HEIGHT_METERS, bounds.center[2]];
  const target: [number, number, number] = bounds.resetTarget ? [...bounds.resetTarget] : [
    position[0],
    position[1],
    position[2] - lookDistance,
  ];
  const clipRadius = Math.max(bounds.clipRadius, radius);

  return {
    position,
    target,
    near: MathUtils.clamp(radius / 20_000, 0.005, 0.05),
    far: Math.max(clipRadius * 4, radius * 30, 1_000),
  };
}

export function placeWorldCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  bounds: WorldSceneBounds,
): void {
  const pose = worldCameraPose(bounds);
  target.set(...pose.target);
  camera.position.set(...pose.position);
  camera.near = pose.near;
  camera.far = pose.far;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

export function worldOrbitMaxDistance(radius: number): number {
  return Math.max(Number.isFinite(radius) ? radius * 4 : 0, 20);
}

export function worldFlySpeedMetersPerSecond(radius: number): number {
  return MathUtils.clamp(Number.isFinite(radius) ? radius * 0.18 : 0, 0.8, 6);
}

export function worldFlyGestureScale(radius: number): number {
  return MathUtils.clamp(Number.isFinite(radius) ? radius * 0.06 : 0, 0.08, 0.75);
}

export function syncWorldFlyAngles(
  camera: PerspectiveCamera,
  euler: Euler,
  yawPitch: Vector2,
): void {
  euler.setFromQuaternion(camera.quaternion, 'YXZ');
  yawPitch.set(euler.y, euler.x);
}

/** How an object (a World v2 object splat: Idol) opens: a 3/4 view from its
 * front, YAW_DEGREES off-axis and PITCH_DEGREES above (GM, PR #203 r1), at
 * the distance where its bounding sphere fits the narrower half of the view
 * with MARGIN to spare. No auto-rotate. */
export const OBJECT_VIEW_YAW_DEGREES = 30;
export const OBJECT_VIEW_PITCH_DEGREES = 15;
/** Measured live on the Space's backpack example (PR #203 round 2): 1.15
 * filled 69% of the stage's height, 1.3 brings a typical object to about
 * 60% (GM). A shape that fills its bounding sphere (a ball) comes out
 * larger, about 75%. */
export const OBJECT_VIEW_MARGIN = 1.3;
/** Orbit may zoom out to this many framing distances. */
export const OBJECT_ORBIT_MAX_DISTANCE_FACTOR = 4;
/** The share of sampled centers the object's radius must hold: floaters
 * past the 98th percentile don't push the camera back. */
const OBJECT_RADIUS_QUANTILE = 0.98;

export interface ObjectFraming {
  center: [number, number, number];
  /** The object's robust 3D radius, Y included (the environment bounds'
   * `radius` is horizontal only and never under 0.25). */
  radius: number;
  distance: number;
  resetPosition: [number, number, number];
  resetTarget: [number, number, number];
  orbitMaxDistance: number;
}

/** The object's robust bounding sphere from the sampled centers: the trimmed
 * box's center (as robustWorldSceneBounds takes it, Y included) and the
 * 98th-percentile distance from it. */
export function objectBoundingSphere(
  sampledCenters: readonly WorldPoint[],
  fallbackCenter: WorldPoint = { x: 0, y: 0, z: 0 },
): { center: [number, number, number]; radius: number } {
  const valid = sampledCenters.filter(finitePoint);
  const center = robustWorldSceneBounds(valid, fallbackCenter).center;
  if (valid.length === 0) return { center, radius: 0.5 };
  const distances = valid
    .map((point) => Math.hypot(point.x - center[0], point.y - center[1], point.z - center[2]))
    .sort((a, b) => a - b);
  return { center, radius: Math.max(quantile(distances, OBJECT_RADIUS_QUANTILE), 0.01) };
}

/** Where the reset camera stands for an object: `front` (a unit vector in
 * Three's +Y-up frame, the object's forward axis) turned `yawDegrees` about
 * +Y and raised `pitchDegrees`, at r / sin(half the narrower field of view)
 * x `margin` from the center. `fovDegrees` is the camera's vertical field
 * of view and `aspect` the stage's width over height. */
export function objectFraming(
  sampledCenters: readonly WorldPoint[],
  front: readonly [number, number, number],
  {
    fovDegrees,
    aspect,
    yawDegrees = OBJECT_VIEW_YAW_DEGREES,
    pitchDegrees = OBJECT_VIEW_PITCH_DEGREES,
    margin = OBJECT_VIEW_MARGIN,
    fallbackCenter,
  }: {
    fovDegrees: number;
    aspect: number;
    yawDegrees?: number;
    pitchDegrees?: number;
    margin?: number;
    fallbackCenter?: WorldPoint;
  },
): ObjectFraming {
  const { center, radius } = objectBoundingSphere(sampledCenters, fallbackCenter);
  const halfVertical = MathUtils.degToRad(Number.isFinite(fovDegrees) && fovDegrees > 0 ? fovDegrees : 58) / 2;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * safeAspect);
  const halfFov = Math.min(halfVertical, halfHorizontal);
  const distance = (radius / Math.sin(halfFov)) * margin;

  const forward = new Vector3(front[0], 0, front[2]);
  if (forward.lengthSq() < 1e-9) forward.set(0, 0, 1);
  forward.normalize();
  forward.applyAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(yawDegrees));
  const pitch = MathUtils.degToRad(pitchDegrees);
  const direction = forward.multiplyScalar(Math.cos(pitch)).add(new Vector3(0, Math.sin(pitch), 0));
  const resetPosition: [number, number, number] = [
    center[0] + direction.x * distance,
    center[1] + direction.y * distance,
    center[2] + direction.z * distance,
  ];
  return {
    center,
    radius,
    distance,
    resetPosition,
    resetTarget: [...center],
    orbitMaxDistance: distance * OBJECT_ORBIT_MAX_DISTANCE_FACTOR,
  };
}
