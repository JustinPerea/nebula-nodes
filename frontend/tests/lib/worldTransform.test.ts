// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  marbleRawToThreeMatrix,
  marbleRawToThreeTransform,
} from '../../src/lib/worldTransform';

describe('Marble raw OpenCV to Three/Spark transform', () => {
  it('scales and grounds in raw space before applying Rx(pi)', () => {
    const matrix = marbleRawToThreeMatrix(2, 3);
    const transformed = new Vector3(1, 4, 5).applyMatrix4(matrix);

    // R_x(pi) * T_y(-3) * S(2): (2, 5, 10) -> (2, -5, -10).
    expect(transformed.x).toBeCloseTo(2, 8);
    expect(transformed.y).toBeCloseTo(-5, 8);
    expect(transformed.z).toBeCloseTo(-10, 8);
  });

  it('uses neutral defaults for invalid or absent semantics metadata', () => {
    expect(marbleRawToThreeTransform(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      scale: 1,
      position: [0, 0, 0],
      rotation: [Math.PI, 0, 0],
    });
  });
});
