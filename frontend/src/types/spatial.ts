export const SPATIAL_SCHEMA_VERSION = 1 as const;
export const WORLD_VALUE_V2_SCHEMA_VERSION = 2 as const;

export const MAX_SPATIAL_ID_CHARS = 128;
export const MAX_SPATIAL_LABEL_CHARS = 256;
export const MAX_SPATIAL_METADATA_CHARS = 128;
export const MAX_SPATIAL_ASSET_URI_CHARS = 2_048;
export const MAX_SPATIAL_TAGS = 32;
export const MAX_SPATIAL_TAG_CHARS = 64;
export const MAX_CAMERA_PATH_POSES = 10_000;
export const MAX_SPATIAL_CONTEXT_ANCHORS = 4_096;
export const MAX_DEPTH_SEQUENCE_FRAMES = 10_000;
export const MAX_POINT_CLOUD_POINTS = 1_000_000_000;
export const MAX_SENSOR_RIG_SENSORS = 256;
export const MAX_SENSOR_STREAM_SAMPLES = 10_000;
export const MAX_WORLD_SPLAT_REPRESENTATIONS = 64;
export const MAX_SPATIAL_IMAGE_DIMENSION = 32_768;
export const MAX_CAMERA_INTRINSIC_MAGNITUDE = 10_000_000;

export type AxisDirection = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';
export type SpatialUnit = 'meters' | 'centimeters' | 'millimeters' | 'custom';
export type SpatialHandedness = 'right' | 'left';

export interface CoordinateSystem {
  readonly schemaVersion: 1;
  readonly kind: 'coordinate-system';
  readonly id: string;
  readonly handedness: SpatialHandedness;
  readonly upAxis: AxisDirection;
  readonly forwardAxis: AxisDirection;
  /** Human-readable unit name. Standard units have a fixed metersPerUnit. */
  readonly unit: SpatialUnit;
  /** Metric conversion applied before originMeters. */
  readonly metersPerUnit: number;
  /** Translation in meters after unit conversion. */
  readonly originMeters: readonly [number, number, number];
}

export interface LocalAssetReference {
  readonly id: string;
  /** Portable Nebula-owned path under /api/outputs/. Never a provider URL. */
  readonly uri: string;
  readonly mediaType: string;
  readonly byteLength?: number;
}

export interface CameraIntrinsics {
  readonly model: 'pinhole';
  readonly width: number;
  readonly height: number;
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly skew?: number;
}

export interface CameraPose {
  readonly schemaVersion: 1;
  readonly kind: 'camera-pose';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly position: readonly [number, number, number];
  /** Canonical normalized quaternion in [x, y, z, w] order. */
  readonly orientation: readonly [number, number, number, number];
  readonly intrinsics?: CameraIntrinsics;
  readonly timestampSeconds?: number;
}

export type CameraPathInterpolation = 'linear' | 'step' | 'catmull-rom';

export interface CameraPath {
  readonly schemaVersion: 1;
  readonly kind: 'camera-path';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly interpolation: CameraPathInterpolation;
  readonly closed: boolean;
  readonly poses: readonly CameraPose[];
}

export type SpatialAnchorRole = 'reference' | 'observation' | 'target';

export interface SpatialAnchor {
  readonly id: string;
  readonly role: SpatialAnchorRole;
  readonly pose: CameraPose;
  readonly asset: LocalAssetReference;
}

export interface SpatialContext {
  readonly schemaVersion: 1;
  readonly kind: 'spatial-context';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly anchors: readonly SpatialAnchor[];
}

export type DepthEncoding = 'float32' | 'uint16' | 'uint8';

export interface DepthMap {
  readonly schemaVersion: 1;
  readonly kind: 'depth-map';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly cameraPose: CameraPose;
  readonly asset: LocalAssetReference;
  readonly width: number;
  readonly height: number;
  readonly encoding: DepthEncoding;
  readonly sampleScale: number;
  readonly sampleOffset: number;
  readonly invalidSample: number | null;
  readonly depthConvention: 'axial' | 'ray-distance';
  readonly byteOrder: 'little' | 'big' | 'container-defined';
  readonly unit: SpatialUnit;
  readonly minDepth: number;
  readonly maxDepth: number;
}

export interface DepthSequence {
  readonly schemaVersion: 1;
  readonly kind: 'depth-sequence';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly frames: readonly DepthMap[];
}

export type PointCloudFormat = 'ply' | 'pcd' | 'las' | 'laz' | 'xyz';

export interface PointCloud {
  readonly schemaVersion: 1;
  readonly kind: 'point-cloud';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly asset: LocalAssetReference;
  readonly format: PointCloudFormat;
  readonly pointCount: number;
  readonly hasColor: boolean;
  readonly hasNormals: boolean;
}

export type SensorModality = 'rgb' | 'depth' | 'rgbd' | 'lidar' | 'imu';

export interface SensorDefinition {
  readonly id: string;
  readonly modality: SensorModality;
  readonly pose: CameraPose;
}

export interface SensorRig {
  readonly schemaVersion: 1;
  readonly kind: 'sensor-rig';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly sensors: readonly SensorDefinition[];
}

export interface SensorSample {
  readonly id: string;
  readonly timestampSeconds: number;
  readonly asset: LocalAssetReference;
  readonly pose?: CameraPose;
}

export interface SensorStream {
  readonly schemaVersion: 1;
  readonly kind: 'sensor-stream';
  readonly id: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly rigId: string;
  readonly rig: SensorRig;
  readonly sensorId: string;
  readonly modality: SensorModality;
  readonly samples: readonly SensorSample[];
}

export type SpatialSessionSource =
  | 'generated'
  | 'reconstructed'
  | 'captured'
  | 'simulated'
  | 'imported';

/** Immutable provenance for one spatial result/session. */
export interface SpatialSessionMetadata {
  readonly schemaVersion: 1;
  readonly kind: 'spatial-session';
  readonly id: string;
  readonly source: SpatialSessionSource;
  readonly createdAtMs?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly label?: string;
  readonly tags: readonly string[];
}

export type WorldSplatFormat = 'spz' | 'ply';

export interface WorldSplatRepresentation {
  readonly id: string;
  readonly format: WorldSplatFormat;
  readonly asset: LocalAssetReference;
  readonly pointCount?: number;
}

export interface WorldValueV2 {
  readonly schemaVersion: 2;
  readonly kind: 'world';
  readonly id: string;
  readonly displayName: string;
  readonly coordinateSystem: CoordinateSystem;
  readonly session: SpatialSessionMetadata;
  readonly assets: {
    readonly splats: readonly WorldSplatRepresentation[];
    readonly panorama?: LocalAssetReference;
    readonly colliderMesh?: LocalAssetReference;
    readonly thumbnail?: LocalAssetReference;
    readonly pointCloud?: PointCloud;
    readonly depthSequence?: DepthSequence;
  };
  readonly defaultCamera?: CameraPose;
  readonly spatialContext?: SpatialContext;
}
