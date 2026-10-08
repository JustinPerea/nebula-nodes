import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { CATEGORY_LABELS, matchesModelProvider, matchesModelSearch, matchesSearch, modelInputSummary, modelSearchText, providerLabel, supportedModelProviders } from '../../src/lib/modelDiscovery';
import { searchModels } from '../../src/lib/createModels';
import { buildCommands, filterCommands, type PaletteContext } from '../../src/lib/commandPalette';
import type { ModelNodeDefinition } from '../../src/types';

const kling = NODE_DEFINITIONS['krea-video-kling-kling-3-0'];
const context = Object.fromEntries(['addNodeAtCenter', 'runGraph', 'save', 'load', 'fitView',
  'enterCreateView', 'togglePanel', 'startAgentQuery', 'focusNode'].map((name) => [name, () => {}])) as unknown as PaletteContext;
Object.assign(context, { canRun: true, canSave: true, canLoad: true, canvasNodes: [] });

describe('shared model discovery', () => {
  it('uses friendly labels while retaining catalog terms for searching', () => {
    expect(CATEGORY_LABELS['3d-gen']).toBe('3D Generation');
    expect(providerLabel('fal')).toBe('fal.ai');
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('future-provider')).toBe('future-provider');
    expect(matchesModelSearch(NODE_DEFINITIONS['meshy-text-to-3d'], '3d-gen')).toBe(true);
    expect(matchesModelSearch(NODE_DEFINITIONS['meshy-text-to-3d'], '3D generation')).toBe(true);
  });

  it('matches each token in any order and trims insignificant task words', () => {
    expect(matchesSearch('Kling video Image Krea', '  KREA image video  ')).toBe(true);
    expect(matchesModelSearch(kling, 'animate a logo')).toBe(true);
    expect(matchesModelSearch(kling, 'logo animation')).toBe(true);
    expect(matchesModelSearch(kling, 'make a video from my image')).toBe(true);
    expect(matchesModelSearch(kling, 'animate a logo with unavailableword')).toBe(false);
    expect(matchesSearch('abc', 'a')).toBe(true);
    expect(matchesSearch('xyz', 'a')).toBe(false);
    expect(matchesSearch('anything', '')).toBe(true);
  });

  it('does not infer image animation from video category alone', () => {
    const textOnly: ModelNodeDefinition = { ...kling, id: 'text-only-film', displayName: 'Film',
      inputPorts: [{ id: 'prompt', label: 'Prompt', dataType: 'Text', required: true }],
      outputPorts: [{ id: 'video', label: 'Video', dataType: 'Video', required: false }] };
    expect(matchesModelSearch(textOnly, 'animate a logo')).toBe(false);
    expect(matchesModelSearch(textOnly, 'video')).toBe(true);
    expect(matchesModelSearch(NODE_DEFINITIONS['paper-source'], 'animate a logo')).toBe(false);
    const extractor: ModelNodeDefinition = { ...textOnly, category: 'transform',
      inputPorts: [{ id: 'video', label: 'Video', dataType: 'Video', required: true }],
      outputPorts: [{ id: 'image', label: 'Image', dataType: 'Image', required: false }] };
    expect(matchesModelSearch(extractor, 'animate a logo')).toBe(false);
  });

  it('indexes model enum options, input types/labels and real capability notes', () => {
    expect(matchesModelSearch(NODE_DEFINITIONS['nano-banana'], 'Gemini 3 Pro')).toBe(true);
    expect(matchesModelSearch(kling, 'start image')).toBe(true);
    const withNote = { ...kling, capabilityNote: 'Requires explicit camera trajectory.' };
    expect(matchesModelSearch(withNote, 'camera trajectory')).toBe(true);
    expect(modelSearchText(withNote)).toContain(withNote.capabilityNote);
  });

  it('finds actual direct and fallback credential routes independently of catalog provider', () => {
    const dualRoute = { ...kling, apiProvider: 'fal' as const, envKeyName: ['GOOGLE_API_KEY', 'FAL_KEY'],
      directKeyName: 'GOOGLE_API_KEY' };
    expect(matchesModelSearch(dualRoute, 'Google')).toBe(true);
    expect(matchesModelSearch(dualRoute, 'fal.ai')).toBe(true);
    expect(matchesModelSearch(dualRoute, 'Krea')).toBe(true); // preserved in this fixture's model name
  });

  it('filters every declared direct or fallback provider without requiring credentials', () => {
    const veo = NODE_DEFINITIONS['veo-3'];
    const meshy = NODE_DEFINITIONS['meshy-text-to-3d'];
    expect(new Set(supportedModelProviders(veo))).toEqual(new Set(['google', 'fal']));
    expect(new Set(supportedModelProviders(meshy))).toEqual(new Set(['meshy', 'fal']));
    expect(matchesModelProvider(veo, 'fal')).toBe(true);
    expect(matchesModelProvider(veo, 'google')).toBe(true);
    expect(matchesModelProvider(meshy, 'meshy')).toBe(true);
    expect(matchesModelProvider(meshy, 'fal')).toBe(true);
    expect(matchesModelProvider(meshy, '')).toBe(true);
    expect(matchesModelProvider(meshy, 'krea')).toBe(false);
    expect(matchesModelSearch(veo, 'fal.ai')).toBe(true);
    expect(supportedModelProviders(NODE_DEFINITIONS['paper-source'])).toEqual(['utility']);
    expect(supportedModelProviders(NODE_DEFINITIONS['nous-portal-universal'])).toEqual(['nous']);
  });

  it('deduplicates catalog and direct-key providers and does not infer unknown credentials', () => {
    const declared = { ...kling, apiProvider: 'fal' as const, envKeyName: ['FAL_KEY', 'UNKNOWN_KEY', 'toString'],
      directKeyName: 'MESHY_API_KEY' };
    expect(supportedModelProviders(declared)).toEqual(['fal', 'meshy']);
  });

  it('summarizes declared required/optional ports and bounds long rows', () => {
    expect(modelInputSummary(NODE_DEFINITIONS['nano-banana'])).toBe('Prompt + Images (optional) → Image + Text');
    expect(modelInputSummary(NODE_DEFINITIONS['paper-source'])).toBe('No connected inputs → Image');
    expect(modelInputSummary(kling)).toBe('Prompt (optional) + Start image (optional) + End image (optional) + 1 more → Video + All videos + All artifacts + 1 more');
  });

  it('returns the same eligible node IDs in Library, Create and command searches', () => {
    const createMatches = searchModels('animate a logo');
    const libraryMatches = new Set(Object.values(NODE_DEFINITIONS)
      .filter((definition) => matchesModelSearch(definition, 'animate a logo')).map((definition) => definition.id));
    const commandMatches = new Set(filterCommands(buildCommands(context), 'animate a logo')
      .filter((command) => command.group === 'Nodes').map((command) => command.id.slice(5)));
    expect(createMatches.some((definition) => definition.id === kling.id)).toBe(true);
    for (const definition of createMatches) {
      expect(libraryMatches.has(definition.id), definition.id).toBe(true);
      expect(commandMatches.has(definition.id), definition.id).toBe(true);
    }
    expect(commandMatches).toEqual(libraryMatches);
  });
});
