import type { VideoGraphManifest, TrackComponentType } from '../../types/video';

const VALID_COMPONENT_TYPES: ReadonlySet<TrackComponentType> = new Set([
  'SVGInput',
  'ImageAssetNode',
  'TextNode',
  'VideoAssetNode',
  'IsometricBlock',
  'LottieNode',
]);

type ValidationResult =
  | { ok: true; manifest: VideoGraphManifest }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateTrackItem(item: unknown, index: number): string | null {
  if (!isObject(item)) return `timeline[${index}] is not an object`;
  if (typeof item.id !== 'string') return `timeline[${index}].id must be a string`;
  if (typeof item.sourceNodeId !== 'string') return `timeline[${index}].sourceNodeId must be a string`;
  if (
    typeof item.componentType !== 'string' ||
    !VALID_COMPONENT_TYPES.has(item.componentType as TrackComponentType)
  ) {
    return `timeline[${index}].componentType is not a known type`;
  }
  if (!isObject(item.time)) return `timeline[${index}].time missing`;
  if (typeof (item.time as Record<string, unknown>).startFrame !== 'number') {
    return `timeline[${index}].time.startFrame must be number`;
  }
  if (typeof (item.time as Record<string, unknown>).durationInFrames !== 'number') {
    return `timeline[${index}].time.durationInFrames must be number`;
  }
  if (!isObject(item.spatial)) return `timeline[${index}].spatial missing`;
  if (!isObject(item.keyframes)) return `timeline[${index}].keyframes must be an object`;
  if (!isObject(item.props)) return `timeline[${index}].props must be an object`;
  return null;
}

export function validateManifest(value: unknown): ValidationResult {
  if (!isObject(value)) return { ok: false, error: 'manifest must be an object' };

  const graph = value.graph;
  if (!isObject(graph)) return { ok: false, error: 'manifest.graph must be an object' };
  if (!Array.isArray(graph.nodes)) return { ok: false, error: 'manifest.graph.nodes must be array' };
  if (!Array.isArray(graph.edges)) return { ok: false, error: 'manifest.graph.edges must be array' };

  if (!Array.isArray(value.timeline)) {
    return { ok: false, error: 'manifest.timeline must be an array' };
  }

  for (let i = 0; i < value.timeline.length; i++) {
    const err = validateTrackItem(value.timeline[i], i);
    if (err) return { ok: false, error: err };
  }

  return { ok: true, manifest: value as unknown as VideoGraphManifest };
}
