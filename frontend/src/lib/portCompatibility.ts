import type { PortDataType } from '../types';
import portRules from './portRules.json';

export const PORT_COLORS: Record<PortDataType, string> = {
  Image: '#4CAF50',
  Video: '#F44336',
  Text: '#9C27B0',
  Array: '#2196F3',
  Audio: '#FFC107',
  Mask: '#8BC34A',
  SVG: '#795548',
  Mesh: '#00BCD4',
  World: '#22D3EE',
  CameraPose: '#60A5FA',
  CameraPath: '#818CF8',
  SpatialContext: '#A78BFA',
  DepthMap: '#0EA5E9',
  DepthSequence: '#0284C7',
  PointCloud: '#14B8A6',
  SensorRig: '#F97316',
  SensorStream: '#FB7185',
  SpatialSession: '#94A3B8',
  Character: '#a78bfa',
  Moodboard: '#f59e0b',
  CameraRig: '#64b5f6',
  ReferenceSet: '#ec407a',
  Any: '#9E9E9E',
};

/**
 * Which output types may feed which input types: one rule shared with the
 * backend (backend/data/port_rules.json; the same bytes as ./portRules.json,
 * pinned by a test on each side), so the tab's checks and the server's
 * connect route can't differ (PR #199 round 17). An output fits an input when
 * either is Any, they're the same type, or the pair is listed in
 * alsoCompatible (either way round).
 */
export const PORT_RULES: {
  types: string[];
  any: string;
  alsoCompatible: [string, string][];
  droppedConnectionKinds: string[];
} = portRules as never;

export function portTypesCompatible(sourceType: string, targetType: string): boolean {
  return sourceType === PORT_RULES.any || targetType === PORT_RULES.any || sourceType === targetType
    || PORT_RULES.alsoCompatible.some(([a, b]) => (a === sourceType && b === targetType) || (a === targetType && b === sourceType));
}

/** Each type's inputs it can feed, from the shared rule: itself first, its
 * listed partners, then Any (Any feeds every type). */
export const COMPATIBILITY: Record<PortDataType, PortDataType[]> = Object.fromEntries(
  (PORT_RULES.types as PortDataType[]).map((type) => [type, type === PORT_RULES.any
    ? [...PORT_RULES.types] as PortDataType[]
    : [type, ...(PORT_RULES.types as PortDataType[]).filter((other) => other !== type && other !== PORT_RULES.any
      && portTypesCompatible(type, other)), PORT_RULES.any as PortDataType]]),
) as Record<PortDataType, PortDataType[]>;

export function isPortCompatible(
  sourceType: PortDataType,
  targetType: PortDataType
): boolean {
  return portTypesCompatible(sourceType, targetType);
}
