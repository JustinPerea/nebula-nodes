import { afterEach, describe, expect, it, vi } from 'vitest';
import shared from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { buildDefaultParamsForUi, resolveCreateParamDefinitions } from '../../src/lib/createParams';
import {
  blockFields, configuredDirectKey, directBlock, directKeyNames, fallbackProvider, hasRoutes, paramDefinitionsForRun,
  routeParamDefinitions, routeUnavailable, selectRoute, WIRED, withWiredBlockers,
} from '../../src/lib/directRoute';
import { runRouteProvider } from '../../src/lib/modelDiscovery';
import type { ModelNodeDefinition } from '../../src/types';

type RouteCase = {
  name: string;
  nodeId: string;
  today?: string;
  params: Record<string, unknown>;
  apiKeys: Record<string, string>;
  expected: {
    kind: string; provider: string | null; key: string | null;
    routeId?: string | null; block?: Record<string, unknown> | null; missing?: string[];
  };
  unavailable?: Record<string, unknown> | null;
  paramKeys?: string[];
  wired?: string[];
  wiredCounts?: Record<string, number>;
  block?: { reason: string; param: string | null; detail?: string; on?: string } | null;
};

const fixture = shared as unknown as {
  defaultToday: string; cases: RouteCase[]; definitions: Record<string, ModelNodeDefinition>;
};
/** The case's node: an inline route-table node, or one from the catalog. */
const definitionFor = (nodeId: string) => fixture.definitions[nodeId] ?? NODE_DEFINITIONS[nodeId];

