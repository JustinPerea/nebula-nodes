// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PORT_DATA_TYPES } from '../../src/constants/ports';
import {
  COMPATIBILITY,
  PORT_COLORS,
  isPortCompatible,
} from '../../src/lib/portCompatibility';
import type { PortDataType } from '../../src/types';

const SPATIAL_PORT_TYPES = [
  'CameraPose',
  'CameraPath',
  'SpatialContext',
  'DepthMap',
  'DepthSequence',
  'PointCloud',
  'SensorRig',
  'SensorStream',
  'SpatialSession',
] as const satisfies readonly PortDataType[];

describe('spatial port compatibility', () => {
  it('registers every spatial type with a visible color and exact self/Any compatibility', () => {
    for (const type of SPATIAL_PORT_TYPES) {
      expect(PORT_DATA_TYPES).toContain(type);
      expect(PORT_COLORS[type]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(COMPATIBILITY[type]).toEqual([type, 'Any']);
      expect(isPortCompatible(type, type)).toBe(true);
      expect(isPortCompatible(type, 'Any')).toBe(true);
      expect(isPortCompatible('Any', type)).toBe(true);
    }
  });

  it('does not broadly cross-wire distinct spatial contracts or legacy World', () => {
    for (const source of SPATIAL_PORT_TYPES) {
      for (const target of SPATIAL_PORT_TYPES) {
        expect(isPortCompatible(source, target)).toBe(source === target);
      }
      expect(isPortCompatible(source, 'World')).toBe(false);
      expect(isPortCompatible('World', source)).toBe(false);
    }
  });
});
