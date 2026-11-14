// @vitest-environment node
import { Euler, Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  OBJECT_ORBIT_MAX_DISTANCE_FACTOR,
  OBJECT_ORBIT_MIN_RADIUS_FACTOR,
  OBJECT_VIEW_MARGIN,
  objectBoundingSphere,
  objectFraming,
  WORLD_EYE_HEIGHT_METERS,
  WORLD_NAVIGATION_SAMPLE_LIMIT,
  placeWorldCamera,
  robustWorldSceneBounds,
  sampleWorldSplatCenters,
  sampleWorldSplatExtents,
  syncWorldFlyAngles,
  worldCameraPose,
  worldFlyGestureScale,
  worldFlySpeedMetersPerSecond,
} from '../../src/lib/worldNavigation';

describe('World environment navigation geometry', () => {
  it('keeps isolated splat outliers out of the navigation envelope', () => {
    const room = Array.from({ length: 100 }, (_, index) => ({
      x: (index % 10) - 4.5,
      y: Math.floor(index / 50) * 3,
      z: Math.floor(index / 10) - 4.5,
    }));
    const bounds = robustWorldSceneBounds(
      [...room, { x: 10_000, y: 500, z: -8_000 }],
      { x: 4_997.75, y: 250, z: -3_997.25 },
      9_000,
    );

    expect(Math.abs(bounds.center[0])).toBeLessThan(1);
    expect(Math.abs(bounds.center[2])).toBeLessThan(1);
    expect(bounds.radius).toBeLessThan(8);
    // A sampled outlier can extend clipping, but cannot steer the robust center.
    expect(bounds.clipRadius).toBeGreaterThan(9_000);
  });

  it('caps indexed reads for a 500K PackedSplats source', () => {
    const indexes: number[] = [];
    const centers = sampleWorldSplatCenters({
      getNumSplats: () => 500_000,
      getSplat: (index) => {
        indexes.push(index);
        return { center: { x: index, y: 0, z: -index }, opacity: 1 };
      },
    }, new Matrix4());

    expect(indexes).toHaveLength(WORLD_NAVIGATION_SAMPLE_LIMIT);
    expect(centers).toHaveLength(WORLD_NAVIGATION_SAMPLE_LIMIT);
    expect(indexes[0]).toBe(0);
    expect(indexes.at(-1)).toBe(499_999);
    expect(new Set(indexes).size).toBe(WORLD_NAVIGATION_SAMPLE_LIMIT);
  });

  it('places reset inside the horizontal envelope at grounded human eye height', () => {
    const pose = worldCameraPose({
      center: [4, 18, -7],
      radius: 12,
      clipRadius: 30,
    });

    expect(pose.position).toEqual([4, WORLD_EYE_HEIGHT_METERS, -7]);
    expect(pose.target[0]).toBe(pose.position[0]);
    expect(pose.target[1]).toBe(pose.position[1]);
    expect(pose.target[2]).toBeLessThan(pose.position[2]);
    expect(pose.far).toBeGreaterThanOrEqual(1_000);
  });

  it('resets a transformed Marble raw frame at its nonzero capture-origin offset facing -Z', () => {
    const camera = new PerspectiveCamera(58, 1, 0.01, 10_000);
    const target = new Vector3();
    const bounds = {
      center: [90, 40, -75] as [number, number, number],
      radius: 12,
      clipRadius: 30,
      resetPosition: [0, 2.75, 0] as [number, number, number],
    };

    placeWorldCamera(camera, target, bounds);

    expect(camera.position.toArray()).toEqual([0, 2.75, 0]);
    expect(target.x).toBe(0);
    expect(target.y).toBe(2.75);
    expect(target.z).toBeLessThan(0);
    const direction = camera.getWorldDirection(new Vector3());
    expect(direction.x).toBeCloseTo(0, 8);
    expect(direction.y).toBeCloseTo(0, 8);
    expect(direction.z).toBeCloseTo(-1, 8);
  });

  it('synchronizes Fly angles to the asynchronously placed camera', () => {
    const camera = new PerspectiveCamera(58, 1, 0.01, 10_000);
    const target = new Vector3();
    placeWorldCamera(camera, target, {
      center: [12, 2, 30],
      radius: 10,
      clipRadius: 20,
    });
    const euler = new Euler(0, 0, 0, 'YXZ');
    const yawPitch = new Vector2(99, 99);

    syncWorldFlyAngles(camera, euler, yawPitch);

    const direction = camera.getWorldDirection(new Vector3());
    expect(direction.x).toBeCloseTo(0, 8);
    expect(direction.y).toBeCloseTo(0, 8);
    expect(direction.z).toBeCloseTo(-1, 8);
    expect(yawPitch.x).toBeCloseTo(0, 8);
    expect(yawPitch.y).toBeCloseTo(0, 8);
  });

  it('clamps movement and gesture scale when full-scene bounds are extreme', () => {
    expect(worldFlySpeedMetersPerSecond(0.01)).toBe(0.8);
    expect(worldFlySpeedMetersPerSecond(1_000_000)).toBe(6);
    expect(worldFlyGestureScale(0.01)).toBe(0.08);
    expect(worldFlyGestureScale(1_000_000)).toBe(0.75);
  });
});

