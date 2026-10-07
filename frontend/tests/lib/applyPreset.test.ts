import { describe, it, expect } from 'vitest';
import { applyPresetToComposer } from '../../src/lib/applyPreset';
import type { Preset } from '../../src/lib/createPresets';

function preset(over: Partial<Preset>): Preset {
  return { id: 'p', name: 'N', category: 'C', prompt: '', params: {}, modelId: null, refImages: [],
    thumbnail: '', version: 1, scope: 'global', projectId: null, createdAt: '', updatedAt: '', ...over };
}

describe('applyPresetToComposer', () => {
  it('retains a saved Krea preset billing choice despite the new-node default', () => {
    const out = applyPresetToComposer(preset({ modelId: 'krea-image-openai-gpt-image-2',
      params: { _kreaAuth: 'mcp' } }), { modelId: null, prompt: '', params: {} }, {}, 'api-token');
    expect(out.params._kreaAuth).toBe('mcp');
  });

  it('keeps an older Krea preset on API billing when the new-node default is OAuth', () => {
    const out = applyPresetToComposer(preset({ modelId: 'krea-video-kling-kling-3-0' }),
      { modelId: null, prompt: '', params: {} }, {}, 'mcp');
    expect(out.params._kreaAuth).toBe('api-token');
  });

  it('keeps the current billing choice when applying a style-only preset', () => {
    const out = applyPresetToComposer(preset({ params: { aspect_ratio: '16:9' } }),
      { modelId: 'krea-image-openai-gpt-image-2', prompt: '', params: { _kreaAuth: 'mcp' } }, {}, 'api-token');
    expect(out.params._kreaAuth).toBe('mcp');
  });

  it('appends the preset prompt fragment to the existing prompt', () => {
    const out = applyPresetToComposer(preset({ prompt: 'film noir lighting' }), { modelId: 'nano-banana', prompt: 'a cat', params: {} });
    expect(out.prompt).toBe('a cat, film noir lighting');
  });

  it('uses the fragment alone when the prompt is empty', () => {
    const out = applyPresetToComposer(preset({ prompt: 'noir' }), { modelId: 'nano-banana', prompt: '', params: {} });
    expect(out.prompt).toBe('noir');
  });

  it('switches model (rebuilding defaults) and overlays preset params', () => {
    const out = applyPresetToComposer(
      preset({ modelId: 'nano-banana', params: { aspect_ratio: '16:9' } }),
      { modelId: 'flux-schnell', prompt: '', params: { aspect_ratio: '1:1' } },
    );
    expect(out.modelId).toBe('nano-banana');
    expect(out.params.aspect_ratio).toBe('16:9');
    // a nano-banana default the preset didn't set is present (defaults rebuilt on model switch)
    expect(out.params.model).toBeDefined();
  });

  it('keeps current model + params when preset has no modelId', () => {
    const out = applyPresetToComposer(preset({ modelId: null, params: { imageSize: '2K' } }),
      { modelId: 'nano-banana', prompt: '', params: { aspect_ratio: '16:9' } });
    expect(out.modelId).toBe('nano-banana');
    expect(out.params.aspect_ratio).toBe('16:9'); // current kept
    expect(out.params.imageSize).toBe('2K');       // preset overlaid
  });
});
