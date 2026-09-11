import type { WorldValue } from '../types';
import {
  MAX_CAMERA_INTRINSIC_MAGNITUDE,
  MAX_CAMERA_PATH_POSES,
  MAX_DEPTH_SEQUENCE_FRAMES,
  MAX_POINT_CLOUD_POINTS,
  MAX_SENSOR_RIG_SENSORS,
  MAX_SENSOR_STREAM_SAMPLES,
  MAX_SPATIAL_ASSET_URI_CHARS,
  MAX_SPATIAL_CONTEXT_ANCHORS,
  MAX_SPATIAL_ID_CHARS,
  MAX_SPATIAL_IMAGE_DIMENSION,
  MAX_SPATIAL_LABEL_CHARS,
  MAX_SPATIAL_METADATA_CHARS,
  MAX_SPATIAL_TAG_CHARS,
  MAX_SPATIAL_TAGS,
  MAX_WORLD_SPLAT_REPRESENTATIONS,
  type AxisDirection,
  type CameraIntrinsics,
  type CameraPath,
  type CameraPathInterpolation,
  type CameraPose,
  type CoordinateSystem,
  type DepthEncoding,
  type DepthMap,
  type DepthSequence,
  type LocalAssetReference,
  type PointCloud,
  type PointCloudFormat,
  type SensorDefinition,
  type SensorModality,
  type SensorRig,
  type SensorSample,
  type SensorStream,
  type SpatialAnchor,
  type SpatialAnchorRole,
  type SpatialContext,
  type SpatialHandedness,
  type SpatialSessionMetadata,
  type SpatialSessionSource,
  type SpatialUnit,
  type WorldSplatFormat,
  type WorldSplatRepresentation,
  type WorldValueV2,
} from '../types/spatial';
import { parseWorldValue } from './worldValue';

type UnknownRecord = Record<string, unknown>;
type Vec3 = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];

const AXIS_DIRECTIONS = new Set<AxisDirection>(['x', '-x', 'y', '-y', 'z', '-z']);
const HANDEDNESS = new Set<SpatialHandedness>(['right', 'left']);
const SPATIAL_UNITS = new Set<SpatialUnit>(['meters', 'centimeters', 'millimeters', 'custom']);
const CAMERA_INTERPOLATIONS = new Set<CameraPathInterpolation>(['linear', 'step', 'catmull-rom']);
const ANCHOR_ROLES = new Set<SpatialAnchorRole>(['reference', 'observation', 'target']);
const DEPTH_ENCODINGS = new Set<DepthEncoding>(['float32', 'uint16', 'uint8']);
const POINT_CLOUD_FORMATS = new Set<PointCloudFormat>(['ply', 'pcd', 'las', 'laz', 'xyz']);
const SENSOR_MODALITIES = new Set<SensorModality>(['rgb', 'depth', 'rgbd', 'lidar', 'imu']);
const SESSION_SOURCES = new Set<SpatialSessionSource>([
  'generated',
  'reconstructed',
  'captured',
  'simulated',
  'imported',
]);
const SPLAT_FORMATS = new Set<WorldSplatFormat>(['spz', 'ply']);
const STANDARD_METERS_PER_UNIT: Readonly<Partial<Record<SpatialUnit, number>>> = {
  meters: 1,
  centimeters: 0.01,
  millimeters: 0.001,
};
const QUATERNION_MIN_NORM = 1e-12;

class SpatialValueError extends Error {}

function invalid(path: string, message: string): never {
  throw new SpatialValueError(`${path}: ${message}`);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string): UnknownRecord {
  if (!isPlainRecord(value)) invalid(path, 'must be a plain object');
  return value;
}

function exactKeys(
  value: UnknownRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is not allowed by this schema version');
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(`${path}.${key}`, 'is required');
  }
}

function literal<T extends string | number>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) invalid(path, `must be ${JSON.stringify(expected)}`);
  return expected;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) invalid(path, 'has an unsupported value');
  return value as T;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Array.from(value).length > maximum
    || value !== value.trim()
    || hasControlCharacters(value)
  ) {
    invalid(path, `must be a trimmed string between 1 and ${maximum} characters`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'must be finite');
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (parsed < 0) invalid(path, 'must be non-negative');
  return parsed;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  const parsed = finiteNumber(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean');
  return value;
}

function arrayValue(
  value: unknown,
  path: string,
  maximum: number,
  options: { readonly nonEmpty?: boolean } = {},
): unknown[] {
  const nonEmpty = options.nonEmpty ?? true;
  if (!Array.isArray(value)) invalid(path, 'must be an array');
  if (nonEmpty && value.length === 0) invalid(path, 'must not be empty');
  if (value.length > maximum) invalid(path, `must contain at most ${maximum} items`);
  return value;
}

function vec3(value: unknown, path: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) invalid(path, 'must contain exactly 3 numbers');
  return [
    finiteNumber(value[0], `${path}[0]`),
    finiteNumber(value[1], `${path}[1]`),
    finiteNumber(value[2], `${path}[2]`),
  ];
}

