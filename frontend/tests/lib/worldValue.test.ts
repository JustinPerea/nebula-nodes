// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  initialWorldResolution,
  isSafeMarbleUrl,
  isSafeWorldUrl,
  MAX_WORLD_SPLAT_VARIANTS,
  parseWorldValue,
  worldSplatOptions,
} from '../../src/lib/worldValue';

const canonical = {
  schemaVersion: 1,
  provider: 'worldlabs',
  worldId: 'world-123',
  model: 'marble-1.1',
  displayName: 'Moonlit courtyard',
  marbleUrl: 'https://marble.worldlabs.ai/world/world-123',
  promptType: 'text',
  assets: {
    splats: {
      '100k': '/api/outputs/run/world-100k.spz',
      '150k': '/api/outputs/run/world-150k.spz',
      '500k': '/api/outputs/run/world-500k.spz',
      full_res: '/api/outputs/run/world-full.spz',
      future_lod: '/api/outputs/run/world-future.spz',
    },
    panorama: '/api/outputs/run/panorama.jpg',
    colliderMesh: '/api/outputs/run/collider.glb',
    thumbnail: '/api/outputs/run/thumb.jpg',
  },
  semantics: {
    metricScaleFactor: 1.25,
    groundPlaneOffset: -0.1,
    coordinateFrame: 'marble_raw_opencv',
  },
  caption: 'A moonlit courtyard',
};

describe('parseWorldValue', () => {
  it('preserves the canonical v1 World Labs value', () => {
    expect(parseWorldValue(canonical)).toEqual(canonical);
  });

  it('accepts snake-case aliases only at the UI boundary', () => {
    const parsed = parseWorldValue({
      schema_version: 1,
      provider: 'worldlabs',
      world_id: 'legacy-world',
      display_name: 'Legacy world',
      marble_url: 'https://marble.worldlabs.ai/world/legacy-world',
      prompt_type: 'multi-image',
      assets: {
        splats: {
          '100k': '/api/outputs/preview.spz',
          full: '/api/outputs/full.spz',
        },
        collider_mesh: '/api/outputs/collider.glb',
      },
      semantics: {
        metric_scale_factor: 2,
        ground_plane_offset: 0.5,
        coordinate_frame: 'marble_raw_opencv',
      },
    });

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      worldId: 'legacy-world',
      displayName: 'Legacy world',
      promptType: 'multi-image',
      assets: {
        splats: {
          '100k': '/api/outputs/preview.spz',
          full_res: '/api/outputs/full.spz',
        },
        colliderMesh: '/api/outputs/collider.glb',
      },
      semantics: { metricScaleFactor: 2, groundPlaneOffset: 0.5 },
    });
  });

  it('normalizes legacy provider_native values to the Marble raw OpenCV frame', () => {
    expect(parseWorldValue({
      ...canonical,
      semantics: { coordinateFrame: 'provider_native' },
    })?.semantics.coordinateFrame).toBe('marble_raw_opencv');
    expect(parseWorldValue({
      ...canonical,
      semantics: {},
    })?.semantics.coordinateFrame).toBe('marble_raw_opencv');
  });

  it('rejects unknown versions, providers, and missing world IDs', () => {
    expect(parseWorldValue({ ...canonical, schemaVersion: 2 })).toBeNull();
    expect(parseWorldValue({ ...canonical, provider: 'atlas' })).toBeNull();
    expect(parseWorldValue({ ...canonical, worldId: '' })).toBeNull();
    expect(parseWorldValue('/api/outputs/world.spz')).toBeNull();
  });

  it('matches backend metadata bounds using Unicode code points', () => {
    expect(parseWorldValue({ ...canonical, worldId: 'x'.repeat(129) })).toBeNull();
    expect(parseWorldValue({ ...canonical, model: ' marble-1.1' })).toBeNull();
    expect(parseWorldValue({ ...canonical, caption: 'x'.repeat(257) })).toBeNull();
    expect(parseWorldValue({ ...canonical, worldId: '🌍'.repeat(128) })).not.toBeNull();
    expect(parseWorldValue({ ...canonical, worldId: '🌍'.repeat(129) })).toBeNull();
  });
});

describe('world resolution policy', () => {
  it('lists materialized resolutions and defaults desktop to 500K', () => {
    const world = parseWorldValue(canonical)!;
    expect(worldSplatOptions(world).map((option) => option.id)).toEqual([
      '100k',
      '150k',
      '500k',
      'full_res',
      'future_lod',
    ]);
    expect(initialWorldResolution(world, false)).toBe('500k');
  });

  it('defaults constrained/mobile clients to 100K and never auto-loads an unbounded asset', () => {
    const world = parseWorldValue(canonical)!;
    expect(initialWorldResolution(world, true)).toBe('100k');
    world.assets.splats = { full_res: '/full.spz' };
    expect(initialWorldResolution(world, false)).toBeNull();
  });

  it('retains future provider variants, including URL punctuation, but requires explicit selection', () => {
    const world = parseWorldValue({
      ...canonical,
      assets: {
        splats: Object.fromEntries([
          ['experimental/v2?quality=max', '/api/outputs/experimental.spz'],
        ]),
      },
    })!;
    expect(world.assets.splats).toEqual({
      'experimental/v2?quality=max': '/api/outputs/experimental.spz',
    });
    expect(worldSplatOptions(world)[0]).toMatchObject({
      id: 'experimental/v2?quality=max',
      url: '/api/outputs/experimental.spz',
    });
    expect(initialWorldResolution(world, false)).toBeNull();
  });

  it('rejects oversized imported variant maps instead of silently truncating', () => {
    const unknown = Object.fromEntries(
      Array.from({ length: MAX_WORLD_SPLAT_VARIANTS + 20 }, (_, index) => [
        `future_${index}`,
        `/api/outputs/future-${index}.spz`,
      ]),
    );
    const world = parseWorldValue({
      ...canonical,
      assets: {
        splats: {
          ...unknown,
          '100k': '/api/outputs/preview.spz',
          '500k': '/api/outputs/standard.spz',
        },
      },
    });

    expect(world).toBeNull();
  });
});

