// @vitest-environment node
import { Euler, Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  WORLD_EYE_HEIGHT_METERS,
  WORLD_NAVIGATION_SAMPLE_LIMIT,
  placeWorldCamera,
  robustWorldSceneBounds,
  sampleWorldSplatCenters,
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