function normalizedQuaternion(value: unknown, path: string): Quaternion {
  if (!Array.isArray(value) || value.length !== 4) invalid(path, 'must contain exactly 4 numbers');
  const components = value.map((component, index) => finiteNumber(component, `${path}[${index}]`));
  const norm = Math.hypot(...components);
  if (!Number.isFinite(norm) || norm <= QUATERNION_MIN_NORM) {
    invalid(path, 'must be a non-zero normalizable quaternion');
  }
  return [
    components[0] / norm,
    components[1] / norm,
    components[2] / norm,
    components[3] / norm,
  ];
}

function assertUniqueIds(values: readonly { id: string }[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) invalid(path, `contains duplicate id ${JSON.stringify(value.id)}`);
    seen.add(value.id);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as UnknownRecord)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseWith<T>(reader: (value: unknown, path: string) => T, value: unknown): T | null {
  try {
    return deepFreeze(reader(value, '$'));
  } catch (error) {
    if (error instanceof SpatialValueError) return null;
    throw error;
  }
}

function readCoordinateSystem(value: unknown, path: string): CoordinateSystem {
  const raw = record(value, path);
  exactKeys(raw, path, [
    'schemaVersion',
    'kind',
    'id',
    'handedness',
    'upAxis',
    'forwardAxis',
    'unit',
    'metersPerUnit',
    'originMeters',
  ]);
  const unit = enumValue(raw.unit, SPATIAL_UNITS, `${path}.unit`);
  const metersPerUnit = finiteNumber(raw.metersPerUnit, `${path}.metersPerUnit`);
  if (metersPerUnit <= 0) invalid(`${path}.metersPerUnit`, 'must be greater than zero');
  const canonicalScale = STANDARD_METERS_PER_UNIT[unit];
  if (canonicalScale !== undefined && metersPerUnit !== canonicalScale) {
    invalid(`${path}.metersPerUnit`, `must equal ${canonicalScale} for ${unit}`);
  }
  const upAxis = enumValue(raw.upAxis, AXIS_DIRECTIONS, `${path}.upAxis`);
  const forwardAxis = enumValue(raw.forwardAxis, AXIS_DIRECTIONS, `${path}.forwardAxis`);
  if (upAxis.replace('-', '') === forwardAxis.replace('-', '')) {
    invalid(path, 'upAxis and forwardAxis must use different axes');
  }
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'coordinate-system', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    handedness: enumValue(raw.handedness, HANDEDNESS, `${path}.handedness`),
    upAxis,
    forwardAxis,
    unit,
    metersPerUnit,
    originMeters: vec3(raw.originMeters, `${path}.originMeters`),
  };
}

function sameCoordinateSystem(left: CoordinateSystem, right: CoordinateSystem): boolean {
  return left.id === right.id
    && left.handedness === right.handedness
    && left.upAxis === right.upAxis
    && left.forwardAxis === right.forwardAxis
    && left.unit === right.unit
    && left.metersPerUnit === right.metersPerUnit
    && left.originMeters.every((component, index) => component === right.originMeters[index]);
}

function requireCoordinateSystem(
  actual: CoordinateSystem,
  expected: CoordinateSystem,
  path: string,
): void {
  if (!sameCoordinateSystem(actual, expected)) invalid(path, 'uses a mixed coordinate frame or unit');
}

function readLocalAssetReference(value: unknown, path: string): LocalAssetReference {
  const raw = record(value, path);
  exactKeys(raw, path, ['id', 'uri', 'mediaType'], ['byteLength']);
  const uri = boundedString(raw.uri, `${path}.uri`, MAX_SPATIAL_ASSET_URI_CHARS);
  if (!uri.startsWith('/api/outputs/') || uri.includes('?') || uri.includes('#')) {
    invalid(`${path}.uri`, 'must be an unsigned relative /api/outputs/ path');
  }
  const encodedSegments = uri.slice('/api/outputs/'.length).split('/');
  let segments: string[];
  try {
    segments = encodedSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    invalid(`${path}.uri`, 'contains malformed URL encoding');
  }
  if (
    segments.length === 0
    || segments.some((segment) => (
      !segment
      || segment === '.'
      || segment === '..'
      || hasControlCharacters(segment)
      || segment.includes('/')
      || segment.includes('\\')
      || segment.includes('?')
      || segment.includes('#')
    ))
  ) {
    invalid(`${path}.uri`, 'contains an empty or traversing path segment');
  }
  const mediaType = boundedString(raw.mediaType, `${path}.mediaType`, MAX_SPATIAL_METADATA_CHARS);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+*-]*$/i.test(mediaType)) {
    invalid(`${path}.mediaType`, 'must be a MIME media type');
  }
  const byteLength = raw.byteLength == null
    ? undefined
    : boundedInteger(raw.byteLength, `${path}.byteLength`, 1, Number.MAX_SAFE_INTEGER);
  return {
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    uri,
    mediaType,
    ...(byteLength === undefined ? {} : { byteLength }),
  };
}

