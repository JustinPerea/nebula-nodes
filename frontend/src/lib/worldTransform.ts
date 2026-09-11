import { Matrix4, Quaternion, Vector3 } from 'three';

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
