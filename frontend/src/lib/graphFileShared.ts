import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

/**
 * The parts of lib/graphFile.ts that startup code uses: the project store
 * normalizes params on every load, and a canvas selection bundle shares the
 * graph bundle's byte limits. graphFile.ts itself (serialize, save, open) is
 * a deferred module loaded at the moment of use (lib/deferredChunks.ts), so
 * these live here, in the startup entry, and graphFile re-exports them.
 */

const RUNTIME_MEDIA_PARAM_KEYS = [
  'sourceDuration',
  'sourceFps',
  'sourceIsVfr',
] as const;

// JSZip holds source bytes until it emits the bundle. World graphs can include
// several SPZ variants, so bound both one response and the aggregate kept in
// memory. The ceilings comfortably cover ordinary 100K/150K/500K previews,
// panoramas, thumbnails, and collider meshes while preventing an imported
// graph from exhausting the browser with arbitrary assets.
export const GRAPH_BUNDLE_MAX_ASSET_BYTES = 256 * 1024 * 1024;
export const GRAPH_BUNDLE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const GRAPH_BUNDLE_MAX_IMPORT_BYTES = GRAPH_BUNDLE_MAX_TOTAL_BYTES + 16 * 1024 * 1024;

/**
 * Media probing used to write runtime metadata into every video-producing
 * node as if it were a provider parameter. Those keys are valid editor state
 * on video-edit, but are not part of provider schemas and therefore made a
 * freshly saved bundle fail strict import validation.
 *
 * Keep declared keys untouched and migrate only undeclared runtime metadata
 * to the private namespace already accepted by the graph API. Running this on
 * both save and load makes future bundles clean and keeps legacy v1-v3 files
 * loadable without weakening backend validation for arbitrary unknown params.
 */
export function normalizeRuntimeMediaParams(
  definitionId: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const definition = NODE_DEFINITIONS[definitionId];
  const declared = new Set(definition?.params.map((param) => param.key) ?? []);
  const normalized = { ...params };

  for (const key of RUNTIME_MEDIA_PARAM_KEYS) {
    if (declared.has(key) || !(key in normalized)) continue;
    const privateKey = `_${key}`;
    if (!(privateKey in normalized)) normalized[privateKey] = normalized[key];
    delete normalized[key];
  }

  return normalized;
}