describe('world URL safety', () => {
  it('does not rescue an invalid canonical version with a legacy alias', () => {
    for (const schemaVersion of [null, true, '1', 2]) {
      expect(parseWorldValue({ ...canonical, schemaVersion, schema_version: 1 })).toBeNull();
    }
  });
  it('validates both collider aliases and falls back from null', () => {
    const assets = { ...canonical.assets, colliderMesh: null, collider_mesh: '/api/outputs/run/mesh.glb' };
    expect(parseWorldValue({ ...canonical, assets })?.assets.colliderMesh).toBe('/api/outputs/run/mesh.glb');
    expect(parseWorldValue({ ...canonical, assets: { ...assets, colliderMesh: '/api/outputs/run/mesh.glb', collider_mesh: 'https://invalid.example/secret' } })).toBeNull();
  });
  it('validates duplicate alias assets and skips null aliases without reserving them', () => {
    const withSplats = (splats: Record<string, unknown>) => ({ ...canonical, assets: { splats } });
    expect(parseWorldValue(withSplats({ full: null, full_res: '/api/outputs/run/full.spz' }))?.assets.splats.full_res)
      .toBe('/api/outputs/run/full.spz');
    expect(parseWorldValue(withSplats({ full: '/api/outputs/run/full.spz', full_res: 'https://invalid.example/secret' }))).toBeNull();
    expect(parseWorldValue(withSplats({ constructor: null, full: '/api/outputs/run/full.spz' }))).toBeNull();
  });
  it('allows only Nebula output assets and rejects arbitrary remote or local routes', () => {
    expect(isSafeWorldUrl('/api/outputs/world.spz')).toBe(true);
    expect(isSafeWorldUrl('http://localhost:8007/api/outputs/run/world.spz')).toBe(true);
    expect(isSafeWorldUrl('https://assets.worldlabs.ai/world.spz')).toBe(false);
    expect(isSafeWorldUrl('http://127.0.0.1:9000/private')).toBe(false);
    expect(isSafeWorldUrl('/api/settings')).toBe(false);
    expect(isSafeWorldUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeWorldUrl('//evil.example/world.spz')).toBe(false);
    expect(isSafeWorldUrl('/\\evil.example/world.spz')).toBe(false);
    expect(isSafeWorldUrl('\\\\evil.example/world.spz')).toBe(false);
    expect(isSafeWorldUrl(' /api/outputs/world.spz')).toBe(false);
    expect(isSafeWorldUrl('/api/outputs/world.spz ')).toBe(false);
    expect(isSafeWorldUrl('/api/outputs/\nworld.spz')).toBe(false);
    expect(isSafeWorldUrl('/api/outputs/%2e%2e/settings')).toBe(false);
    expect(isSafeWorldUrl('/api/outputs/run%2Fsecret.spz')).toBe(false);
    expect(isSafeWorldUrl('/api/outputs/run%2fsecret.spz')).toBe(false);
    expect(isSafeWorldUrl('/api/outputs/world.spz#fragment')).toBe(false);
    expect(isSafeWorldUrl('/api/outputs/world.spz?token=secret')).toBe(false);
  });

  it('rejects a World with invalid assets instead of silently dropping them', () => {
    expect(parseWorldValue({
      ...canonical,
      assets: {
        splats: {
          '100k': 'http://127.0.0.1:9090/private',
          '500k': 'https://tracker.example/world.spz',
        },
        thumbnail: 'https://tracker.example/pixel.gif',
        panorama: '/api/outputs/run/panorama.jpg',
      },
    })).toBeNull();
  });

  it('normalizes localhost backend assets to portable output routes', () => {
    expect(parseWorldValue({
      ...canonical,
      assets: {
        splats: {
          '500k': 'http://localhost:8007/api/outputs/run/world.spz',
        },
      },
    })?.assets.splats['500k']).toBe('/api/outputs/run/world.spz');
  });

  it('only opens Marble links hosted by World Labs', () => {
    expect(isSafeMarbleUrl('https://marble.worldlabs.ai/world/123')).toBe(true);
    expect(isSafeMarbleUrl('https://app.worldlabs.ai/world/123')).toBe(true);
    expect(isSafeMarbleUrl('http://marble.worldlabs.ai/world/123')).toBe(false);
    expect(isSafeMarbleUrl(' https://marble.worldlabs.ai/world/123')).toBe(false);
    expect(isSafeMarbleUrl('https://evil.example/world/123')).toBe(false);
  });
});
