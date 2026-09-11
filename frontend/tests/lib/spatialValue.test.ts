// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_CAMERA_PATH_POSES,
  MAX_DEPTH_SEQUENCE_FRAMES,
  MAX_SENSOR_RIG_SENSORS,
  MAX_SENSOR_STREAM_SAMPLES,
  MAX_SPATIAL_ASSET_URI_CHARS,
  MAX_SPATIAL_CONTEXT_ANCHORS,
  MAX_SPATIAL_ID_CHARS,
  MAX_SPATIAL_METADATA_CHARS,
  MAX_SPATIAL_TAGS,
  MAX_WORLD_SPLAT_REPRESENTATIONS,
} from '../../src/types/spatial';
import {
  adaptWorldValueV1ToV2,
  parseCameraPath,
  parseCameraPose,
  parseCoordinateSystem,
  parseDepthMap,
  parseDepthSequence,
  parsePointCloud,
  parseSensorRig,
  parseSensorStream,
  parseSpatialContext,
  parseSpatialSessionMetadata,
  parseWorldValueV2,
} from '../../src/lib/spatialValue';
import { parseWorldValue } from '../../src/lib/worldValue';

function coordinateSystem(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'coordinate-system',
    id: 'metric-world',
    handedness: 'right',
    upAxis: 'y',
    forwardAxis: '-z',
    unit: 'meters',
    metersPerUnit: 1,
    originMeters: [0, 0, 0],
    ...overrides,
  };
}

function intrinsics(overrides: Record<string, unknown> = {}) {
  return {
    model: 'pinhole',
    width: 640,
    height: 480,
    fx: 500,
    fy: 500,
    cx: 320,
    cy: 240,
    ...overrides,
  };
}

function cameraPose(
  id = 'pose-1',
  timestampSeconds: number | undefined = 0,
  coordinates = coordinateSystem(),
  withIntrinsics = true,
) {
  return {
    schemaVersion: 1,
    kind: 'camera-pose',
    id,
    coordinateSystem: coordinates,
    position: [1, 2, 3],
    orientation: [0, 0, 0, 2],
    ...(withIntrinsics ? { intrinsics: intrinsics() } : {}),
    ...(timestampSeconds === undefined ? {} : { timestampSeconds }),
  };
}

function localAsset(id = 'asset-1', uri = '/api/outputs/run/asset.bin', mediaType = 'application/octet-stream') {
  return { id, uri, mediaType, byteLength: 128 };
}

function depthMap(id = 'depth-1', timestampSeconds = 0, assetId = `${id}-asset`) {
  return {
    schemaVersion: 1,
    kind: 'depth-map',
    id,
    coordinateSystem: coordinateSystem(),
    cameraPose: cameraPose(`${id}-pose`, timestampSeconds),
    asset: localAsset(assetId, `/api/outputs/run/${id}.depth`, 'application/octet-stream'),
    width: 640,
    height: 480,
    encoding: 'float32',
    sampleScale: 1, sampleOffset: 0, invalidSample: null,
    depthConvention: 'axial', byteOrder: 'little',
    unit: 'meters',
    minDepth: 0,
    maxDepth: 100,
  };
}

function sensorStream() {
  return {
    schemaVersion: 1,
    kind: 'sensor-stream',
    id: 'stream-1',
    coordinateSystem: coordinateSystem(),
    rigId: 'rig-1',
    rig: { schemaVersion: 1, kind: 'sensor-rig', id: 'rig-1', coordinateSystem: coordinateSystem(),
      sensors: [{ id: 'rgb-1', modality: 'rgb', pose: cameraPose('rig-pose') }] },
    sensorId: 'rgb-1',
    modality: 'rgb',
    samples: [
      {
        id: 'sample-1',
        timestampSeconds: 0,
        asset: localAsset('sample-asset-1', '/api/outputs/run/frame-1.png', 'image/png'),
        pose: cameraPose('sample-pose-1', 0),
      },
      {
        id: 'sample-2',
        timestampSeconds: 1,
        asset: localAsset('sample-asset-2', '/api/outputs/run/frame-2.png', 'image/png'),
        pose: cameraPose('sample-pose-2', 1),
      },
    ],
  };
}