describe('selectRoute (cases shared with backend services/node_route.py)', () => {
  afterEach(() => { vi.useRealTimers(); });
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      // Local noon on the case's day, as node_route._today reads date.today().
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${testCase.today ?? fixture.defaultToday}T12:00:00`));
      const definition = definitionFor(testCase.nodeId);
      const wired = testCase.wiredCounts ? new Map(Object.entries(testCase.wiredCounts)) : testCase.wired ?? [];
      const params = withWiredBlockers(definition, testCase.params, wired);
      const route = selectRoute(definition, params, testCase.apiKeys);
      if (hasRoutes(definition)) {
        expect({ ...route, block: blockFields(route.block) }).toEqual(testCase.expected);
        expect(routeUnavailable(definition, params, testCase.apiKeys)).toEqual(testCase.unavailable);
      } else {
        expect(route).toEqual(testCase.expected);
      }
      expect(runRouteProvider(definition, testCase.apiKeys, params)).toBe(testCase.expected.provider);
      if (testCase.block !== undefined) {
        const block = directBlock(definition, params);
        const got = block && Object.fromEntries(Object.entries(block).filter(([, value]) => value !== null && value !== undefined));
        expect(got).toEqual(testCase.block);
      }
      if (testCase.paramKeys) {
        expect(routeParamDefinitions(definition, route.routeId ?? route.kind).map((param) => param.key).sort())
          .toEqual(testCase.paramKeys);
      }
    });
  }
});

describe('withWiredBlockers (node_route.with_wired_blockers)', () => {
  it('marks only Krea-only blockers that arrive by wire and have no saved value', () => {
    const grok15 = NODE_DEFINITIONS['krea-video-xai-grok-video-1-5'];
    expect(withWiredBlockers(grok15, { prompt: 'p' }, ['start_video', 'start_image'])).toEqual({ prompt: 'p', start_video: WIRED });
    expect(withWiredBlockers(grok15, { start_video: 'x' }, ['start_video'])).toEqual({ start_video: 'x' });
    expect(withWiredBlockers(NODE_DEFINITIONS['grok-imagine-image'], {}, ['prompt'])).toEqual({});
    const keys = { XAI_API_KEY: 'k', KREA_API_TOKEN: 'k' };
    expect(selectRoute(grok15, withWiredBlockers(grok15, {}, ['start_video']), keys).kind).toBe('fallback');
    expect(selectRoute(grok15, {}, keys).kind).toBe('direct');
  });
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

  it('offers only Veo 3.1 models, by their Vertex IDs', () => {
    // The Gemini API previews end 2026-10-22; Vertex serves the -001 models.
    const model = veo.directParams?.find((param) => param.key === 'model');
    expect(model?.options?.map((option) => option.value)).toEqual([
      'veo-3.1-generate-001', 'veo-3.1-fast-generate-001', 'veo-3.1-lite-generate-001',
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

  it('offers Runway TTS an ElevenLabs voice_id once the ElevenLabs key is set', () => {
    const tts = NODE_DEFINITIONS['runway-tts'];
    const keys = { ELEVENLABS_API_KEY: 'k', RUNWAY_API_KEY: 'r' };
    expect(fallbackProvider(tts)).toBe('runway');
    // On Runway it shows Runway's preset, plus the ElevenLabs voice to opt in.
    expect(paramDefinitionsForRun(tts, { voiceId: 'Maya' }, keys).map((param) => param.key)).toEqual(['voiceId', 'voice_id']);
    // With a voice set it runs on ElevenLabs, where Runway's preset means nothing.
    expect(paramDefinitionsForRun(tts, { voice_id: 'v' }, keys).map((param) => param.key)).toEqual(['voice_id']);
    expect(paramDefinitionsForRun(tts, {}, { RUNWAY_API_KEY: 'r' }).map((param) => param.key)).toEqual(['voiceId']);
    // A new node doesn't get a made-up voice: the field has no default.
    expect(buildDefaultParamsForUi(tts, keys)).not.toHaveProperty('voice_id');
  });

  it('names the reason: a missing direct param, a Krea-only size, a retired model', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00'));
    expect(directBlock(reframe, {})).toEqual({ reason: 'requires', param: 'resolution', on: null });
    const kreaPro = NODE_DEFINITIONS['krea-image-google-nano-banana-pro'];
    expect(directBlock(kreaPro, { width: 1024 })).toEqual({ reason: 'blocked', param: 'width', on: null });
    const veoFast = NODE_DEFINITIONS['krea-video-google-veo-3-1-fast'];
    expect(directBlock(veoFast, { resolution: '4K' })).toEqual({ reason: 'unsupported', param: 'resolution', on: null, detail: 'resolution 4K' });
    expect(directBlock(veoFast, {})).toBeNull();
    expect(directBlock(NODE_DEFINITIONS['krea-video-google-veo-3-1'], { resolution: '4K' })).toBeNull();
    const nano = NODE_DEFINITIONS['nano-banana-fal'];
    expect(directBlock(nano, { model: 'nano-banana' })).toBeNull();
    vi.setSystemTime(new Date('2027-03-15T00:30:00'));
    expect(directBlock(nano, { model: 'nano-banana' })).toEqual({ reason: 'retired', param: 'model', on: '2027-03-15' });
    expect(directBlock(nano, {})).toBeNull();
    expect(directBlock(NODE_DEFINITIONS['krea-image-google-nano-banana'], {}))
      .toEqual({ reason: 'retired', param: null, on: '2027-03-15' });
    // A shared param's value the maker can't render keeps the run on the copy;
    // the default is never one of them.
    const gpt2 = NODE_DEFINITIONS['gpt-image-2-fal-generate'];
    expect(directBlock(gpt2, {})).toBeNull();
    expect(directBlock(gpt2, { image_size: 'square_hd' })).toBeNull();
    expect(directBlock(gpt2, { image_size: 'landscape_16_9' })).toEqual({
      reason: 'unsupported', param: 'image_size', on: null, detail: 'image_size landscape_16_9' });
  });

  it('keeps values and combinations the maker doesn\'t take on the copy (directRoute.accepts / rejectsWhen)', () => {
    const hailuo = NODE_DEFINITIONS['krea-video-minimax-hailuo-02'];
    // The defaults (768p, 6 s) are values MiniMax takes.
    expect(directBlock(hailuo, {})).toBeNull();
    expect(directBlock(hailuo, { duration: 10 })).toBeNull();
    expect(directBlock(hailuo, { duration: 7.5 })).toEqual({
      reason: 'unsupported', param: 'duration', on: null, detail: 'duration 7.5' });
    // 10.0 and '10' are 10, as the backend's match_value spells them.
    expect(directBlock(hailuo, { resolution: '1080p', duration: '10' })?.detail).toBe('1080p at 10 seconds');
    expect(directBlock(hailuo, { resolution: '1080p', duration: 10 })).toEqual({
      reason: 'unsupported', param: 'resolution', on: null, detail: '1080p at 10 seconds' });
    expect(selectRoute(hailuo, { duration: 8 }, { MINIMAX_API_KEY: 'k', KREA_API_TOKEN: 'k' }))
      .toEqual({ kind: 'fallback', provider: 'krea', key: 'KREA_API_TOKEN' });
  });
});
