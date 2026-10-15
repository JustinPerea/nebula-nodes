import { describe, expect, it } from 'vitest';
import pricing from '../../../backend/data/model_pricing.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { directBlock, routeParamDefinitions, selectRoute } from '../../src/lib/directRoute';
import { estimateNode, type PriceEntry } from '../../src/lib/pricing';

// Krea's Ideogram and Runway copies on the makers' own APIs; the backend side
// is backend/tests/test_maker_routes_ideogram_runway.py.
const ROUTED: Record<string, string> = {
  'krea-image-ideogram-ideogram-4-5-precise': 'IDEOGRAM_API_KEY',
  'krea-image-ideogram-ideogram-3': 'IDEOGRAM_API_KEY',
  'krea-image-ideogram-ideogram-2-turbo': 'IDEOGRAM_API_KEY',
  'krea-image-runway-gen-4-image': 'RUNWAY_API_KEY',
  'krea-video-runway-gen-4-5': 'RUNWAY_API_KEY',
  'krea-enhance-runway-ruby': 'RUNWAY_API_KEY',
};
const KREA = { KREA_API_TOKEN: 'fixture-only' };
const entries = (pricing as { nodes: Record<string, PriceEntry> }).nodes;

function estimate(nodeId: string, params: Record<string, unknown>, keys: Record<string, string>) {
  const definition = NODE_DEFINITIONS[nodeId];
  return estimateNode(entries[nodeId], definition, params, selectRoute(definition, params, keys).provider);
}

describe('Krea Ideogram and Runway copies', () => {
  it('run on the maker key, the Krea plan, or the Krea token, in that order', () => {
    for (const [nodeId, key] of Object.entries(ROUTED)) {
      const definition = NODE_DEFINITIONS[nodeId];
      const provider = key === 'IDEOGRAM_API_KEY' ? 'ideogram' : 'runway';
      expect(selectRoute(definition, {}, { [key]: 'fixture-only', ...KREA })).toEqual({ kind: 'direct', provider, key });
      expect(selectRoute(definition, { _kreaAuth: 'mcp' }, { [key]: 'fixture-only' }).kind).toBe('plan');
      expect(selectRoute(definition, {}, KREA).provider).toBe('krea');
    }
  });

  it('keep Ideogram 3 on Krea when Krea style images are set', () => {
    const definition = NODE_DEFINITIONS['krea-image-ideogram-ideogram-3'];
    const params = { style_images: '[{"url":"https://example.com/s.png","strength":1}]' };
    expect(directBlock(definition, params)).toEqual({ reason: 'blocked', param: 'style_images', on: null });
    expect(selectRoute(definition, params, { IDEOGRAM_API_KEY: 'fixture-only', ...KREA }).provider).toBe('krea');
    expect(routeParamDefinitions(definition, 'direct').map((param) => param.key)).not.toContain('style_images');
  });

  it('show the price of the route the run takes', () => {
    const ideogram = { IDEOGRAM_API_KEY: 'fixture-only' };
    const runway = { RUNWAY_API_KEY: 'fixture-only' };
    expect(estimate('krea-image-ideogram-ideogram-4-5-precise', { quality: 'medium' }, ideogram)?.high).toBeCloseTo(0.06);
    expect(estimate('krea-image-ideogram-ideogram-3', {}, ideogram)).toMatchObject({ low: 0.06, high: 0.15 });
    expect(estimate('krea-image-ideogram-ideogram-2-turbo', {}, ideogram)?.high).toBeCloseTo(0.025);
    expect(estimate('krea-image-runway-gen-4-image', {}, runway)).toMatchObject({ low: 0.05, high: 0.08 });
    expect(estimate('krea-video-runway-gen-4-5', { duration: 8 }, runway)?.high).toBeCloseTo(0.96);
    expect(estimate('krea-video-runway-gen-4-5', { duration: 5.5 }, runway)).toBeNull();
    expect(estimate('krea-enhance-runway-ruby', {}, runway)).toBeNull();
  });
});
