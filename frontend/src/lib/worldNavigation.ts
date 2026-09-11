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
  const target: [number, number, number] = [
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
