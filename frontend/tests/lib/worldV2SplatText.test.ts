import { describe, expect, it } from 'vitest';
import { gaussianCountText, splatAssetLabel, splatSourceLine } from '../../src/lib/worldV2Splat';
import type { WorldSplatRepresentation, WorldValueV2 } from '../../src/types/spatial';

describe('World v2 splat card text (GM, PR #203 r1)', () => {
  it('counts Gaussians with a plural only past one', () => {
    expect(gaussianCountText(262_144)).toBe('262,144 Gaussians');
    expect(gaussianCountText(1)).toBe('1 Gaussian');
    expect(gaussianCountText(0)).toBe('0 Gaussians');
    expect(gaussianCountText(undefined)).toBeNull();
    expect(gaussianCountText(Number.NaN)).toBeNull();
  });

  it('names the maker with "Speridlabs" capitalised, and the asset as "Splat · PLY"', () => {
    const world = { session: { provider: 'speridlabs', model: 'idol' } } as unknown as WorldValueV2;
    expect(splatSourceLine(world)).toBe('Idol · Speridlabs');
    expect(splatSourceLine({ session: {} } as unknown as WorldValueV2)).toBe('3D splat');
    expect(splatAssetLabel({ format: 'ply' } as WorldSplatRepresentation)).toBe('Splat · PLY');
  });
});
