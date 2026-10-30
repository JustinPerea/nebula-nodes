import type { WorldSplatRepresentation, WorldValueV2 } from '../types/spatial';
import { isSafeWorldUrl } from './worldValue';

/** The splat a World v2 value previews in 3D: an SPZ first (smaller, and
 * Spark's own format), else a 3DGS PLY (Idol). Null when it has neither at a
 * safe local /api/outputs URL, and then the card shows no "Explore" button. */
export function previewSplat(world: WorldValueV2): WorldSplatRepresentation | null {
  const usable = world.assets.splats.filter((splat) => isSafeWorldUrl(splat.asset.uri));
  return usable.find((splat) => splat.format === 'spz') ?? usable.find((splat) => splat.format === 'ply') ?? null;
}