function spatialSession() {
  return {
    schemaVersion: 1,
    kind: 'spatial-session',
    id: 'session-1',
    source: 'generated',
    createdAtMs: 1_725_000_000_000,
    provider: 'provider-neutral-test',
    model: 'spatial-model',
    label: 'A spatial session',
    tags: ['indoor', 'metric'],
  };
}

function worldV2() {
  return {
    schemaVersion: 2,
    kind: 'world',
    id: 'world-2',
    displayName: 'Portable world',
    coordinateSystem: coordinateSystem(),
    session: spatialSession(),
    assets: {
      splats: [
        {
          id: 'splat-500k',
          format: 'spz',
          asset: localAsset(
            'splat-asset-500k',
            '/api/outputs/run/world-500k.spz',
            'application/vnd.spark.spz',
          ),
          pointCount: 500_000,
        },
      ],
    },
    defaultCamera: cameraPose('default-camera', undefined),
  };
}

describe('provider-neutral spatial value parsers', () => {
  it('normalizes explicit optional nulls to absence like the backend', () => {
    const parsed = parseCameraPose({ ...cameraPose(), intrinsics: null, timestampSeconds: null });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('intrinsics');
    expect(parsed).not.toHaveProperty('timestampSeconds');
    const session = parseSpatialSessionMetadata({
      ...spatialSession(), createdAtMs: null, provider: null, model: null, label: null,
    });
    expect(session).not.toBeNull();
    expect(session).not.toHaveProperty('createdAtMs');
    const world = parseWorldValueV2({
      ...worldV2(), defaultCamera: null, spatialContext: null,
      assets: { ...worldV2().assets, panorama: null, colliderMesh: null, thumbnail: null, pointCloud: null, depthSequence: null },
    });
    expect(world).not.toBeNull();
    expect(world?.assets).not.toHaveProperty('panorama');
  });

  it('rejects a thumbnail-only world', () => {
    expect(parseWorldValueV2({
      ...worldV2(), assets: { splats: [], thumbnail: localAsset('thumb', '/api/outputs/run/thumb.png', 'image/png') },
    })).toBeNull();
  });

  it('normalizes finite camera quaternions and deeply freezes accepted values', () => {
    const parsed = parseCameraPose(cameraPose());

    expect(parsed?.orientation).toEqual([0, 0, 0, 1]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.coordinateSystem)).toBe(true);
    expect(Object.isFrozen(parsed?.position)).toBe(true);
  });

  it('rejects NaN, Infinity, zero quaternions, unknown keys, and invalid coordinate systems', () => {
    expect(parseCameraPose({ ...cameraPose(), position: [Number.NaN, 0, 0] })).toBeNull();
    expect(parseCameraPose({ ...cameraPose(), orientation: [0, 0, 0, Number.POSITIVE_INFINITY] })).toBeNull();
    expect(parseCameraPose({ ...cameraPose(), orientation: [0, 0, 0, 0] })).toBeNull();
    expect(parseCoordinateSystem({ ...coordinateSystem(), debug: true })).toBeNull();
    expect(parseCoordinateSystem(coordinateSystem({ forwardAxis: '-y' }))).toBeNull();
    expect(parseCoordinateSystem(coordinateSystem({ unit: 'centimeters', metersPerUnit: 1 }))).toBeNull();
    expect(parseCoordinateSystem(coordinateSystem({ id: 'x'.repeat(MAX_SPATIAL_ID_CHARS + 1) }))).toBeNull();
  });

  it('rejects invalid dimensions and camera intrinsics', () => {
    expect(parseCameraPose({
      ...cameraPose(),
      intrinsics: intrinsics({ width: 0 }),
    })).toBeNull();
    expect(parseCameraPose({
      ...cameraPose(),
      intrinsics: intrinsics({ fx: 0 }),
    })).toBeNull();
    expect(parseCameraPose({
      ...cameraPose(),
      intrinsics: intrinsics({ cx: 641 }),
    })).toBeNull();
  });

  it('validates camera-path frame identity, coordinate consistency, time order, and size', () => {
    const path = {
      schemaVersion: 1,
      kind: 'camera-path',
      id: 'path-1',
      coordinateSystem: coordinateSystem(),
      interpolation: 'catmull-rom',
      closed: false,
      poses: [cameraPose('pose-1', 0), cameraPose('pose-2', 1)],
    };
    expect(parseCameraPath(path)?.poses).toHaveLength(2);
    expect(parseCameraPath({
      ...path,
      poses: [cameraPose('pose-1', 0), cameraPose('pose-1', 1)],
    })).toBeNull();
    expect(parseCameraPath({
      ...path,
      poses: [cameraPose('pose-1', 1), cameraPose('pose-2', 1)],
    })).toBeNull();
    expect(parseCameraPath({
      ...path,
      poses: [cameraPose('pose-1', 0), cameraPose('pose-2', 1, coordinateSystem({ id: 'other' }))],
    })).toBeNull();
    expect(parseCameraPath({
      ...path,
      poses: Array(MAX_CAMERA_PATH_POSES + 1).fill(null),
    })).toBeNull();
  });

  it('validates anchored local spatial context without duplicate IDs', () => {
    const context = {
      schemaVersion: 1,
      kind: 'spatial-context',
      id: 'context-1',
      coordinateSystem: coordinateSystem(),
      anchors: [
        {
          id: 'anchor-1',
          role: 'reference',
          pose: cameraPose('anchor-pose-1', 0),
          asset: localAsset('anchor-asset-1', '/api/outputs/run/reference.png', 'image/png'),
        },
      ],
    };
    expect(parseSpatialContext(context)?.anchors[0].role).toBe('reference');
    expect(parseSpatialContext({
      ...context,
      anchors: [
        context.anchors[0],
        { ...context.anchors[0], id: 'anchor-2' },
      ],
    })).toBeNull();
    expect(parseSpatialContext({
      ...context,
      anchors: [{
        ...context.anchors[0],
        asset: localAsset('remote', 'https://assets.example/reference.png', 'image/png'),
      }],
    })).toBeNull();
  });

  it('validates depth dimensions, units, unique frame resources, and increasing timestamps', () => {
    expect(parseDepthMap(depthMap())?.encoding).toBe('float32');
    for (const override of [{ sampleScale: 0 }, { sampleOffset: Infinity },
      { encoding: 'uint8', invalidSample: 256 }, { encoding: 'uint16', invalidSample: 0.5 },
      { depthConvention: 'unknown' }, { byteOrder: 'native' }]) {
      expect(parseDepthMap({ ...depthMap(), ...override })).toBeNull();
    }
    expect(parseDepthMap({ ...depthMap(), encoding: 'uint16', invalidSample: 0, sampleScale: 0.001 })?.sampleScale).toBe(0.001);
    expect(parseDepthMap({ ...depthMap(), width: 320 })).toBeNull();
    expect(parseDepthMap({ ...depthMap(), unit: 'centimeters' })).toBeNull();
    expect(parseDepthMap({ ...depthMap(), maxDepth: Number.POSITIVE_INFINITY })).toBeNull();

    const sequence = {
      schemaVersion: 1,
      kind: 'depth-sequence',
      id: 'depth-sequence-1',
      coordinateSystem: coordinateSystem(),
      frames: [depthMap('depth-1', 0), depthMap('depth-2', 1)],
    };
    expect(parseDepthSequence(sequence)?.frames).toHaveLength(2);
    expect(parseDepthSequence({
      ...sequence,
      frames: [depthMap('depth-1', 1), depthMap('depth-2', 0)],
    })).toBeNull();
    expect(parseDepthSequence({
      ...sequence,
      frames: [depthMap('depth-1', 0, 'same-asset'), depthMap('depth-2', 1, 'same-asset')],
    })).toBeNull();
  });

  it('validates point-cloud counts, flags, formats, and local assets', () => {
    const cloud = {
      schemaVersion: 1,
      kind: 'point-cloud',
      id: 'cloud-1',
      coordinateSystem: coordinateSystem(),
      asset: localAsset('cloud-asset', '/api/outputs/run/cloud.ply', 'application/octet-stream'),
      format: 'ply',
      pointCount: 500_000,
      hasColor: true,
      hasNormals: false,
    };
    expect(parsePointCloud(cloud)?.pointCount).toBe(500_000);
    expect(parsePointCloud({ ...cloud, pointCount: 0 })).toBeNull();
    expect(parsePointCloud({ ...cloud, pointCount: 1.5 })).toBeNull();
    expect(parsePointCloud({ ...cloud, format: 'obj' })).toBeNull();
    expect(parsePointCloud({
      ...cloud,
      asset: localAsset('cloud-asset', '/api/outputs/run/cloud.ply?signature=secret'),
    })).toBeNull();
  });

  it('validates sensor modality contracts, rig identities, sample times, and coordinate frames', () => {
    const rig = {
      schemaVersion: 1,
      kind: 'sensor-rig',
      id: 'rig-1',
      coordinateSystem: coordinateSystem(),
      sensors: [
        { id: 'rgb-1', modality: 'rgb', pose: cameraPose('rgb-pose', 0) },
        { id: 'imu-1', modality: 'imu', pose: cameraPose('imu-pose', 0, coordinateSystem(), false) },
      ],
    };
    expect(parseSensorRig(rig)?.sensors).toHaveLength(2);
    expect(parseSensorRig({
      ...rig,
      sensors: [{ id: 'rgb-1', modality: 'rgb', pose: cameraPose('rgb-pose', 0, coordinateSystem(), false) }],
    })).toBeNull();
    expect(parseSensorRig({
      ...rig,
      sensors: [rig.sensors[0], { ...rig.sensors[0], pose: cameraPose('other-pose', 0) }],
    })).toBeNull();
    expect(parseSensorRig({
      ...rig,
      sensors: Array(MAX_SENSOR_RIG_SENSORS + 1).fill(null),
    })).toBeNull();

    const stream = sensorStream();
    expect(parseSensorStream(stream)?.samples).toHaveLength(2);
    for (const override of [{ rigId: 'other' }, { sensorId: 'missing' }, { modality: 'depth' }, { rig: undefined }]) {
      expect(parseSensorStream({ ...stream, ...override })).toBeNull();
    }
    expect(parseSensorStream({ ...stream, coordinateSystem: coordinateSystem({ id: 'other-frame' }) })).toBeNull();
    expect(parseSensorStream({
      ...stream,
      samples: [stream.samples[1], stream.samples[0]],
    })).toBeNull();
    expect(parseSensorStream({
      ...stream,
      samples: [stream.samples[0], { ...stream.samples[1], id: 'sample-1' }],
    })).toBeNull();
    expect(parseSensorStream({
      ...stream,
      samples: [
        stream.samples[0],
        {
          ...stream.samples[1],
          pose: cameraPose('sample-pose-2', 1, coordinateSystem({ id: 'other-frame' })),
        },
      ],
    })).toBeNull();
  });

  it('parses immutable bounded session metadata and rejects duplicate or excessive tags', () => {
    const parsed = parseSpatialSessionMetadata(spatialSession());
    expect(parsed?.tags).toEqual(['indoor', 'metric']);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.tags)).toBe(true);
    expect(parseSpatialSessionMetadata({
      ...spatialSession(),
      tags: ['indoor', 'indoor'],
    })).toBeNull();
    expect(parseSpatialSessionMetadata({
      ...spatialSession(),
      tags: Array(MAX_SPATIAL_TAGS + 1).fill('tag'),
    })).toBeNull();
    expect(parseSpatialSessionMetadata({
      ...spatialSession(),
      provider: ' provider',
    })).toBeNull();
  });

  it('enforces explicit collection and string ceilings before consuming hostile payloads', () => {
    expect(parseCameraPath({
      schemaVersion: 1,
      kind: 'camera-path',
      id: 'oversized-path',
      coordinateSystem: coordinateSystem(),
      interpolation: 'linear',
      closed: false,
      poses: Array(MAX_CAMERA_PATH_POSES + 1).fill(null),
    })).toBeNull();
    expect(parseSpatialContext({
      schemaVersion: 1,
      kind: 'spatial-context',
      id: 'oversized-context',
      coordinateSystem: coordinateSystem(),
      anchors: Array(MAX_SPATIAL_CONTEXT_ANCHORS + 1).fill(null),
    })).toBeNull();
    expect(parseDepthSequence({
      schemaVersion: 1,
      kind: 'depth-sequence',
      id: 'oversized-depth',
      coordinateSystem: coordinateSystem(),
      frames: Array(MAX_DEPTH_SEQUENCE_FRAMES + 1).fill(null),
    })).toBeNull();
    expect(parseSensorStream({
      ...sensorStream(),
      samples: Array(MAX_SENSOR_STREAM_SAMPLES + 1).fill(null),
    })).toBeNull();
    expect(parseWorldValueV2({
      ...worldV2(),
      assets: { splats: Array(MAX_WORLD_SPLAT_REPRESENTATIONS + 1).fill(null) },
    })).toBeNull();
    expect(parseSpatialSessionMetadata({
      ...spatialSession(),
      provider: 'p'.repeat(MAX_SPATIAL_METADATA_CHARS + 1),
    })).toBeNull();

    const cloud = {
      schemaVersion: 1,
      kind: 'point-cloud',
      id: 'oversized-uri-cloud',
      coordinateSystem: coordinateSystem(),
      asset: localAsset(
        'oversized-uri',
        `/api/outputs/${'x'.repeat(MAX_SPATIAL_ASSET_URI_CHARS)}`,
      ),
      format: 'ply',
      pointCount: 1,
      hasColor: false,
      hasNormals: false,
    };
    expect(parsePointCloud(cloud)).toBeNull();
  });
});

