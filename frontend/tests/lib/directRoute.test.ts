import { describe, expect, it } from 'vitest';
import shared from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { buildDefaultParamsForUi, resolveCreateParamDefinitions } from '../../src/lib/createParams';
import {
  configuredDirectKey, directKeyNames, fallbackProvider, routeParamDefinitions, selectRoute,
} from '../../src/lib/directRoute';
import { runRouteProvider } from '../../src/lib/modelDiscovery';

type RouteCase = {
  name: string;
  nodeId: string;
  params: Record<string, unknown>;
  apiKeys: Record<string, string>;
  expected: { kind: string; provider: string | null; key: string | null };
  paramKeys?: string[];
};

describe('selectRoute (cases shared with backend services/node_route.py)', () => {
  for (const testCase of (shared as { cases: RouteCase[] }).cases) {
    it(testCase.name, () => {
      const definition = NODE_DEFINITIONS[testCase.nodeId];
      const route = selectRoute(definition, testCase.params, testCase.apiKeys);
      expect(route).toEqual(testCase.expected);
      expect(runRouteProvider(definition, testCase.apiKeys, testCase.params)).toBe(testCase.expected.provider);
      if (testCase.paramKeys) {
        expect(routeParamDefinitions(definition, route.kind).map((param) => param.key).sort()).toEqual(testCase.paramKeys);
      }
    });
  }
});

describe('maker routes for fal and Krea copies', () => {
  const nanoFal = NODE_DEFINITIONS['nano-banana-fal'];
  const kreaPro = NODE_DEFINITIONS['krea-image-google-nano-banana-pro'];

  it('names the fallback provider', () => {
    expect(fallbackProvider(nanoFal)).toBe('fal');
    expect(fallbackProvider(kreaPro)).toBe('krea');
    expect(fallbackProvider(NODE_DEFINITIONS['nano-banana'])).toBeUndefined();
  });

  it('shows only the route\'s params in Create, with the Krea plan winning over a Google key', () => {
    const keys = { GOOGLE_API_KEY: 'k', KREA_API_TOKEN: 'k' };
    const keysFor = (params: Record<string, unknown>) =>
      resolveCreateParamDefinitions(kreaPro, keys, params).map((param) => param.key);
    expect(keysFor({ _kreaAuth: 'api-token' })).not.toContain('width');
    expect(keysFor({ _kreaAuth: 'mcp' })).toEqual(expect.arrayContaining(['width', 'height', 'resolution']));
    expect(resolveCreateParamDefinitions(nanoFal, { GOOGLE_API_KEY: 'k' }).map((param) => param.key)).not.toContain('seed');
    expect(resolveCreateParamDefinitions(nanoFal, { FAL_KEY: 'k' }).map((param) => param.key)).toContain('seed');
  });

  it('seeds new Create drafts with the chosen Krea connection', () => {
    expect(buildDefaultParamsForUi(kreaPro, { GOOGLE_API_KEY: 'k' }, 'mcp')).toMatchObject({ _kreaAuth: 'mcp', resolution: '1K' });
    expect(buildDefaultParamsForUi(kreaPro, { GOOGLE_API_KEY: 'k' }, 'api-token')).toMatchObject({ _kreaAuth: 'api-token' });
  });
});

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
