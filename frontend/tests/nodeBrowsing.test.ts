import { describe, expect, it } from 'vitest';
import backendCatalog from '../../backend/data/node_definitions.json';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { matchesNodeBrowseType, NODE_BROWSE_TYPES, type NodeBrowseType } from '../src/lib/nodeBrowsing';
import type { ModelNodeDefinition, PortDataType } from '../src/types';

function expectType(id: string, type: NodeBrowseType) {
  const definition = NODE_DEFINITIONS[id];
  expect(definition, `${id} exists`).toBeDefined();
  const matches = NODE_BROWSE_TYPES.filter((choice) => matchesNodeBrowseType(definition, choice.id));
  expect(matches.map((choice) => choice.id), id).toEqual([type]);
}

function withOutputs(category: ModelNodeDefinition['category'], types: PortDataType[]): ModelNodeDefinition {
  return {
    ...NODE_DEFINITIONS['paper-source'], id: 'future-node', category,
    outputPorts: types.map((dataType, index) => ({
      id: `output-${index}`, label: `Output ${index}`, dataType, required: false,
    })),
  };
}

describe('type-first node browsing', () => {
  it('offers compact task choices with distinct identifiers', () => {
    expect(NODE_BROWSE_TYPES.map((type) => type.id)).toEqual([
      'image', 'video', 'audio', 'text', 'import', '3d', 'workflow', 'tools',
    ]);
    for (const type of NODE_BROWSE_TYPES) {
      expect(type.label).toBeTruthy();
      expect(type.description).toBeTruthy();
    }
  });

  it.each([
    ['frontend', Object.values(NODE_DEFINITIONS)],
    ['backend source of truth', Object.values(backendCatalog) as ModelNodeDefinition[]],
  ])('keeps every real %s definition reachable through exactly one choice', (_catalog, definitions) => {
    expect(definitions.length).toBeGreaterThan(200);
    for (const definition of definitions) {
      const matches = NODE_BROWSE_TYPES.filter((choice) => matchesNodeBrowseType(definition, choice.id));
      expect(matches.length, definition.id).toBe(1);
    }
  });

  it.each([
    'paper-source', 'image-input', 'video-input', 'audio-input',
    'document-input', 'style-reference',
  ])('puts existing-source node %s in Import', (id) => {
    expectType(id, 'import');
  });

  it.each([
    'batch', 'router', 'reroute', 'array-builder', 'array-selector',
    'iterator-image', 'iterator-text',
  ])('puts actual graph control %s in Workflow', (id) => {
    expectType(id, 'workflow');
  });

  it.each([
    ['gpt-image-2-generate', 'image'], ['nano-banana', 'image'], ['recraft-v4-svg', 'image'],
    ['veo-3', 'video'], ['krea-video-kling-kling-3-0', 'video'],
    ['elevenlabs-stt', 'audio'], ['mmaudio-v2', 'audio'], ['kling-video-to-audio', 'audio'],
    ['claude-chat', 'text'], ['ideogram-magic-prompt', 'text'],
    ['worldlabs-environment', '3d'], ['meshy-rigging', '3d'],
  ] as const)('uses the declared generation category for %s', (id, type) => {
    expectType(id, type);
  });

  it('does not classify generation thumbnails, captions or inputs as primary artwork', () => {
    const video = { ...NODE_DEFINITIONS['veo-3'],
      outputPorts: withOutputs('video-gen', ['Image', 'Text', 'Video']).outputPorts };
    expect(matchesNodeBrowseType(video, 'video')).toBe(true);
    expect(matchesNodeBrowseType(video, 'image')).toBe(false);
    expect(matchesNodeBrowseType(video, 'text')).toBe(false);
    expect(matchesNodeBrowseType(NODE_DEFINITIONS['worldlabs-environment'], 'image')).toBe(false);
  });

  it.each([
    ['frame-extractor', 'image'], ['svg-rasterize', 'image'], ['remove-background', 'image'],
    ['seedvr-video-upscale', 'video'], ['worldlabs-world-export', '3d'],
    ['text-input', 'text'], ['combine-text', 'text'],
    ['video-edit', 'video'], ['remotion-node', 'video'], ['mask-painter', 'image'],
    ['cinema-color', 'image'], ['cinema-look', 'image'],
  ] as const)('groups editor/transform %s by its actual primary output', (id, type) => {
    expectType(id, type);
  });

  it.each([
    ['SVG', 'image'], ['Mask', 'image'], ['Video', 'video'],
    ['Audio', 'audio'], ['Text', 'text'], ['Mesh', '3d'], ['World', '3d'],
  ] as const)('handles a future transform with primary %s output', (output, type) => {
    expect(matchesNodeBrowseType(withOutputs('transform', [output, 'Text']), type)).toBe(true);
  });

  it('does not infer a transform medium from a later optional output', () => {
    const transform = withOutputs('transform', ['Any', 'Image', 'Video']);
    expect(matchesNodeBrowseType(transform, 'tools')).toBe(true);
    expect(matchesNodeBrowseType(transform, 'image')).toBe(false);
    expect(matchesNodeBrowseType(withOutputs('transform', []), 'tools')).toBe(true);
  });

  it.each(['openrouter-universal', 'nous-portal-universal'])('keeps declared text-only gateway %s in Text', (id) => {
    expectType(id, 'text');
  });

  it.each([
    'fal-universal', 'replicate-universal', 'video-understanding', 'ideogram-describe',
    'qc-frame-review', 'qc-camera-geometry', 'krea-style-search', 'gemini-embeddings',
    'character', 'nebula-moodboard', 'krea-moodboard', 'krea-style',
    'krea-image-style-reference', 'camera-rig', 'camera-pose', 'camera-path',
    'spatial-context', 'sensor-rig', 'spatial-value-validate', 'reference-set',
    'preview', 'image-compare', 'sticky-note', 'cinema-scene',
  ])('keeps advanced or analysis node %s in Tools', (id) => {
    expectType(id, 'tools');
  });

  it('requires all universal outputs to be Text and leaves future utility media in Tools', () => {
    expect(matchesNodeBrowseType(withOutputs('universal', ['Text', 'Image']), 'tools')).toBe(true);
    expect(matchesNodeBrowseType(withOutputs('universal', []), 'tools')).toBe(true);
    expect(matchesNodeBrowseType(withOutputs('utility', ['Image']), 'tools')).toBe(true);
    expect(matchesNodeBrowseType(withOutputs('analyzer', ['Image']), 'tools')).toBe(true);
  });
});
