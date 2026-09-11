import type {
  CameraPath,
  CameraPose,
  DepthMap,
  DepthSequence,
  PointCloud,
  SensorRig,
  SensorStream,
  SpatialContext,
  SpatialSessionMetadata,
  WorldValueV2,
} from '../types/spatial';
import type { PortDataType, PortValue, WorldValue } from '../types';
import {
  parseCameraPath,
  parseCameraPose,
  parseDepthMap,
  parseDepthSequence,
  parsePointCloud,
  parseSensorRig,
  parseSensorStream,
  parseSpatialContext,
  parseSpatialSessionMetadata,
  parseWorldValueV2,
} from './spatialValue';
import { parseWorldValue } from './worldValue';

export type StructuredRepresentationType =
  | 'World'
  | 'CameraPose'
  | 'CameraPath'
  | 'SpatialContext'
  | 'DepthMap'
  | 'DepthSequence'
  | 'PointCloud'
  | 'SensorRig'
  | 'SensorStream'
  | 'SpatialSession';

export type WorldRepresentation =
  | { readonly version: 1; readonly value: WorldValue }
  | { readonly version: 2; readonly value: WorldValueV2 };

export interface ParsedRepresentationMap {
  readonly World: WorldRepresentation;
  readonly CameraPose: CameraPose;
  readonly CameraPath: CameraPath;
  readonly SpatialContext: SpatialContext;
  readonly DepthMap: DepthMap;
  readonly DepthSequence: DepthSequence;
  readonly PointCloud: PointCloud;
  readonly SensorRig: SensorRig;
  readonly SensorStream: SensorStream;
  readonly SpatialSession: SpatialSessionMetadata;
}

export type ParsedRepresentation = {
  [Type in StructuredRepresentationType]: {
    readonly type: Type;
    readonly value: ParsedRepresentationMap[Type];
  };
}[StructuredRepresentationType];

interface RepresentationViewerDefinition<T> {
  readonly label: string;
  readonly parse: (value: unknown) => T | null;
}

type RepresentationViewerRegistry = {
  readonly [Type in StructuredRepresentationType]: RepresentationViewerDefinition<ParsedRepresentationMap[Type]>;
};

/**
 * Structured values are considered only after Nebula's established visual
 * media order (World, Video, Image/SVG, Mesh, Audio). This ordering is shared
 * by every surface that opts into the registry.
 */
export const STRUCTURED_REPRESENTATION_PRIORITY: readonly StructuredRepresentationType[] = Object.freeze([
  'World',
  'CameraPose',
  'CameraPath',
  'SpatialContext',
  'DepthMap',
  'DepthSequence',
  'PointCloud',
  'SensorRig',
  'SensorStream',
  'SpatialSession',
]);

const NON_WORLD_REPRESENTATION_TYPES = STRUCTURED_REPRESENTATION_PRIORITY.filter(
  (type): type is Exclude<StructuredRepresentationType, 'World'> => type !== 'World',
);

function parseWorldRepresentation(value: unknown): WorldRepresentation | null {
  const current = parseWorldValueV2(value);
  if (current) return { version: 2, value: current };
  const legacy = parseWorldValue(value);
  return legacy ? { version: 1, value: legacy } : null;
}

/**
 * The single acceptance registry for structured spatial output rendering.
 * Every viewer calls one of these strict parsers before it receives a value.
 */
export const REPRESENTATION_VIEWER_REGISTRY: RepresentationViewerRegistry = Object.freeze({
  World: { label: 'World', parse: parseWorldRepresentation },
  CameraPose: { label: 'Camera pose', parse: parseCameraPose },
  CameraPath: { label: 'Camera path', parse: parseCameraPath },
  SpatialContext: { label: 'Spatial context', parse: parseSpatialContext },
  DepthMap: { label: 'Depth map', parse: parseDepthMap },
  DepthSequence: { label: 'Depth sequence', parse: parseDepthSequence },
  PointCloud: { label: 'Point cloud', parse: parsePointCloud },
  SensorRig: { label: 'Sensor rig', parse: parseSensorRig },
  SensorStream: { label: 'Sensor stream', parse: parseSensorStream },
  SpatialSession: { label: 'Spatial session', parse: parseSpatialSessionMetadata },
});

export function hasRepresentationViewer(type: PortDataType): type is StructuredRepresentationType {
  return Object.prototype.hasOwnProperty.call(REPRESENTATION_VIEWER_REGISTRY, type);
}

export function parseRepresentation(type: PortDataType, value: unknown): ParsedRepresentation | null {
  if (!hasRepresentationViewer(type)) return null;
  switch (type) {
    case 'World': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.World.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'CameraPose': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.CameraPose.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'CameraPath': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.CameraPath.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'SpatialContext': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.SpatialContext.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'DepthMap': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.DepthMap.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'DepthSequence': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.DepthSequence.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'PointCloud': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.PointCloud.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'SensorRig': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.SensorRig.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'SensorStream': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.SensorStream.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
    case 'SpatialSession': {
      const parsed = REPRESENTATION_VIEWER_REGISTRY.SpatialSession.parse(value);
      return parsed ? { type, value: parsed } : null;
    }
  }
}

export function findStructuredRepresentation(
  outputs: Readonly<Record<string, PortValue>>,
  options: { readonly includeWorld?: boolean } = {},
): PortValue | undefined {
  const priority = options.includeWorld === false
    ? NON_WORLD_REPRESENTATION_TYPES
    : STRUCTURED_REPRESENTATION_PRIORITY;
  for (const type of priority) {
    const output = Object.values(outputs).find((candidate) => (
      candidate.type === type && candidate.value != null
    ));
    if (output) return output;
  }
  return undefined;
}