describe('object framing (a World v2 object splat: Idol)', () => {
  // 200 points on the unit-ish shell of radius 0.5 around (1, 2, 3).
  const shell = Array.from({ length: 200 }, (_, index) => {
    const z = (index / 199) * 2 - 1;
    const ring = Math.sqrt(1 - z * z);
    const theta = index * 2.399963;
    return { x: 1 + Math.cos(theta) * ring * 0.5, y: 2 + Math.sin(theta) * ring * 0.5, z: 3 + z * 0.5 };
  });
  const rad = (degrees: number) => (degrees * Math.PI) / 180;

  it('stands at r / sin(half the narrower field of view) x margin', () => {
    const wide = objectFraming(shell, [1, 0, 0], { fovDegrees: 60, aspect: 16 / 9 });
    expect(wide.radius).toBeCloseTo(0.5, 1);
    // Landscape: the vertical half (30 degrees) is the narrower.
    expect(wide.distance).toBeCloseTo((wide.radius / Math.sin(rad(30))) * OBJECT_VIEW_MARGIN, 6);
    // Portrait: the horizontal half is the narrower, so it stands farther back.
    const tall = objectFraming(shell, [1, 0, 0], { fovDegrees: 60, aspect: 0.5 });
    const halfHorizontal = Math.atan(Math.tan(rad(30)) * 0.5);
    expect(tall.distance).toBeCloseTo((tall.radius / Math.sin(halfHorizontal)) * OBJECT_VIEW_MARGIN, 6);
    expect(tall.distance).toBeGreaterThan(wide.distance);
    expect(wide.orbitMaxDistance).toBeCloseTo(wide.distance * OBJECT_ORBIT_MAX_DISTANCE_FACTOR, 6);
  });

  it('views from 30 degrees off the front and 15 above, at the center', () => {
    const framed = objectFraming(shell, [1, 0, 0], { fovDegrees: 58, aspect: 1 });
    expect(framed.resetTarget).toEqual(framed.center);
    const offset = new Vector3(...framed.resetPosition).sub(new Vector3(...framed.center));
    expect(offset.length()).toBeCloseTo(framed.distance, 6);
    const direction = offset.normalize();
    expect(direction.y).toBeCloseTo(Math.sin(rad(15)), 6);
    expect(direction.x).toBeCloseTo(Math.cos(rad(15)) * Math.cos(rad(30)), 6);
    expect(direction.z).toBeCloseTo(-Math.cos(rad(15)) * Math.sin(rad(30)), 6);
    // Zero yaw and pitch: straight on from the front.
    const straight = objectFraming(shell, [0, 0, -1], { fovDegrees: 58, aspect: 1, yawDegrees: 0, pitchDegrees: 0 });
    const ahead = new Vector3(...straight.resetPosition).sub(new Vector3(...straight.center)).normalize();
    expect(ahead.toArray().map((value) => Number(value.toFixed(6)))).toEqual([0, 0, -1]);
  });

  it('flattens a tilted front and falls back to +Z for a vertical one', () => {
    const tilted = objectFraming(shell, [0, 0.9, 0.1], { fovDegrees: 58, aspect: 1, yawDegrees: 0, pitchDegrees: 0 });
    const tiltedDirection = new Vector3(...tilted.resetPosition).sub(new Vector3(...tilted.center)).normalize();
    expect(tiltedDirection.z).toBeCloseTo(1, 6);
    const vertical = objectFraming(shell, [0, 1, 0], { fovDegrees: 58, aspect: 1, yawDegrees: 0, pitchDegrees: 0 });
    const verticalDirection = new Vector3(...vertical.resetPosition).sub(new Vector3(...vertical.center)).normalize();
    expect(verticalDirection.z).toBeCloseTo(1, 6);
  });

  it('keeps a few far floaters from pushing the camera back', () => {
    const floaters = [...shell, { x: 40, y: 2, z: 3 }, { x: 1, y: -50, z: 3 }];
    expect(objectBoundingSphere(floaters).radius).toBeLessThan(0.6);
    expect(objectBoundingSphere([]).radius).toBe(0.5);
    // A degenerate fov or aspect still gives a finite distance.
    expect(Number.isFinite(objectFraming(shell, [1, 0, 0], { fovDegrees: Number.NaN, aspect: 0 }).distance)).toBe(true);
  });
});

