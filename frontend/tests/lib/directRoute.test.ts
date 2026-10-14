import { afterEach, describe, expect, it, vi } from 'vitest';
import shared from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { buildDefaultParamsForUi, resolveCreateParamDefinitions } from '../../src/lib/createParams';
import {
  configuredDirectKey, directBlock, directKeyNames, fallbackProvider, paramDefinitionsForRun, routeParamDefinitions,
  selectRoute,
} from '../../src/lib/directRoute';
import { runRouteProvider } from '../../src/lib/modelDiscovery';

type RouteCase = {
  name: string;
  nodeId: string;
  today?: string;
  params: Record<string, unknown>;
  apiKeys: Record<string, string>;
  expected: { kind: string; provider: string | null; key: string | null };
  paramKeys?: string[];
};

describe('selectRoute (cases shared with backend services/node_route.py)', () => {
  const fixture = shared as { defaultToday: string; cases: RouteCase[] };
  afterEach(() => { vi.useRealTimers(); });
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      // Local noon on the case's day, as node_route._today reads date.today().
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${testCase.today ?? fixture.defaultToday}T12:00:00`));
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

describe('when the direct route can\'t take a run', () => {
  const reframe = NODE_DEFINITIONS['ideogram-reframe'];
  afterEach(() => { vi.useRealTimers(); });

  it('offers the one direct param a reframe needs when only the Ideogram key is set', () => {
    const keys = { IDEOGRAM_API_KEY: 'k' };
    expect(selectRoute(reframe, {}, keys).kind).toBe('unset');
    const shown = paramDefinitionsForRun(reframe, {}, keys).map((param) => param.key);
    expect(shown).toContain('resolution');
    expect(paramDefinitionsForRun(reframe, {}, keys, { seedOptIn: false }).find((p) => p.key === 'resolution'))
      .toMatchObject({ default: undefined, required: true });
    // Create seeds it, so a new node runs on the Ideogram key (as before).
    expect(buildDefaultParamsForUi(reframe, keys)).toMatchObject({ resolution: '1024x1024' });
    // Without the Ideogram key there is nothing to opt into.
    expect(paramDefinitionsForRun(reframe, {}, { FAL_KEY: 'k' }).map((param) => param.key)).not.toContain('resolution');
  });

  it('names the reason: a missing direct param, a Krea-only size, a retired model', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00'));
    expect(directBlock(reframe, {})).toEqual({ reason: 'requires', param: 'resolution', on: null });
    const kreaPro = NODE_DEFINITIONS['krea-image-google-nano-banana-pro'];
    expect(directBlock(kreaPro, { width: 1024 })).toEqual({ reason: 'blocked', param: 'width', on: null });
    const nano = NODE_DEFINITIONS['nano-banana-fal'];
    expect(directBlock(nano, { model: 'nano-banana' })).toBeNull();
    vi.setSystemTime(new Date('2027-03-15T00:30:00'));
    expect(directBlock(nano, { model: 'nano-banana' })).toEqual({ reason: 'retired', param: 'model', on: '2027-03-15' });
    expect(directBlock(nano, {})).toBeNull();
    expect(directBlock(NODE_DEFINITIONS['krea-image-google-nano-banana'], {}))
      .toEqual({ reason: 'retired', param: null, on: '2027-03-15' });
  });
});