function readCameraIntrinsics(value: unknown, path: string): CameraIntrinsics {
  const raw = record(value, path);
  exactKeys(raw, path, ['model', 'width', 'height', 'fx', 'fy', 'cx', 'cy'], ['skew']);
  const width = boundedInteger(raw.width, `${path}.width`, 1, MAX_SPATIAL_IMAGE_DIMENSION);
  const height = boundedInteger(raw.height, `${path}.height`, 1, MAX_SPATIAL_IMAGE_DIMENSION);
  const fx = finiteNumber(raw.fx, `${path}.fx`);
  const fy = finiteNumber(raw.fy, `${path}.fy`);
  if (fx <= 0 || fx > MAX_CAMERA_INTRINSIC_MAGNITUDE) invalid(`${path}.fx`, 'is outside the supported range');
  if (fy <= 0 || fy > MAX_CAMERA_INTRINSIC_MAGNITUDE) invalid(`${path}.fy`, 'is outside the supported range');
  const cx = finiteNumber(raw.cx, `${path}.cx`);
  const cy = finiteNumber(raw.cy, `${path}.cy`);
  if (cx < 0 || cx > width) invalid(`${path}.cx`, 'must be within the image width');
  if (cy < 0 || cy > height) invalid(`${path}.cy`, 'must be within the image height');
  const skew = raw.skew == null ? undefined : finiteNumber(raw.skew, `${path}.skew`);
  if (skew !== undefined && Math.abs(skew) > MAX_CAMERA_INTRINSIC_MAGNITUDE) {
    invalid(`${path}.skew`, 'is outside the supported range');
  }
  return {
    model: literal(raw.model, 'pinhole', `${path}.model`),
    width,
    height,
    fx,
    fy,
    cx,
    cy,
    ...(skew === undefined ? {} : { skew }),
  };
}

function readCameraPose(value: unknown, path: string): CameraPose {
  const raw = record(value, path);
  exactKeys(raw, path, [
    'schemaVersion',
    'kind',
    'id',
    'coordinateSystem',
    'position',
    'orientation',
  ], ['intrinsics', 'timestampSeconds']);
  const intrinsics = raw.intrinsics == null
    ? undefined
    : readCameraIntrinsics(raw.intrinsics, `${path}.intrinsics`);
  const timestampSeconds = raw.timestampSeconds == null
    ? undefined
    : nonNegativeNumber(raw.timestampSeconds, `${path}.timestampSeconds`);
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'camera-pose', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem: readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`),
    position: vec3(raw.position, `${path}.position`),
    orientation: normalizedQuaternion(raw.orientation, `${path}.orientation`),
    ...(intrinsics === undefined ? {} : { intrinsics }),
    ...(timestampSeconds === undefined ? {} : { timestampSeconds }),
  };
}

function readCameraPath(value: unknown, path: string): CameraPath {
  const raw = record(value, path);
  exactKeys(raw, path, [
    'schemaVersion',
    'kind',
    'id',
    'coordinateSystem',
    'interpolation',
    'closed',
    'poses',
  ]);
  const coordinateSystem = readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`);
  const poses = arrayValue(raw.poses, `${path}.poses`, MAX_CAMERA_PATH_POSES)
    .map((pose, index) => readCameraPose(pose, `${path}.poses[${index}]`));
  assertUniqueIds(poses, `${path}.poses`);
  let previousTimestamp = -1;
  poses.forEach((pose, index) => {
    requireCoordinateSystem(pose.coordinateSystem, coordinateSystem, `${path}.poses[${index}].coordinateSystem`);
    if (pose.timestampSeconds === undefined) invalid(`${path}.poses[${index}].timestampSeconds`, 'is required in a camera path');
    if (pose.timestampSeconds <= previousTimestamp) invalid(`${path}.poses[${index}].timestampSeconds`, 'must strictly increase');
    previousTimestamp = pose.timestampSeconds;
  });
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'camera-path', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem,
    interpolation: enumValue(raw.interpolation, CAMERA_INTERPOLATIONS, `${path}.interpolation`),
    closed: booleanValue(raw.closed, `${path}.closed`),
    poses,
  };
}

function readSpatialAnchor(value: unknown, path: string): SpatialAnchor {
  const raw = record(value, path);
  exactKeys(raw, path, ['id', 'role', 'pose', 'asset']);
  return {
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    role: enumValue(raw.role, ANCHOR_ROLES, `${path}.role`),
    pose: readCameraPose(raw.pose, `${path}.pose`),
    asset: readLocalAssetReference(raw.asset, `${path}.asset`),
  };
}