describe('object framing at the extremes (PR #203 r2 review, LOW 1 to 3)', () => {
  const shellOf = (radius: number, center = { x: 0, y: 0, z: 0 }) => Array.from({ length: 200 }, (_, index) => {
    const z = (index / 199) * 2 - 1;
    const ring = Math.sqrt(1 - z * z);
    const theta = index * 2.399963;
    return { x: center.x + Math.cos(theta) * ring * radius, y: center.y + Math.sin(theta) * ring * radius,
      z: center.z + z * radius };
  });
  const options = { fovDegrees: 58, aspect: 4 / 3 };
  /** The camera is outside the object's sphere, and orbit can zoom out. */
  const outside = (framed: ReturnType<typeof objectFraming>) => {
    expect(framed.distance).toBeGreaterThan(framed.radius * 2);
    expect(framed.orbitMaxDistance).toBeGreaterThan(framed.distance);
    expect(framed.orbitMinDistance).toBeLessThan(framed.distance);
    expect(framed.near).toBeLessThan(framed.orbitMinDistance);
    expect(framed.far).toBeGreaterThanOrEqual(framed.orbitMaxDistance + 2 * framed.radius);
  };

  it('sizes one Gaussian by its own scale, not a 1 cm floor', () => {
    const one = objectFraming([{ x: 0.2, y: -0.1, z: 0.3 }], [1, 0, 0], { ...options, extents: [0.08] });
    // About 3 sigma of its largest scale.
    expect(one.radius).toBeCloseTo(0.24, 6);
    expect(one.center).toEqual([0.2, -0.1, 0.3]);
    outside(one);
  });

  it('sizes a splat whose centers are all equal by its Gaussians, and never opens inside it', () => {
    const same = Array.from({ length: 500 }, () => ({ x: 1, y: 1, z: 1 }));
    const extents = Array.from({ length: 500 }, (_, index) => 0.01 + (index % 10) * 0.004);
    const framed = objectFraming(same, [1, 0, 0], { ...options, extents });
    // The 98th percentile of the largest scales (0.046), times 3.
    expect(framed.radius).toBeCloseTo(0.046 * 3, 2);
    outside(framed);
    // With no sizes at all, the empty object's radius, not a point.
    expect(objectFraming(same, [1, 0, 0], options).radius).toBe(0.5);
  });

  it('leaves an ordinary object to its centers: its Gaussians are far smaller', () => {
    const shell = shellOf(0.5);
    const extents = shell.map(() => 0.01);
    expect(objectFraming(shell, [1, 0, 0], { ...options, extents }).radius)
      .toBeCloseTo(objectFraming(shell, [1, 0, 0], options).radius, 9);
  });

  it('frames a 1 mm object the way it frames a 1 m one, zoomable to a fifth of its radius', () => {
    const metre = objectFraming(shellOf(0.5), [1, 0, 0], options);
    const millimetre = objectFraming(shellOf(0.0005), [1, 0, 0], options);
    expect(millimetre.distance / metre.distance).toBeCloseTo(0.001, 6);
    expect(millimetre.orbitMinDistance).toBeCloseTo(millimetre.radius * OBJECT_ORBIT_MIN_RADIUS_FACTOR, 12);
    outside(millimetre);
    // worldCameraPose takes the object's clip planes, not an environment's 5 mm near plane.
    const pose = worldCameraPose({ center: millimetre.center, radius: 0.25, clipRadius: 3,
      resetPosition: millimetre.resetPosition, resetTarget: millimetre.resetTarget,
      near: millimetre.near, far: millimetre.far });
    expect(pose.near).toBe(millimetre.near);
    expect(pose.near).toBeLessThan(millimetre.distance - millimetre.radius);
  });

  it('keeps a 10 km object inside the far plane from the farthest zoom', () => {
    const big = objectFraming(shellOf(5_000, { x: 2e5, y: 0, z: 0 }), [1, 0, 0], options);
    outside(big);
    expect(big.far).toBeGreaterThan(1_000);
    const pose = worldCameraPose({ center: big.center, radius: big.radius, clipRadius: big.radius,
      resetPosition: big.resetPosition, resetTarget: big.resetTarget, near: big.near, far: big.far });
    expect(pose.far).toBeGreaterThanOrEqual(big.orbitMaxDistance + 2 * big.radius);
  });

  it('reads each Gaussian\'s largest scale in world units, with the centers\' cut', () => {
    const matrix = new Matrix4().makeScale(2, 2, 2);
    const splats = {
      getNumSplats: () => 3,
      getSplat: (index: number) => ({
        center: new Vector3(index, 0, 0),
        opacity: index === 1 ? 0 : 1,
        scales: new Vector3(0.01, 0.03 * (index + 1), 0.02),
      }),
    };
    expect(sampleWorldSplatExtents(splats, matrix)).toEqual([0.06, 0.18]);
    expect(sampleWorldSplatExtents({ ...splats, getSplat: (index) => ({ center: new Vector3(index, 0, 0), opacity: 1 }) },
      matrix)).toEqual([]);
  });
});
