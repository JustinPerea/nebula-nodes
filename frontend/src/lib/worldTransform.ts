import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

export const MARBLE_RAW_OPENCV_FRAME = 'marble_raw_opencv';

export interface MarbleThreeTransform {
  scale: number;
  position: [number, number, number];
  rotation: [number, number, number];
}

/**
 * Build the object transform for Marble API splats.
 *
 * Provider points are first converted to metric scale and grounded in their
 * raw OpenCV frame, then rotated 180 degrees around X for Three/Spark. Three
 * composes objects as T * R * S, so the post-rotation translation is +offset
 * on Y (equivalent to R_x(pi) * T_y(-offset) * S).
 */
export function marbleRawToThreeTransform(
  metricScaleFactor?: number,
  groundPlaneOffset?: number,
): MarbleThreeTransform {
  const scale = typeof metricScaleFactor === 'number'
    && Number.isFinite(metricScaleFactor)
    && metricScaleFactor > 0
    ? metricScaleFactor
    : 1;
  const offset = typeof groundPlaneOffset === 'number' && Number.isFinite(groundPlaneOffset)
    ? groundPlaneOffset
    : 0;

  return {
    scale,
    position: [0, offset, 0],
    rotation: [Math.PI, 0, 0],
  };
}

/** Matrix form used by focused tests and future non-Three spatial consumers. */
export function marbleRawToThreeMatrix(
  metricScaleFactor?: number,
  groundPlaneOffset?: number,
): Matrix4 {
  const transform = marbleRawToThreeTransform(metricScaleFactor, groundPlaneOffset);
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), transform.rotation[0]),
    new Vector3(transform.scale, transform.scale, transform.scale),
  );
}

export type WorldAxis = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';

/** The rotation (XYZ Euler, radians) that turns a frame whose up is `upAxis`
 * into Three's +Y-up frame. A World v2 value says its up axis
 * (CoordinateSystem.upAxis): Idol's PLY is -Y up, like Marble's OpenCV
 * splats, so it turns 180 degrees about X. */
export function upAxisToThreeRotation(upAxis: WorldAxis): [number, number, number] {
  switch (upAxis) {
    case 'y': return [0, 0, 0];
    case '-y': return [Math.PI, 0, 0];
    case 'z': return [-Math.PI / 2, 0, 0];
    case '-z': return [Math.PI / 2, 0, 0];
    case 'x': return [0, 0, Math.PI / 2];
    case '-x': return [0, 0, -Math.PI / 2];
  }
}

/** A frame's forward axis as a unit vector after upAxisToThreeRotation: the
 * side an object faces, where the reset camera stands. */
export function forwardInThree(upAxis: WorldAxis, forwardAxis: WorldAxis): [number, number, number] {
  const sign = forwardAxis.startsWith('-') ? -1 : 1;
  const axis = forwardAxis.replace('-', '');
  const vector = new Vector3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
  const [x, y, z] = upAxisToThreeRotation(upAxis);
  vector.applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(x, y, z, 'XYZ')));
  const clean = (value: number) => (Math.abs(value) < 1e-9 ? 0 : Math.round(value * 1e9) / 1e9);
  return [clean(vector.x), clean(vector.y), clean(vector.z)];
}
