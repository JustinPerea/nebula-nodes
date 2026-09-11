import type { PortValue, WorldValue } from '../types';

export type WorldSplatResolution = string;

export interface WorldSplatOption {
  id: WorldSplatResolution;
  label: string;
  detail: string;
  url: string;
}

const SPLAT_META: Record<string, Pick<WorldSplatOption, 'label' | 'detail'>> = {
  '100k': { label: 'Preview', detail: '100K splats' },
  '150k': { label: 'Light', detail: '150K splats' },
  '500k': { label: 'Standard', detail: '500K splats' },
  full_res: { label: 'Full', detail: 'Full resolution' },
};

const KNOWN_SPLAT_ORDER = ['100k', '150k', '500k', 'full_res'] as const;
export const MAX_WORLD_SPLAT_VARIANTS = 64;
const WORLD_OUTPUT_PATH_PREFIX = '/api/outputs/';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof ArrayBuffer);
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parse the versioned World value at the UI boundary. Camel-case is canonical;
 * snake-case aliases keep old imported runs viewable without weakening the
 * graph contract everywhere else.
 */
export function parseWorldValue(value: PortValue['value'] | unknown): WorldValue | null {
  if (!isRecord(value)) return null;

  const schemaVersion = Object.prototype.hasOwnProperty.call(value, 'schemaVersion')
    ? value.schemaVersion : value.schema_version;
  const provider = readString(value, 'provider');
  const worldId = readString(value, 'worldId', 'world_id');
  if (schemaVersion !== 1 || provider !== 'worldlabs' || !worldId) return null;
  const model = readString(value, 'model') ?? 'marble';
  const displayName = readString(value, 'displayName', 'display_name') ?? worldId;
  const caption = readString(value, 'caption');
  // Python's contract lengths count Unicode code points, not UTF-16 units.
  const validMetadata = (text: string, limit: number) => (
    Array.from(text).length <= limit && text === text.trim() && !hasControlCharacters(text)
  );
  if (!validMetadata(worldId, 128) || !validMetadata(model, 128)
    || !validMetadata(displayName, 256)
    || (caption !== undefined && !validMetadata(caption, 256))) return null;

  if (!isRecord(value.assets) || !isRecord(value.assets.splats)) return null;
  if (value.semantics !== undefined && !isRecord(value.semantics)) return null;
  const assetsRaw = value.assets;
  const splatsRaw = value.assets.splats;
  const semanticsRaw = value.semantics === undefined ? {} : value.semantics as Record<string, unknown>;
  // Match the versioned backend bound before walking entries. Never silently
  // discard representations from an otherwise accepted World bundle.
  if (Object.keys(splatsRaw).length > MAX_WORLD_SPLAT_VARIANTS) return null;

  const splatEntries = new Map<string, string>();
  let invalidAsset = false;
  const addSplat = (rawVariant: string, rawUrl: unknown) => {
    if (splatEntries.size >= MAX_WORLD_SPLAT_VARIANTS) return;
    // Variant labels are provider data and may grow beyond today's simple LOD
    // tokens. Preserve punctuation such as future/a and future?a, but reject
    // prototype keys, control characters, and unbounded labels from imports.
    if (
      rawVariant.length === 0
      || Array.from(rawVariant).length > 128
      || rawVariant !== rawVariant.trim()
      || hasControlCharacters(rawVariant)
      || ['__proto__', 'prototype', 'constructor'].includes(rawVariant)
    ) { invalidAsset = true; return; }
    if (rawUrl === null) return;
    if (typeof rawUrl !== 'string') { invalidAsset = true; return; }
    const assetUrl = normalizedWorldAssetUrl(rawUrl);
    if (!assetUrl) { invalidAsset = true; return; }
    const variant = rawVariant === 'full' || rawVariant === 'fullRes' ? 'full_res' : rawVariant;
    if (!splatEntries.has(variant)) splatEntries.set(variant, assetUrl);
  };
  // Preserve input order and first alias occurrence, matching the backend.
  // Display ordering and preview selection are separate presentation policies.
  for (const rawVariant in splatsRaw) {
    if (splatEntries.size >= MAX_WORLD_SPLAT_VARIANTS) break;
    if (Object.prototype.hasOwnProperty.call(splatsRaw, rawVariant)) {
      addSplat(rawVariant, splatsRaw[rawVariant]);
    }
  }
  if (invalidAsset || splatEntries.size === 0) return null;
  const splats = Object.fromEntries(splatEntries) as WorldValue['assets']['splats'];
  for (const key of ['panorama', 'thumbnail', 'colliderMesh', 'collider_mesh']) {
    const asset = assetsRaw[key];
    if (asset != null && (typeof asset !== 'string' || !normalizedWorldAssetUrl(asset))) return null;
  }
  const safeAsset = (...keys: string[]): string | undefined => {
    const asset = readString(assetsRaw, ...keys);
    return normalizedWorldAssetUrl(asset);
  };
  const rawCoordinateFrame = readString(semanticsRaw, 'coordinateFrame', 'coordinate_frame');
  // Early in-progress bundles used the deliberately vague provider_native
  // label. All Marble API splats represented by this v1 contract are the raw
  // OpenCV assets, so normalize the legacy label at the UI boundary.
  const coordinateFrame = !rawCoordinateFrame || rawCoordinateFrame === 'provider_native'
    ? 'marble_raw_opencv'
    : rawCoordinateFrame;
  if (coordinateFrame !== 'marble_raw_opencv') return null;
  const scale = readNumber(semanticsRaw, 'metricScaleFactor', 'metric_scale_factor');
  if (scale !== undefined && scale <= 0) return null;

  return {
    schemaVersion: 1,
    provider: 'worldlabs',
    worldId,
    model,
    displayName,
    marbleUrl: `https://marble.worldlabs.ai/world/${encodeURIComponent(worldId)}`,
    promptType: readString(value, 'promptType', 'prompt_type') ?? 'text',
    assets: {
      splats,
      panorama: safeAsset('panorama'),
      colliderMesh: safeAsset('colliderMesh', 'collider_mesh'),
      thumbnail: safeAsset('thumbnail'),
    },
    semantics: {
      metricScaleFactor: readNumber(semanticsRaw, 'metricScaleFactor', 'metric_scale_factor'),
      groundPlaneOffset: readNumber(semanticsRaw, 'groundPlaneOffset', 'ground_plane_offset'),
      coordinateFrame,
    },
    caption,
  };
}

