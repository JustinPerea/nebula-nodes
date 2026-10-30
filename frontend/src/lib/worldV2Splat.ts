import type { WorldSplatRepresentation, WorldValueV2 } from '../types/spatial';
import { isSafeWorldUrl } from './worldValue';

/** The splat a World v2 value previews in 3D: an SPZ first (smaller, and
 * Spark's own format), else a 3DGS PLY (Idol). Null when it has neither at a
 * safe local /api/outputs URL, and then the card shows no "Explore" button. */
export function previewSplat(world: WorldValueV2): WorldSplatRepresentation | null {
  const usable = world.assets.splats.filter((splat) => isSafeWorldUrl(splat.asset.uri));
  return usable.find((splat) => splat.format === 'spz') ?? usable.find((splat) => splat.format === 'ply') ?? null;
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { speridlabs: 'Speridlabs', worldlabs: 'World Labs' };
const MODEL_NAMES: Readonly<Record<string, string>> = { idol: 'Idol' };

/** "Idol · Speridlabs": the model and maker as their makers spell them
 * (GM: "Speridlabs" on the card, never the id). */
export function splatSourceLine(world: WorldValueV2): string {
  const model = world.session.model ? MODEL_NAMES[world.session.model] ?? world.session.model : null;
  const provider = world.session.provider ? PROVIDER_NAMES[world.session.provider] ?? world.session.provider : null;
  return [model, provider].filter(Boolean).join(' · ') || '3D splat';
}

/** "262,144 Gaussians", "1 Gaussian"; null without a count. */
export function gaussianCountText(count: number | undefined): string | null {
  if (count === undefined || !Number.isFinite(count) || count < 0) return null;
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'Gaussian' : 'Gaussians'}`;
}

/** "Splat · PLY": the asset row on the card and in the dialog. */
export function splatAssetLabel(splat: WorldSplatRepresentation): string {
  return `Splat · ${splat.format.toUpperCase()}`;
}