function readSpatialContext(value: unknown, path: string): SpatialContext {
  const raw = record(value, path);
  exactKeys(raw, path, ['schemaVersion', 'kind', 'id', 'coordinateSystem', 'anchors']);
  const coordinateSystem = readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`);
  const anchors = arrayValue(raw.anchors, `${path}.anchors`, MAX_SPATIAL_CONTEXT_ANCHORS)
    .map((anchor, index) => readSpatialAnchor(anchor, `${path}.anchors[${index}]`));
  assertUniqueIds(anchors, `${path}.anchors`);
  assertUniqueIds(anchors.map((anchor) => anchor.pose), `${path}.anchors poses`);
  assertUniqueIds(anchors.map((anchor) => anchor.asset), `${path}.anchors assets`);
  anchors.forEach((anchor, index) => {
    requireCoordinateSystem(anchor.pose.coordinateSystem, coordinateSystem, `${path}.anchors[${index}].pose.coordinateSystem`);
  });
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'spatial-context', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem,
    anchors,
  };
}

function readDepthMap(value: unknown, path: string): DepthMap {
  const raw = record(value, path);
  exactKeys(raw, path, [
    'schemaVersion',
    'kind',
    'id',
    'coordinateSystem',
    'cameraPose',
    'asset',
    'width',
    'height',
    'encoding',
    'sampleScale', 'sampleOffset', 'invalidSample', 'depthConvention', 'byteOrder',
    'unit',
    'minDepth',
    'maxDepth',
  ]);
  const coordinateSystem = readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`);
  const cameraPose = readCameraPose(raw.cameraPose, `${path}.cameraPose`);
  requireCoordinateSystem(cameraPose.coordinateSystem, coordinateSystem, `${path}.cameraPose.coordinateSystem`);
  if (!cameraPose.intrinsics) invalid(`${path}.cameraPose.intrinsics`, 'is required for a depth map');
  const width = boundedInteger(raw.width, `${path}.width`, 1, MAX_SPATIAL_IMAGE_DIMENSION);
  const height = boundedInteger(raw.height, `${path}.height`, 1, MAX_SPATIAL_IMAGE_DIMENSION);
  if (cameraPose.intrinsics.width !== width || cameraPose.intrinsics.height !== height) {
    invalid(path, 'depth dimensions must match camera intrinsics');
  }
  const unit = enumValue(raw.unit, SPATIAL_UNITS, `${path}.unit`);
  if (unit !== coordinateSystem.unit) invalid(`${path}.unit`, 'must match the coordinate-system unit');
  const minDepth = nonNegativeNumber(raw.minDepth, `${path}.minDepth`);
  const maxDepth = finiteNumber(raw.maxDepth, `${path}.maxDepth`);
  if (maxDepth <= minDepth) invalid(`${path}.maxDepth`, 'must be greater than minDepth');
  const encoding = enumValue(raw.encoding, DEPTH_ENCODINGS, `${path}.encoding`);
  const sampleScale = finiteNumber(raw.sampleScale, `${path}.sampleScale`);
  if (sampleScale <= 0) invalid(`${path}.sampleScale`, 'must be positive');
  const invalidSample = raw.invalidSample === null ? null : finiteNumber(raw.invalidSample, `${path}.invalidSample`);
  if (invalidSample !== null && encoding !== 'float32'
    && (!Number.isInteger(invalidSample) || invalidSample < 0 || invalidSample > (encoding === 'uint8' ? 255 : 65535))) {
    invalid(`${path}.invalidSample`, 'must be representable in the depth encoding');
  }
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'depth-map', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem,
    cameraPose,
    asset: readLocalAssetReference(raw.asset, `${path}.asset`),
    width,
    height,
    encoding,
    sampleScale,
    sampleOffset: finiteNumber(raw.sampleOffset, `${path}.sampleOffset`),
    invalidSample,
    depthConvention: enumValue(raw.depthConvention, new Set(['axial', 'ray-distance'] as const), `${path}.depthConvention`),
    byteOrder: enumValue(raw.byteOrder, new Set(['little', 'big', 'container-defined'] as const), `${path}.byteOrder`),
    unit,
    minDepth,
    maxDepth,
  };
}

