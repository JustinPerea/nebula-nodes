import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { resolveCreateParamDefinitions } from '../../src/lib/createParams';
import { configuredDirectKey, directKeyNames } from '../../src/lib/directRoute';
import { runRouteProvider } from '../../src/lib/modelDiscovery';

const veo = NODE_DEFINITIONS['veo-3'];

describe('direct routes with more than one key', () => {
  it('lists Vertex before the Gemini API key for Veo, and a single key for others', () => {
    expect(directKeyNames(veo)).toEqual(['GOOGLE_VERTEX_CREDENTIALS', 'GOOGLE_API_KEY']);
    expect(directKeyNames(NODE_DEFINITIONS['veo-3-flf'])).toEqual(['GOOGLE_VERTEX_CREDENTIALS']);
    expect(directKeyNames(NODE_DEFINITIONS['nano-banana'])).toEqual([]);
  });

  it('picks the first configured direct key, ignoring blanks', () => {
    expect(configuredDirectKey(veo, { GOOGLE_VERTEX_CREDENTIALS: ' ', GOOGLE_API_KEY: 'k' })).toBe('GOOGLE_API_KEY');
    expect(configuredDirectKey(veo, { GOOGLE_VERTEX_CREDENTIALS: '{}', GOOGLE_API_KEY: 'k' })).toBe('GOOGLE_VERTEX_CREDENTIALS');
    expect(configuredDirectKey(veo, { FAL_KEY: 'k' })).toBeUndefined();
  });

  it('shows the Google params and bills Google on Vertex alone', () => {
    const keys = { GOOGLE_VERTEX_CREDENTIALS: '{}', FAL_KEY: 'k' };
    const params = resolveCreateParamDefinitions(veo, keys).map((param) => param.key);
    expect(params).toContain('model');
    expect(params).not.toContain('safety_tolerance');
    expect(runRouteProvider(veo, keys)).toBe('google');
    expect(runRouteProvider(veo, { FAL_KEY: 'k' })).toBe('fal');
  });

  it('offers only Veo 3.1 models', () => {
    const model = veo.directParams?.find((param) => param.key === 'model');
    expect(model?.options?.map((option) => option.value)).toEqual([
      'veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview',
    ]);
  });
});