describe('WorldValueV2', () => {
  it('accepts and deeply freezes a strictly local, coordinate-consistent world', () => {
    const parsed = parseWorldValueV2(worldV2());

    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.assets.splats[0].pointCount).toBe(500_000);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.assets)).toBe(true);
    expect(Object.isFrozen(parsed?.assets.splats)).toBe(true);
  });

  it('rejects remote, signed, traversing, duplicate, and mixed-frame assets', () => {
    const world = worldV2();
    const splat = world.assets.splats[0];
    expect(parseWorldValueV2({
      ...world,
      assets: { splats: [{ ...splat, asset: { ...splat.asset, uri: 'https://cdn.example/world.spz' } }] },
    })).toBeNull();
    expect(parseWorldValueV2({
      ...world,
      assets: { splats: [{ ...splat, asset: { ...splat.asset, uri: '/api/outputs/run/world.spz?sig=abc' } }] },
    })).toBeNull();
    expect(parseWorldValueV2({
      ...world,
      assets: { splats: [{ ...splat, asset: { ...splat.asset, uri: '/api/outputs/%2e%2e/settings' } }] },
    })).toBeNull();
    expect(parseWorldValueV2({
      ...worldV2(),
      assets: { splats: [{ ...splat, asset: { ...splat.asset, uri: '/api/outputs/run%2Fsecret.spz' } }] },
    })).toBeNull();
    expect(parseWorldValueV2({
      ...world,
      assets: { splats: [splat, { ...splat }] },
    })).toBeNull();
    expect(parseWorldValueV2({
      ...world,
      spatialContext: {
        schemaVersion: 1,
        kind: 'spatial-context',
        id: 'context-1',
        coordinateSystem: coordinateSystem(),
        anchors: [{
          id: 'anchor-1',
          role: 'reference',
          pose: cameraPose('anchor-pose', 0),
          asset: localAsset(
            'splat-asset-500k',
            '/api/outputs/run/reference.png',
            'image/png',
          ),
        }],
      },
    })).toBeNull();
    expect(parseWorldValueV2({
      ...world,
      defaultCamera: cameraPose('default-camera', undefined, coordinateSystem({ unit: 'custom', metersPerUnit: 2 })),
    })).toBeNull();
  });

  it('requires at least one representation and rejects unknown versioned fields', () => {
    expect(parseWorldValueV2({
      ...worldV2(),
      assets: {
        splats: [],
        panorama: localAsset('panorama', '/api/outputs/run/panorama.jpg', 'image/jpeg'),
      },
    })?.assets.panorama?.id).toBe('panorama');
    expect(parseWorldValueV2({ ...worldV2(), assets: { splats: [] } })).toBeNull();
    expect(parseWorldValueV2({ ...worldV2(), marbleUrl: 'https://marble.worldlabs.ai/world/secret' })).toBeNull();
  });

  it('adapts legacy World v1 in memory without mutating or widening the v1 contract', () => {
    const legacy = {
      schemaVersion: 1,
      provider: 'worldlabs',
      worldId: 'legacy-world',
      model: 'marble-1.1',
      displayName: 'Legacy world',
      marbleUrl: 'https://marble.worldlabs.ai/world/legacy-world',
      promptType: 'text',
      assets: {
        splats: { '500k': '/api/outputs/run/world-500k.spz' },
        panorama: '/api/outputs/run/panorama.jpg',
      },
      semantics: {
        metricScaleFactor: 2,
        groundPlaneOffset: 0.25,
        coordinateFrame: 'marble_raw_opencv',
      },
      caption: 'Generated world',
      cost: { credits: 1 },
    };
    const before = structuredClone(legacy);

    expect(parseWorldValue(legacy)).toMatchObject({
      schemaVersion: 1, worldId: legacy.worldId, assets: legacy.assets,
    });
    expect(parseWorldValue(legacy)).not.toHaveProperty('cost');
    const adapted = adaptWorldValueV1ToV2(legacy, {
      sessionId: 'session-adapted',
      createdAtMs: 123,
    });

    expect(legacy).toEqual(before);
    expect(adapted).toMatchObject({
      schemaVersion: 2,
      kind: 'world',
      id: 'legacy-world',
      coordinateSystem: {
        unit: 'custom',
        metersPerUnit: 2,
        originMeters: [0, -0.25, 0],
      },
      session: {
        id: 'session-adapted',
        provider: 'worldlabs',
        model: 'marble-1.1',
        createdAtMs: 123,
      },
      assets: {
        splats: [{ id: '500k', pointCount: 500_000 }],
      },
    });
    expect(Object.hasOwn(adapted ?? {}, 'marbleUrl')).toBe(false);
    expect(Object.hasOwn(adapted?.session ?? {}, 'cost')).toBe(false);
    expect(Object.isFrozen(adapted)).toBe(true);
  });

  it('refuses to adapt v1 values whose only materialized asset is signed or remote', () => {
    const legacy = {
      schemaVersion: 1,
      provider: 'worldlabs',
      worldId: 'legacy-world',
      model: 'marble-1.1',
      displayName: 'Legacy world',
      promptType: 'text',
      assets: {
        splats: { '500k': 'https://cdn.example/world.spz' },
        panorama: '/api/outputs/run/panorama.jpg?signature=secret',
      },
      semantics: { coordinateFrame: 'marble_raw_opencv' },
    };

    expect(adaptWorldValueV1ToV2(legacy)).toBeNull();
  });
});