function readDepthSequence(value: unknown, path: string): DepthSequence {
  const raw = record(value, path);
  exactKeys(raw, path, ['schemaVersion', 'kind', 'id', 'coordinateSystem', 'frames']);
  const coordinateSystem = readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`);
  const frames = arrayValue(raw.frames, `${path}.frames`, MAX_DEPTH_SEQUENCE_FRAMES)
    .map((frame, index) => readDepthMap(frame, `${path}.frames[${index}]`));
  assertUniqueIds(frames, `${path}.frames`);
  assertUniqueIds(frames.map((frame) => frame.cameraPose), `${path}.frames camera poses`);
  assertUniqueIds(frames.map((frame) => frame.asset), `${path}.frames assets`);
  let previousTimestamp = -1;
  frames.forEach((frame, index) => {
    requireCoordinateSystem(frame.coordinateSystem, coordinateSystem, `${path}.frames[${index}].coordinateSystem`);
    const timestamp = frame.cameraPose.timestampSeconds;
    if (timestamp === undefined) invalid(`${path}.frames[${index}].cameraPose.timestampSeconds`, 'is required in a depth sequence');
    if (timestamp <= previousTimestamp) invalid(`${path}.frames[${index}].cameraPose.timestampSeconds`, 'must strictly increase');
    previousTimestamp = timestamp;
  });
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'depth-sequence', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem,
    frames,
  };
}

function readPointCloud(value: unknown, path: string): PointCloud {
  const raw = record(value, path);
  exactKeys(raw, path, [
    'schemaVersion',
    'kind',
    'id',
    'coordinateSystem',
    'asset',
    'format',
    'pointCount',
    'hasColor',
    'hasNormals',
  ]);
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'point-cloud', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem: readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`),
    asset: readLocalAssetReference(raw.asset, `${path}.asset`),
    format: enumValue(raw.format, POINT_CLOUD_FORMATS, `${path}.format`),
    pointCount: boundedInteger(raw.pointCount, `${path}.pointCount`, 1, MAX_POINT_CLOUD_POINTS),
    hasColor: booleanValue(raw.hasColor, `${path}.hasColor`),
    hasNormals: booleanValue(raw.hasNormals, `${path}.hasNormals`),
  };
}

function readSensorDefinition(value: unknown, path: string): SensorDefinition {
  const raw = record(value, path);
  exactKeys(raw, path, ['id', 'modality', 'pose']);
  const modality = enumValue(raw.modality, SENSOR_MODALITIES, `${path}.modality`);
  const pose = readCameraPose(raw.pose, `${path}.pose`);
  const requiresIntrinsics = modality === 'rgb' || modality === 'depth' || modality === 'rgbd';
  if (requiresIntrinsics && !pose.intrinsics) invalid(`${path}.pose.intrinsics`, `is required for ${modality}`);
  if (!requiresIntrinsics && pose.intrinsics) invalid(`${path}.pose.intrinsics`, `is not valid for ${modality}`);
  return {
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    modality,
    pose,
  };
}

function readSensorRig(value: unknown, path: string): SensorRig {
  const raw = record(value, path);
  exactKeys(raw, path, ['schemaVersion', 'kind', 'id', 'coordinateSystem', 'sensors']);
  const coordinateSystem = readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`);
  const sensors = arrayValue(raw.sensors, `${path}.sensors`, MAX_SENSOR_RIG_SENSORS)
    .map((sensor, index) => readSensorDefinition(sensor, `${path}.sensors[${index}]`));
  assertUniqueIds(sensors, `${path}.sensors`);
  assertUniqueIds(sensors.map((sensor) => sensor.pose), `${path}.sensor poses`);
  sensors.forEach((sensor, index) => {
    requireCoordinateSystem(sensor.pose.coordinateSystem, coordinateSystem, `${path}.sensors[${index}].pose.coordinateSystem`);
  });
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'sensor-rig', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem,
    sensors,
  };
}

function readSensorSample(value: unknown, path: string): SensorSample {
  const raw = record(value, path);
  exactKeys(raw, path, ['id', 'timestampSeconds', 'asset'], ['pose']);
  const timestampSeconds = nonNegativeNumber(raw.timestampSeconds, `${path}.timestampSeconds`);
  const pose = raw.pose == null ? undefined : readCameraPose(raw.pose, `${path}.pose`);
  if (pose?.timestampSeconds !== undefined && pose.timestampSeconds !== timestampSeconds) {
    invalid(`${path}.pose.timestampSeconds`, 'must equal the sample timestamp');
  }
  return {
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    timestampSeconds,
    asset: readLocalAssetReference(raw.asset, `${path}.asset`),
    ...(pose === undefined ? {} : { pose }),
  };
}

function readSensorStream(value: unknown, path: string): SensorStream {
  const raw = record(value, path);
  exactKeys(raw, path, [
    'schemaVersion',
    'kind',
    'id',
    'coordinateSystem',
    'rigId',
    'rig',
    'sensorId',
    'modality',
    'samples',
  ]);
  const coordinateSystem = readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`);
  const rig = readSensorRig(raw.rig, `${path}.rig`);
  requireCoordinateSystem(rig.coordinateSystem, coordinateSystem, `${path}.rig.coordinateSystem`);
  if (rig.id !== raw.rigId) invalid(`${path}.rigId`, 'must match embedded rig.id');
  const sensor = rig.sensors.find((sensor) => sensor.id === raw.sensorId);
  if (!sensor || sensor.modality !== raw.modality) invalid(`${path}.sensorId`, 'sensor and modality must match embedded rig');
  const samples = arrayValue(raw.samples, `${path}.samples`, MAX_SENSOR_STREAM_SAMPLES)
    .map((sample, index) => readSensorSample(sample, `${path}.samples[${index}]`));
  assertUniqueIds(samples, `${path}.samples`);
  assertUniqueIds(samples.map((sample) => sample.asset), `${path}.sample assets`);
  assertUniqueIds(
    samples.flatMap((sample) => sample.pose === undefined ? [] : [sample.pose]),
    `${path}.sample poses`,
  );
  let previousTimestamp = -1;
  samples.forEach((sample, index) => {
    if (sample.timestampSeconds <= previousTimestamp) invalid(`${path}.samples[${index}].timestampSeconds`, 'must strictly increase');
    previousTimestamp = sample.timestampSeconds;
    if (sample.pose) requireCoordinateSystem(sample.pose.coordinateSystem, coordinateSystem, `${path}.samples[${index}].pose.coordinateSystem`);
  });
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'sensor-stream', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    coordinateSystem,
    rigId: boundedString(raw.rigId, `${path}.rigId`, MAX_SPATIAL_ID_CHARS),
    rig,
    sensorId: boundedString(raw.sensorId, `${path}.sensorId`, MAX_SPATIAL_ID_CHARS),
    modality: enumValue(raw.modality, SENSOR_MODALITIES, `${path}.modality`),
    samples,
  };
}