export function worldSplatOptions(world: WorldValue): WorldSplatOption[] {
  const remaining = Object.keys(world.assets.splats)
    .filter((id) => !KNOWN_SPLAT_ORDER.includes(id as (typeof KNOWN_SPLAT_ORDER)[number]))
    .sort();
  return [...KNOWN_SPLAT_ORDER, ...remaining].flatMap((id) => {
    const url = world.assets.splats[id];
    if (!url) return [];
    const meta = SPLAT_META[id] ?? {
      label: id.replaceAll('_', ' '),
      detail: `${id.replaceAll('_', ' ')} splats`,
    };
    return [{ id, url, ...meta }];
  });
}

export function initialWorldResolution(
  world: WorldValue,
  preferLowBandwidth: boolean,
): WorldSplatResolution | null {
  const available = new Set(worldSplatOptions(world).map((option) => option.id));
  const preference: WorldSplatResolution[] = preferLowBandwidth
    ? ['100k', '150k', '500k']
    : ['500k', '150k', '100k'];
  // Full resolution and unknown future variants can be unexpectedly large.
  // Keep them visible as explicit choices, but never fetch one merely because
  // it is the only asset in an imported or provider-returned World value.
  return preference.find((resolution) => available.has(resolution)) ?? null;
}

export function isSafeWorldUrl(value: string | undefined): value is string {
  if (!value || value !== value.trim() || hasControlCharacters(value)) return false;
  try {
    const localOrigin = new URL('https://nebula.invalid/');
    const url = new URL(value, localOrigin);
    const isRelative = value.startsWith('/');
    const isLocalBackend = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      (!isRelative && !isLocalBackend)
      || (isRelative && url.origin !== localOrigin.origin)
      || (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.hash
      || url.search
      || !url.pathname.startsWith(WORLD_OUTPUT_PATH_PREFIX)
    ) return false;

    const encodedSegments = url.pathname.slice(WORLD_OUTPUT_PATH_PREFIX.length).split('/');
    const segments = encodedSegments.map((segment) => decodeURIComponent(segment));
    return segments.some(Boolean) && segments.every((segment) => (
      Boolean(segment)
      && segment !== '.'
      && segment !== '..'
      && !hasControlCharacters(segment)
      && !segment.includes('/')
      && !segment.includes('\\')
      && !segment.includes('?')
      && !segment.includes('#')
    ));
  } catch {
    return false;
  }
}

function normalizedWorldAssetUrl(value: string | undefined): string | undefined {
  if (!isSafeWorldUrl(value)) return undefined;
  const url = new URL(value, 'https://nebula.invalid/');
  return `${url.pathname}${url.search}`;
}

export function isSafeMarbleUrl(value: string | undefined): value is string {
  if (!value || value !== value.trim() || hasControlCharacters(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (url.hostname === 'marble.worldlabs.ai' || url.hostname.endsWith('.worldlabs.ai'));
  } catch {
    return false;
  }
}
