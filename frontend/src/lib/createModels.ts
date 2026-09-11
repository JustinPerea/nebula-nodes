import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition, NodeCategory } from '../types';

/** Categories the Create picker exposes (prompt/input -> generation). P1: static nodes only. */
export const CREATE_MODEL_CATEGORIES: NodeCategory[] = [
  'image-gen', 'video-gen', 'audio-gen', '3d-gen', 'text-gen',
];

// Create Studio uses untracked concurrent variation runs. World Labs paid
// starts require the Canvas run ID, Stop, journal recovery, and ambiguity guard,
// so keep the node Canvas-only until Create adopts that execution contract.
export const CREATE_MODEL_EXCLUDED_IDS = new Set(['worldlabs-environment']);

/** Curated shortlist shown under "Featured". Unknown ids are silently dropped. */
export const FEATURED_MODEL_IDS: string[] = [
  'nano-banana', 'flux-1-1-ultra', 'imagen-4-generate', 'gpt-image-1-generate',
  'veo-3', 'kling-v2-1', 'sora-2', 'claude-chat', 'elevenlabs-tts', 'meshy-text-to-3d',
];

export function getCreateModels(): ModelNodeDefinition[] {
  return Object.values(NODE_DEFINITIONS).filter((d) =>
    CREATE_MODEL_CATEGORIES.includes(d.category) && !CREATE_MODEL_EXCLUDED_IDS.has(d.id),
  );
}

export function getFeaturedModels(): ModelNodeDefinition[] {
  return FEATURED_MODEL_IDS
    .map((id) => NODE_DEFINITIONS[id])
    .filter((d): d is ModelNodeDefinition => Boolean(d)
      && CREATE_MODEL_CATEGORIES.includes(d.category)
      && !CREATE_MODEL_EXCLUDED_IDS.has(d.id));
}

export function searchModels(query: string): ModelNodeDefinition[] {
  const q = query.trim().toLowerCase();
  const all = getCreateModels();
  if (!q) return all;
  return all.filter((d) =>
    d.displayName.toLowerCase().includes(q) ||
    String(d.apiProvider).toLowerCase().includes(q) ||
    d.category.toLowerCase().includes(q),
  );
}