function readSpatialSessionMetadata(value: unknown, path: string): SpatialSessionMetadata {
  const raw = record(value, path);
  exactKeys(raw, path, ['schemaVersion', 'kind', 'id', 'source', 'tags'], [
    'createdAtMs',
    'provider',
    'model',
    'label',
  ]);
  const tags = arrayValue(raw.tags, `${path}.tags`, MAX_SPATIAL_TAGS, { nonEmpty: false })
    .map((tag, index) => boundedString(tag, `${path}.tags[${index}]`, MAX_SPATIAL_TAG_CHARS));
  if (new Set(tags).size !== tags.length) invalid(`${path}.tags`, 'must not contain duplicates');
  const createdAtMs = raw.createdAtMs == null
    ? undefined
    : boundedInteger(raw.createdAtMs, `${path}.createdAtMs`, 0, Number.MAX_SAFE_INTEGER);
  const provider = raw.provider == null
    ? undefined
    : boundedString(raw.provider, `${path}.provider`, MAX_SPATIAL_METADATA_CHARS);
  const model = raw.model == null
    ? undefined
    : boundedString(raw.model, `${path}.model`, MAX_SPATIAL_METADATA_CHARS);
  const label = raw.label == null
    ? undefined
    : boundedString(raw.label, `${path}.label`, MAX_SPATIAL_LABEL_CHARS);
  return {
    schemaVersion: literal(raw.schemaVersion, 1, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'spatial-session', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    source: enumValue(raw.source, SESSION_SOURCES, `${path}.source`),
    ...(createdAtMs === undefined ? {} : { createdAtMs }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(label === undefined ? {} : { label }),
    tags,
  };
}

function readWorldSplatRepresentation(value: unknown, path: string): WorldSplatRepresentation {
  const raw = record(value, path);
  exactKeys(raw, path, ['id', 'format', 'asset'], ['pointCount']);
  const pointCount = raw.pointCount == null
    ? undefined
    : boundedInteger(raw.pointCount, `${path}.pointCount`, 1, MAX_POINT_CLOUD_POINTS);
  const format = enumValue(raw.format, SPLAT_FORMATS, `${path}.format`);
  const asset = readLocalAssetReference(raw.asset, `${path}.asset`);
  const allowed = format === 'spz' ? ['application/octet-stream', 'application/vnd.spark.spz']
    : ['application/octet-stream', 'application/ply', 'application/x-ply', 'model/ply'];
  if (!allowed.includes(asset.mediaType.toLowerCase())) invalid(`${path}.asset.mediaType`, 'must match splat format');
  return {
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    format,
    asset,
    ...(pointCount === undefined ? {} : { pointCount }),
  };
}

function readWorldValueV2(value: unknown, path: string): WorldValueV2 {
  const raw = record(value, path);
  exactKeys(raw, path, [
    'schemaVersion',
    'kind',
    'id',
    'displayName',
    'coordinateSystem',
    'session',
    'assets',
  ], ['defaultCamera', 'spatialContext']);
  const coordinateSystem = readCoordinateSystem(raw.coordinateSystem, `${path}.coordinateSystem`);
  const rawAssets = record(raw.assets, `${path}.assets`);
  exactKeys(rawAssets, `${path}.assets`, ['splats'], [
    'panorama',
    'colliderMesh',
    'thumbnail',
    'pointCloud',
    'depthSequence',
  ]);
  const splats = arrayValue(
    rawAssets.splats,
    `${path}.assets.splats`,
    MAX_WORLD_SPLAT_REPRESENTATIONS,
    { nonEmpty: false },
  ).map((splat, index) => readWorldSplatRepresentation(splat, `${path}.assets.splats[${index}]`));
  assertUniqueIds(splats, `${path}.assets.splats`);
  const panorama = rawAssets.panorama == null
    ? undefined
    : readLocalAssetReference(rawAssets.panorama, `${path}.assets.panorama`);
  const colliderMesh = rawAssets.colliderMesh == null
    ? undefined
    : readLocalAssetReference(rawAssets.colliderMesh, `${path}.assets.colliderMesh`);
  const thumbnail = rawAssets.thumbnail == null
    ? undefined
    : readLocalAssetReference(rawAssets.thumbnail, `${path}.assets.thumbnail`);
  const imageTypes = ['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
  for (const asset of [panorama, thumbnail]) {
    if (asset && !imageTypes.includes(asset.mediaType.toLowerCase())) invalid(`${path}.assets`, 'image mediaType must be a supported raster type');
  }
  if (colliderMesh && !['application/octet-stream', 'model/gltf-binary', 'model/gltf+json'].includes(colliderMesh.mediaType.toLowerCase())) {
    invalid(`${path}.assets.colliderMesh.mediaType`, 'must be glTF');
  }
  const pointCloud = rawAssets.pointCloud == null
    ? undefined
    : readPointCloud(rawAssets.pointCloud, `${path}.assets.pointCloud`);
  const depthSequence = rawAssets.depthSequence == null
    ? undefined
    : readDepthSequence(rawAssets.depthSequence, `${path}.assets.depthSequence`);
  if (
    splats.length === 0
    && !panorama
    && !colliderMesh
    && !pointCloud
    && !depthSequence
  ) invalid(`${path}.assets`, 'must contain at least one spatial representation');
  if (pointCloud) requireCoordinateSystem(pointCloud.coordinateSystem, coordinateSystem, `${path}.assets.pointCloud.coordinateSystem`);
  if (depthSequence) requireCoordinateSystem(depthSequence.coordinateSystem, coordinateSystem, `${path}.assets.depthSequence.coordinateSystem`);

  const defaultCamera = raw.defaultCamera == null
    ? undefined
    : readCameraPose(raw.defaultCamera, `${path}.defaultCamera`);
  if (defaultCamera) requireCoordinateSystem(defaultCamera.coordinateSystem, coordinateSystem, `${path}.defaultCamera.coordinateSystem`);
  const spatialContext = raw.spatialContext == null
    ? undefined
    : readSpatialContext(raw.spatialContext, `${path}.spatialContext`);
  if (spatialContext) requireCoordinateSystem(spatialContext.coordinateSystem, coordinateSystem, `${path}.spatialContext.coordinateSystem`);

  const assetIds = [
    ...splats.map((splat) => splat.asset),
    panorama,
    colliderMesh,
    thumbnail,
    pointCloud?.asset,
    ...(depthSequence?.frames.map((frame) => frame.asset) ?? []),
    ...(spatialContext?.anchors.map((anchor) => anchor.asset) ?? []),
  ].filter((asset): asset is LocalAssetReference => asset !== undefined);
  assertUniqueIds(assetIds, `${path}.assets local assets`);

  return {
    schemaVersion: literal(raw.schemaVersion, 2, `${path}.schemaVersion`),
    kind: literal(raw.kind, 'world', `${path}.kind`),
    id: boundedString(raw.id, `${path}.id`, MAX_SPATIAL_ID_CHARS),
    displayName: boundedString(raw.displayName, `${path}.displayName`, MAX_SPATIAL_LABEL_CHARS),
    coordinateSystem,
    session: readSpatialSessionMetadata(raw.session, `${path}.session`),
    assets: {
      splats,
      ...(panorama === undefined ? {} : { panorama }),
      ...(colliderMesh === undefined ? {} : { colliderMesh }),
      ...(thumbnail === undefined ? {} : { thumbnail }),
      ...(pointCloud === undefined ? {} : { pointCloud }),
      ...(depthSequence === undefined ? {} : { depthSequence }),
    },
    ...(defaultCamera === undefined ? {} : { defaultCamera }),
    ...(spatialContext === undefined ? {} : { spatialContext }),
  };
}

export function parseCoordinateSystem(value: unknown): CoordinateSystem | null {
  return parseWith(readCoordinateSystem, value);
}

export function parseCameraPose(value: unknown): CameraPose | null {
  return parseWith(readCameraPose, value);
}

export function parseCameraPath(value: unknown): CameraPath | null {
  return parseWith(readCameraPath, value);
}

export function parseSpatialContext(value: unknown): SpatialContext | null {
  return parseWith(readSpatialContext, value);
}

export function parseDepthMap(value: unknown): DepthMap | null {
  return parseWith(readDepthMap, value);
}

export function parseDepthSequence(value: unknown): DepthSequence | null {
  return parseWith(readDepthSequence, value);
}

export function parsePointCloud(value: unknown): PointCloud | null {
  return parseWith(readPointCloud, value);
}

export function parseSensorRig(value: unknown): SensorRig | null {
  return parseWith(readSensorRig, value);
}

export function parseSensorStream(value: unknown): SensorStream | null {
  return parseWith(readSensorStream, value);
}

export function parseSpatialSessionMetadata(value: unknown): SpatialSessionMetadata | null {
  return parseWith(readSpatialSessionMetadata, value);
}

export function parseWorldValueV2(value: unknown): WorldValueV2 | null {
  return parseWith(readWorldValueV2, value);
}

export function isCoordinateSystem(value: unknown): value is CoordinateSystem {
  return parseCoordinateSystem(value) !== null;
}

export function isCameraPose(value: unknown): value is CameraPose {
  return parseCameraPose(value) !== null;
}

export function isCameraPath(value: unknown): value is CameraPath {
  return parseCameraPath(value) !== null;
}

export function isSpatialContext(value: unknown): value is SpatialContext {
  return parseSpatialContext(value) !== null;
}

export function isDepthMap(value: unknown): value is DepthMap {
  return parseDepthMap(value) !== null;
}

export function isDepthSequence(value: unknown): value is DepthSequence {
  return parseDepthSequence(value) !== null;
}

export function isPointCloud(value: unknown): value is PointCloud {
  return parsePointCloud(value) !== null;
}

export function isSensorRig(value: unknown): value is SensorRig {
  return parseSensorRig(value) !== null;
}

export function isSensorStream(value: unknown): value is SensorStream {
  return parseSensorStream(value) !== null;
}

export function isSpatialSessionMetadata(value: unknown): value is SpatialSessionMetadata {
  return parseSpatialSessionMetadata(value) !== null;
}

export function isWorldValueV2(value: unknown): value is WorldValueV2 {
  return parseWorldValueV2(value) !== null;
}

export interface AdaptWorldValueV1Options {
  readonly sessionId?: string;
  readonly createdAtMs?: number;
}

function imageMediaType(uri: string): string {
  const extension = uri.split('/').pop()?.split('.').pop()?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return 'image/png';
}

function pointCountForVariant(variant: string): number | undefined {
  const match = /^(\d+)k$/i.exec(variant);
  if (!match) return undefined;
  const count = Number(match[1]) * 1_000;
  return Number.isSafeInteger(count) && count > 0 && count <= MAX_POINT_CLOUD_POINTS
    ? count
    : undefined;
}

/**
 * Create a provider-neutral in-memory view of a legacy World v1 value.
 * The imported value is never rewritten. Provider navigation URLs and opaque
 * billing metadata deliberately stay outside the portable v2 asset contract.
 */
export function adaptWorldValueV1ToV2(
  value: WorldValue | unknown,
  options: AdaptWorldValueV1Options = {},
): WorldValueV2 | null {
  const world = parseWorldValue(value);
  if (!world || world.semantics.coordinateFrame !== 'marble_raw_opencv') return null;
  const scale = world.semantics.metricScaleFactor ?? 1;
  const groundOffset = world.semantics.groundPlaneOffset ?? 0;
  const coordinateSystem: CoordinateSystem = {
    schemaVersion: 1,
    kind: 'coordinate-system',
    id: 'world',
    handedness: 'right',
    upAxis: '-y',
    forwardAxis: 'z',
    unit: scale === 1 ? 'meters' : 'custom',
    metersPerUnit: scale,
    originMeters: [0, -groundOffset, 0],
  };
  const splats: WorldSplatRepresentation[] = Object.entries(world.assets.splats)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([variant, uri], index) => ({
      id: variant,
      format: 'spz',
      asset: {
        id: `splat-${index + 1}`,
        uri,
        mediaType: 'application/vnd.spark.spz',
      },
      ...(pointCountForVariant(variant) === undefined
        ? {}
        : { pointCount: pointCountForVariant(variant) }),
    }));
  const candidate: WorldValueV2 = {
    schemaVersion: 2,
    kind: 'world',
    id: world.worldId,
    displayName: world.displayName,
    coordinateSystem,
    session: {
      schemaVersion: 1,
      kind: 'spatial-session',
      id: options.sessionId ?? world.worldId,
      source: 'generated',
      ...(options.createdAtMs === undefined ? {} : { createdAtMs: options.createdAtMs }),
      provider: world.provider,
      model: world.model,
      label: world.caption ?? world.displayName,
      tags: [],
    },
    assets: {
      splats,
      ...(world.assets.panorama
        ? {
          panorama: {
            id: 'panorama',
            uri: world.assets.panorama,
            mediaType: imageMediaType(world.assets.panorama),
          },
        }
        : {}),
      ...(world.assets.colliderMesh
        ? {
          colliderMesh: {
            id: 'collider-mesh',
            uri: world.assets.colliderMesh,
            mediaType: 'model/gltf-binary',
          },
        }
        : {}),
      ...(world.assets.thumbnail
        ? {
          thumbnail: {
            id: 'thumbnail',
            uri: world.assets.thumbnail,
            mediaType: imageMediaType(world.assets.thumbnail),
          },
        }
        : {}),
    },
  };
  return parseWorldValueV2(candidate);
}
