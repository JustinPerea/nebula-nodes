import { describe, it, expect } from 'vitest';
import {
  buildDefaultParamsForUi,
  matchesVisibleWhen,
  deriveVisibleParams,
} from '../../src/lib/createParams';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';

describe('matchesVisibleWhen', () => {
  it('is visible when undefined', () => {
    expect(matchesVisibleWhen(undefined, {})).toBe(true);
  });
  it('matches when every key value is in its allow-list', () => {
    expect(matchesVisibleWhen({ model: ['a', 'b'] }, { model: 'a' })).toBe(true);
    expect(matchesVisibleWhen({ model: ['a', 'b'] }, { model: 'c' })).toBe(false);
  });
});

describe('deriveVisibleParams', () => {
  it('drops hidden params and applies visibleWhen for nano-banana imageSize', () => {
    const def = NODE_DEFINITIONS['nano-banana'];
    const withFlash = deriveVisibleParams(def, { model: 'gemini-3.1-flash-image' });
    expect(withFlash.some((p) => p.key === 'imageSize')).toBe(true);

    const withLite = deriveVisibleParams(def, { model: 'gemini-3.1-flash-lite-image' });
    const liteImageSize = withLite.find((p) => p.key === 'imageSize');
    expect(liteImageSize?.options?.map((option) => option.value)).toEqual(['1K']);

    const withLegacy = deriveVisibleParams(def, { model: 'gemini-2.5-flash-image' });
    expect(withLegacy.some((p) => p.key === 'imageSize')).toBe(false);
    // aspect_ratio is always visible
    expect(withLegacy.some((p) => p.key === 'aspect_ratio')).toBe(true);
  });

  it('keeps FAL Nano Banana controls within each endpoint contract', () => {
    for (const id of ['nano-banana-fal', 'nano-banana-fal-edit'] as const) {
      const def = NODE_DEFINITIONS[id];
      const withPro = deriveVisibleParams(def, { model: 'nano-banana-pro' });
      const aspectRatio = withPro.find((p) => p.key === 'aspect_ratio');

      expect(aspectRatio?.options?.map((option) => option.value)).not.toContain('1:4');
      expect(withPro.some((p) => p.key === 'enable_web_search')).toBe(true);

      const withNb2 = deriveVisibleParams(def, { model: 'nano-banana-2' });
      const nb2AspectRatio = withNb2.find((p) => p.key === 'aspect_ratio');
      expect(nb2AspectRatio?.options?.map((option) => option.value)).toContain('1:4');
    }
  });

  it('renders exactly one provider-specific control per key for Veo', () => {
    const def = NODE_DEFINITIONS['veo-3'];

    const fal = deriveVisibleParams(def, { model: 'veo-3.1-generate-preview' });
    expect(fal.filter((p) => p.key === 'seed')).toHaveLength(1);
    expect(fal.some((p) => p.key === 'safety_tolerance')).toBe(true);
    expect(fal.some((p) => p.key === 'model')).toBe(false);

    const direct = deriveVisibleParams(
      def,
      { model: 'veo-3.1-generate-preview' },
      { GOOGLE_API_KEY: 'configured' },
    );
    expect(direct.filter((p) => p.key === 'seed')).toHaveLength(1);
    expect(direct.some((p) => p.key === 'model')).toBe(true);
    expect(direct.some((p) => p.key === 'safety_tolerance')).toBe(false);
  });

  it('builds defaults only for the provider route Create will execute', () => {
    const def = NODE_DEFINITIONS['veo-3'];
    const fal = buildDefaultParamsForUi(def);
    const direct = buildDefaultParamsForUi(def, { GOOGLE_API_KEY: 'configured' });

    expect(fal).toHaveProperty('safety_tolerance');
    expect(fal).not.toHaveProperty('model');
    expect(direct).toHaveProperty('model');
    expect(direct).not.toHaveProperty('safety_tolerance');
  });
});
