import type { ModelNodeDefinition, NodeCategory, PortDataType } from '../types';

export const NODE_BROWSE_TYPES = [
  { id: 'image', label: 'Image', description: 'Images and edits' },
  { id: 'video', label: 'Video', description: 'Animation and editing' },
  { id: 'audio', label: 'Audio', description: 'Speech, music and sound' },
  { id: 'text', label: 'Text', description: 'Prompts and writing' },
  { id: 'import', label: 'Import', description: 'Files and Paper artwork' },
  { id: '3d', label: '3D', description: 'Meshes and worlds' },
  { id: 'workflow', label: 'Workflow', description: 'Batches and routing' },
  { id: 'tools', label: 'Tools', description: 'Analysis and utilities' },
] as const;

export type NodeBrowseType = (typeof NODE_BROWSE_TYPES)[number]['id'];

// These nodes bring existing artwork/files into a graph. Text Input is an
// authoring node, and structured style/moodboard bundles stay with Tools.
const IMPORT_IDS = new Set([
  'paper-source', 'image-input', 'video-input', 'audio-input',
  'document-input', 'style-reference',
]);

// Control flow must take precedence over the media an iterator happens to emit.
const WORKFLOW_IDS = new Set([
  'batch', 'router', 'reroute', 'array-builder', 'array-selector',
  'iterator-image', 'iterator-text',
]);

const GENERATION_TYPES: Partial<Record<NodeCategory, NodeBrowseType>> = {
  'image-gen': 'image',
  'video-gen': 'video',
  'audio-gen': 'audio',
  'text-gen': 'text',
  '3d-gen': '3d',
};

const OUTPUT_TYPES: Partial<Record<PortDataType, NodeBrowseType>> = {
  Image: 'image', SVG: 'image', Mask: 'image',
  Video: 'video', Audio: 'audio', Text: 'text', Mesh: '3d', World: '3d',
};

// Restrict output inference for utility nodes to actual media/text editors.
// A thumbnail, diagnostic frame, embedding or reference bundle is not artwork.
const MEDIA_UTILITY_IDS = new Set([
  'text-input', 'combine-text', 'video-edit', 'remotion-node',
  'mask-painter', 'cinema-color', 'cinema-look',
]);

export function nodeBrowseType(definition: ModelNodeDefinition): NodeBrowseType {
  if (IMPORT_IDS.has(definition.id)) return 'import';
  if (WORKFLOW_IDS.has(definition.id)) return 'workflow';

  const generationType = GENERATION_TYPES[definition.category];
  if (generationType) return generationType;

  // Analyzer ports may contain source previews or diagnostic images. Universal
  // gateways do not promise a fixed medium, except a declared text-only output.
  if (definition.category === 'analyzer') return 'tools';
  if (definition.category === 'universal') {
    return definition.outputPorts.length > 0
      && definition.outputPorts.every((port) => port.dataType === 'Text')
      ? 'text' : 'tools';
  }

  if (definition.category === 'transform' || MEDIA_UTILITY_IDS.has(definition.id)) {
    // The first declared output is the primary result. Do not search subsequent
    // optional/metadata outputs and accidentally advertise an unrelated medium.
    const primaryOutput = definition.outputPorts[0]?.dataType;
    if (primaryOutput) return OUTPUT_TYPES[primaryOutput] ?? 'tools';
  }

  // Advanced/future definitions remain reachable without guessing capabilities.
  return 'tools';
}

export function matchesNodeBrowseType(
  definition: ModelNodeDefinition,
  type: NodeBrowseType,
): boolean {
  return nodeBrowseType(definition) === type;
}

export function nodeBrowseTypeLabel(type: NodeBrowseType): string {
  return NODE_BROWSE_TYPES.find((item) => item.id === type)?.label ?? 'Tools';
}
