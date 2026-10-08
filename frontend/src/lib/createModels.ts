import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition, NodeCategory } from '../types';
import { matchesModelSearch } from './modelDiscovery';

/** Categories the Create picker exposes (prompt/input -> generation). P1: static nodes only. */
export const CREATE_MODEL_CATEGORIES: NodeCategory[] = [
  'image-gen', 'video-gen', 'audio-gen', '3d-gen', 'text-gen',
];

// World Labs remains Canvas-only until Create supports its paid-start recovery
// and explicit iteration controls.
export const CREATE_MODEL_EXCLUDED_IDS = new Set([
  'worldlabs-environment',
  // These Krea routes need structured references, a camera trajectory, or a
  // video input. Canvas exposes those controls; Create's image attachments
  // and scalar parameter pills cannot complete these requests.
  'krea-image-runway-gen-4-image',
  'krea-video-minimax-h3-max-camera-controls',
  'krea-video-black-forest-labs-flux-video-edit',
]);

/** Curated shortlist shown under "Featured". Unknown ids are silently dropped. */
export const FEATURED_MODEL_IDS: string[] = [
  'nano-banana', 'flux-1-1-ultra', 'imagen-4-generate', 'gpt-image-1-generate',
  'veo-3', 'kling-v2-1', 'sora-2', 'claude-chat', 'elevenlabs-tts', 'meshy-text-to-3d',
];

/** Create authors one prompt port and one image-reference port. Required media
 *  on any other port needs the Canvas's dedicated input controls. */
export function isCreateModel(definition: ModelNodeDefinition): boolean {
  if (!CREATE_MODEL_CATEGORIES.includes(definition.category)
    || CREATE_MODEL_EXCLUDED_IDS.has(definition.id)) return false;

  const textPort = definition.inputPorts.find((port) => port.dataType === 'Text');
  const imagePort = definition.inputPorts.find((port) => port.dataType === 'Image');
  return definition.inputPorts.every((port) => !port.required
    || port.id === textPort?.id || port.id === imagePort?.id);
}

export function getCreateModels(): ModelNodeDefinition[] {
  return Object.values(NODE_DEFINITIONS).filter(isCreateModel);
}

export function getFeaturedModels(): ModelNodeDefinition[] {
  return FEATURED_MODEL_IDS
    .map((id) => NODE_DEFINITIONS[id])
    .filter((d): d is ModelNodeDefinition => Boolean(d) && isCreateModel(d));
}

export function searchModels(query: string): ModelNodeDefinition[] {
  const all = getCreateModels();
  return all.filter((definition) => matchesModelSearch(definition, query));
}
