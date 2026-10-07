import { describe, it, expect } from 'vitest';
import {
  CREATE_MODEL_CATEGORIES, getCreateModels, getFeaturedModels, searchModels,
} from '../../src/lib/createModels';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { isPortCompatible } from '../../src/lib/portCompatibility';

describe('createModels', () => {
  it('returns only model-category nodes and excludes utility/universal/cinematic', () => {
    const models = getCreateModels();
    expect(models.length).toBeGreaterThan(20);
    expect(models.every((m) => CREATE_MODEL_CATEGORIES.includes(m.category))).toBe(true);
    expect(models.some((m) => m.id === 'nano-banana')).toBe(true);
    expect(models.some((m) => m.id === 'text-input')).toBe(false);
    expect(models.some((m) => m.id === 'cinema-scene')).toBe(false);
  });

  it('featured returns only ids that exist, in declared order', () => {
    const featured = getFeaturedModels();
    expect(featured.some((m) => m.id === 'nano-banana')).toBe(true);
    // every featured model is a real model node
    const allIds = new Set(getCreateModels().map((m) => m.id));
    expect(featured.every((m) => allIds.has(m.id))).toBe(true);
  });

  it('keeps World Labs out of untracked concurrent Create runs', () => {
    expect(getCreateModels().some((model) => model.id === 'worldlabs-environment')).toBe(false);
    expect(getFeaturedModels().some((model) => model.id === 'worldlabs-environment')).toBe(false);
    expect(searchModels('world labs')).toEqual([]);
  });

  it('search matches display name, provider, and category (case-insensitive)', () => {
    expect(searchModels('nano').some((m) => m.id === 'nano-banana')).toBe(true);
    // Category substring match: a 'VIDEO' search surfaces every video-gen model.
    // It also legitimately surfaces non-video-gen tools whose displayName contains
    // "video" (e.g. MMAudio "Video Foley", an audio-gen node) since matching spans
    // displayName too — so we assert it COVERS video-gen, not that the set is
    // video-gen-only (which a well-named audio tool can correctly violate).
    const videoGen = getCreateModels().filter((m) => m.category === 'video-gen');
    const videoHits = searchModels('VIDEO');
    expect(videoGen.length).toBeGreaterThan(0);
    expect(videoGen.every((vm) => videoHits.some((h) => h.id === vm.id))).toBe(true);
    expect(searchModels('')).toEqual(getCreateModels());
  });

  it('includes Krea originals and gateway image/video models in Create discovery', () => {
    const models = getCreateModels();
    for (const id of ['krea-2-generate', 'krea-image-openai-gpt-image-2', 'krea-video-kling-kling-3-0']) {
      expect(models.find((model) => model.id === id)?.apiProvider).toBe('krea');
    }
    expect(models.find((model) => model.id === 'krea-image-openai-gpt-image-2')?.category).toBe('image-gen');
    expect(models.find((model) => model.id === 'krea-video-kling-kling-3-0')?.category).toBe('video-gen');
    expect(searchModels('KREA').some((model) => model.id === 'krea-image-openai-gpt-image-2')).toBe(true);
    expect(searchModels('kling').some((model) => model.id === 'krea-video-kling-kling-3-0')).toBe(true);
  });

  it('keeps Krea routes requiring structured or video inputs on Canvas', () => {
    const createIds = new Set(getCreateModels().map((model) => model.id));
    const searchIds = new Set(searchModels('Krea').map((model) => model.id));
    for (const id of [
      'krea-image-runway-gen-4-image',
      'krea-video-minimax-h3-max-camera-controls',
      'krea-video-black-forest-labs-flux-video-edit',
    ]) {
      expect(NODE_DEFINITIONS[id]?.apiProvider).toBe('krea');
      expect(createIds.has(id)).toBe(false);
      expect(searchIds.has(id)).toBe(false);
    }
    // Plain image inputs remain accessible through Create's attachment path.
    expect(createIds.has('krea-image-bytedance-seededit')).toBe(true);
    expect(createIds.has('krea-image-xai-grok-imagine-2-edit')).toBe(true);
  });

  it('offers only models whose required ports Create can author', () => {
    for (const model of getCreateModels()) {
      const authoredIds = [
        model.inputPorts.find((port) => port.dataType === 'Text')?.id,
        model.inputPorts.find((port) => port.dataType === 'Image')?.id,
      ];
      const unsupported = model.inputPorts.filter((port) => port.required && !authoredIds.includes(port.id));
      expect(unsupported, model.id).toEqual([]);
    }
  });

  it('keeps required audio, video, masks and distinct end frames discoverable only on Canvas', () => {
    const createIds = new Set(getCreateModels().map((model) => model.id));
    for (const id of ['runway-aleph', 'mmaudio-v2', 'elevenlabs-sts', 'sync-lipsync',
      'flux-fill-inpaint', 'ideogram-edit', 'veo-3-flf']) {
      const definition = NODE_DEFINITIONS[id];
      expect(definition, id).toBeDefined();
      expect(createIds.has(id), id).toBe(false);
      expect(getFeaturedModels().some((model) => model.id === id), id).toBe(false);
      expect(searchModels(definition.displayName).some((model) => model.id === id), id).toBe(false);
    }
    expect(createIds.has('nano-banana')).toBe(true);
    expect(createIds.has('krea-video-kling-kling-3-0')).toBe(true);
  });

  it('keeps GPT Image prompts separate from multiple typed Paper artwork references', () => {
    const model = getCreateModels().find((item) => item.id === 'krea-image-openai-gpt-image-2')!;
    const prompt = model.inputPorts.find((port) => port.id === 'prompt')!;
    const references = model.inputPorts.find((port) => port.id === 'image_urls')!;
    const paperImage = NODE_DEFINITIONS['paper-source'].outputPorts.find((port) => port.id === 'image')!;
    // The required request prompt may come from its control or its typed wire.
    expect(prompt).toMatchObject({ dataType: 'Text', required: false });
    expect(model.params.find((param) => param.key === 'prompt')).toMatchObject({ required: true, type: 'textarea' });
    expect(references).toMatchObject({ dataType: 'Image', multiple: true, maxConnections: 10 });
    expect(isPortCompatible(paperImage.dataType, references.dataType)).toBe(true);
    expect(isPortCompatible(paperImage.dataType, prompt.dataType)).toBe(false);
    expect(model.outputPorts).toContainEqual(expect.objectContaining({ id: 'image', dataType: 'Image' }));
  });

  it('exposes Kling start/end artwork as typed image inputs and its result as Video', () => {
    const model = getCreateModels().find((item) => item.id === 'krea-video-kling-kling-3-0')!;
    const paperImage = NODE_DEFINITIONS['paper-source'].outputPorts.find((port) => port.id === 'image')!;
    for (const id of ['start_image', 'end_image']) {
      const port = model.inputPorts.find((item) => item.id === id)!;
      expect(port).toMatchObject({ dataType: 'Image', required: false });
      expect(isPortCompatible(paperImage.dataType, port.dataType)).toBe(true);
    }
    expect(model.outputPorts).toContainEqual(expect.objectContaining({ id: 'video', dataType: 'Video' }));
  });
});
