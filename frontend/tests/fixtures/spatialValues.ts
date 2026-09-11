import type { PortDataType } from '../../src/types';

export const coordinateSystemFixture = {
  schemaVersion: 1,
  kind: 'coordinate-system',
  id: 'studio-metric',
  handedness: 'right',
  upAxis: 'y',
  forwardAxis: '-z',
  unit: 'meters',
  metersPerUnit: 1,
  originMeters: [0, 0, 0],
} as const;

function localAsset(id: string, filename: string, mediaType: string) {
  return {
    id,
    uri: `/api/outputs/mock-spatial/${filename}`,
    mediaType,
    byteLength: 1_024,
  };
}

function cameraPose(id: string, timestampSeconds?: number) {
  return {
    schemaVersion: 1,
    kind: 'camera-pose',
    id,
    coordinateSystem: coordinateSystemFixture,
    position: [1, 1.6, -3],
    orientation: [0, 0, 0, 1],
    intrinsics: {
      model: 'pinhole',
      width: 1_920,
      height: 1_080,
      fx: 1_240,
      fy: 1_240,
      cx: 960,
      cy: 540,
    },
    ...(timestampSeconds === undefined ? {} : { timestampSeconds }),
  };
}

export const cameraPoseFixture = cameraPose('camera-main', 0);

export const cameraPathFixture = {
  schemaVersion: 1,
  kind: 'camera-path',
  id: 'camera-path-main',
  coordinateSystem: coordinateSystemFixture,
  interpolation: 'catmull-rom',
  closed: false,
  poses: [cameraPose('path-pose-1', 0), cameraPose('path-pose-2', 2.5)],
} as const;

export const spatialContextFixture = {
  schemaVersion: 1,
  kind: 'spatial-context',
  id: 'spatial-context-main',
  coordinateSystem: coordinateSystemFixture,
  anchors: [
    {
      id: 'anchor-reference',
      role: 'reference',
      pose: cameraPose('anchor-pose-reference', 0),
      asset: localAsset('anchor-image-reference', 'reference.png', 'image/png'),
    },
    {
      id: 'anchor-target',
      role: 'target',
      pose: cameraPose('anchor-pose-target', 1),
      asset: localAsset('anchor-image-target', 'target.png', 'image/png'),
    },
  ],
} as const;

export const depthMapFixture = {
  schemaVersion: 1,
  kind: 'depth-map',
  id: 'depth-main',
  coordinateSystem: coordinateSystemFixture,
  cameraPose: cameraPose('depth-camera-main', 0),
  asset: localAsset('depth-map-main', 'depth-main.bin', 'application/octet-stream'),
  width: 1_920,
  height: 1_080,
  encoding: 'float32',
  sampleScale: 1, sampleOffset: 0, invalidSample: null,
  depthConvention: 'axial', byteOrder: 'little',
  unit: 'meters',
  minDepth: 0.1,
  maxDepth: 120,
} as const;

const depthSecondFixture = {
  ...depthMapFixture,
  id: 'depth-second',
  cameraPose: cameraPose('depth-camera-second', 1.25),
  asset: localAsset('depth-map-second', 'depth-second.bin', 'application/octet-stream'),
} as const;

export const depthSequenceFixture = {
  schemaVersion: 1,
  kind: 'depth-sequence',
  id: 'depth-sequence-main',
  coordinateSystem: coordinateSystemFixture,
  frames: [depthMapFixture, depthSecondFixture],
} as const;

export const pointCloudFixture = {
  schemaVersion: 1,
  kind: 'point-cloud',
  id: 'point-cloud-main',
  coordinateSystem: coordinateSystemFixture,
  asset: localAsset('point-cloud-asset', 'point-cloud.ply', 'application/octet-stream'),
  format: 'ply',
  pointCount: 425_000,
  hasColor: true,
  hasNormals: false,
} as const;

export const sensorRigFixture = {
  schemaVersion: 1,
  kind: 'sensor-rig',
  id: 'sensor-rig-main',
  coordinateSystem: coordinateSystemFixture,
  sensors: [
    { id: 'rgb-main', modality: 'rgb', pose: cameraPose('rig-pose-rgb') },
    {
      id: 'imu-main',
      modality: 'imu',
      pose: {
        ...cameraPose('rig-pose-imu'),
        intrinsics: undefined,
      },
    },
  ],
} as const;

export const sensorStreamFixture = {
  schemaVersion: 1,
  kind: 'sensor-stream',
  id: 'sensor-stream-main',
  coordinateSystem: coordinateSystemFixture,
  rigId: 'sensor-rig-main',
  rig: sensorRigFixture,
  sensorId: 'rgb-main',
  modality: 'rgb',
  samples: [
    {
      id: 'sensor-sample-1',
      timestampSeconds: 0,
      asset: localAsset('sensor-frame-1', 'rgb-0001.png', 'image/png'),
      pose: cameraPose('sensor-pose-1', 0),
    },
    {
      id: 'sensor-sample-2',
      timestampSeconds: 1 / 30,
      asset: localAsset('sensor-frame-2', 'rgb-0002.png', 'image/png'),
      pose: cameraPose('sensor-pose-2', 1 / 30),
    },
  ],
} as const;

export const spatialSessionFixture = {
  schemaVersion: 1,
  kind: 'spatial-session',
  id: 'spatial-session-main',
  source: 'reconstructed',
  createdAtMs: 1_788_528_000_000,
  provider: 'provider-neutral-fixture',
  model: 'fixture-model-v1',
  label: 'Studio reconstruction',
  tags: ['metric', 'indoor'],
} as const;

export const worldV2Fixture = {
  schemaVersion: 2,
  kind: 'world',
  id: 'world-v2-main',
  displayName: 'Provider-neutral studio',
  coordinateSystem: coordinateSystemFixture,
  session: spatialSessionFixture,
  assets: {
    splats: [
      {
        id: 'splat-standard',
        format: 'spz',
        asset: localAsset('splat-standard-asset', 'world-500k.spz', 'application/vnd.spark.spz'),
        pointCount: 500_000,
      },
    ],
    panorama: localAsset('world-panorama', 'panorama.webp', 'image/webp'),
    pointCloud: pointCloudFixture,
    depthSequence: depthSequenceFixture,
  },
  defaultCamera: cameraPose('world-default-camera'),
  spatialContext: spatialContextFixture,
} as const;

export const worldV1Fixture = {
  schemaVersion: 1,
  provider: 'worldlabs',
  worldId: 'marble-world-main',
  model: 'marble-1.1',
  displayName: 'Legacy Marble world',
  promptType: 'text',
  assets: {
    splats: { '100k': '/api/outputs/mock-spatial/marble-100k.spz' },
    panorama: '/api/outputs/mock-spatial/marble-panorama.webp',
  },
  semantics: {
    metricScaleFactor: 1,
    groundPlaneOffset: 0,
    coordinateFrame: 'marble_raw_opencv',
  },
} as const;

export const spatialFixtureByType: Readonly<Partial<Record<PortDataType, unknown>>> = {
  CameraPose: cameraPoseFixture,
  CameraPath: cameraPathFixture,
  SpatialContext: spatialContextFixture,
  DepthMap: depthMapFixture,
  DepthSequence: depthSequenceFixture,
  PointCloud: pointCloudFixture,
  SensorRig: sensorRigFixture,
  SensorStream: sensorStreamFixture,
  SpatialSession: spatialSessionFixture,
  World: worldV2Fixture,
};
