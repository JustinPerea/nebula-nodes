import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import type { CredentialReadiness } from '../../src/lib/kreaConnection';
import {
  keyReadiness, modelReadiness, PROVIDER_HEALTH_TTL_MS,
  type ProviderHealthEntry, type ProviderHealthState,
} from '../../src/lib/providerReadiness';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/backend', () => ({ apiFetch: apiFetchMock }));

const NOW = Date.parse('2026-10-08T16:00:00.000Z');
const TOKEN = 'fixture-only';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function credentials(overrides: Partial<CredentialReadiness> = {}): CredentialReadiness {
  return freeze({ loaded: true, apiKeys: {}, ...overrides });
}

function health(providers: ProviderHealthState['providers'] = {}, overrides: Partial<ProviderHealthState> = {}): ProviderHealthState {
  return freeze({ providers, checkedAt: NOW, loading: false, error: null, ...overrides });
}

function entry(status: ProviderHealthEntry['status'], checkedAt = NOW): ProviderHealthEntry {
  return { configured: status !== 'not_configured', status, last_checked: new Date(checkedAt).toISOString() };
}

// A Krea copy with no maker route (GPT Image 2 now also runs on OpenAI's API).
const kreaImage = NODE_DEFINITIONS['krea-image-openai-gpt-image'];
const kreaVideo = NODE_DEFINITIONS['krea-video-kling-kling-3-0'];
const dualRoute = NODE_DEFINITIONS['veo-3'];

describe('provider readiness without generation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    apiFetchMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('distinguishes settings not loaded from a missing credential even with cached provider health', () => {
    const verified = health({ Google: entry('valid') });
    expect(keyReadiness('GOOGLE_API_KEY', credentials({ loaded: false }), verified)).toMatchObject({
      label: 'Connection not loaded', tone: 'neutral', setupTarget: { kind: 'api-key', key: 'GOOGLE_API_KEY' },
    });
    const missing = keyReadiness('GOOGLE_API_KEY', credentials(), verified);
    expect(missing).toMatchObject({ label: 'Setup required', tone: 'warning' });
    expect(missing.detail).toContain('browse and add models before connecting');
    expect(keyReadiness('GOOGLE_API_KEY', credentials({ apiKeys: { GOOGLE_API_KEY: '  ' } }), verified).label).toBe('Setup required');
  });

  it('does not describe a saved credential as verified before a safe check', () => {
    const ready = keyReadiness('GOOGLE_API_KEY', credentials({ apiKeys: { GOOGLE_API_KEY: TOKEN } }), health());
    expect(ready).toMatchObject({ label: 'Configured · not checked', tone: 'neutral' });
    expect(ready.detail).toContain('without generating');
  });

  it.each([
    ['valid', 'Verified credential', 'success'],
    ['configured_unverified', 'Configured · not checked', 'neutral'],
    ['not_configured', 'Setup required', 'warning'],
    ['invalid', 'Credential rejected', 'warning'],
    ['unauthorized', 'Authorization required', 'warning'],
    ['insufficient_credits', 'Credits required', 'warning'],
    ['rate_limited', 'Check rate limited', 'warning'],
    ['error', 'Check unavailable', 'warning'],
  ] as const)('presents safe %s credential-check feedback', (status, label, tone) => {
    const ready = keyReadiness('FAL_KEY', credentials({ apiKeys: { FAL_KEY: TOKEN } }), health({ FAL: entry(status) }));
    expect(ready).toMatchObject({ label, tone, setupTarget: { kind: 'api-key', key: 'FAL_KEY' } });
    if (status === 'valid') {
      expect(ready.detail).toContain('Model access, available credits and generation are checked separately');
    }
  });

  it('expires a verification at five minutes, using the older cache or provider timestamp', () => {
    const cache = credentials({ apiKeys: { FAL_KEY: TOKEN } });
    const fresh = health({ FAL: entry('valid') });
    vi.setSystemTime(NOW + PROVIDER_HEALTH_TTL_MS - 1);
    expect(keyReadiness('FAL_KEY', cache, fresh).label).toBe('Verified credential');
    vi.setSystemTime(NOW + PROVIDER_HEALTH_TTL_MS);
    expect(keyReadiness('FAL_KEY', cache, fresh).label).toBe('Configured · not checked');
    vi.setSystemTime(NOW);
    const staleAt = NOW - PROVIDER_HEALTH_TTL_MS;
    expect(keyReadiness('FAL_KEY', cache, health({ FAL: entry('valid', staleAt) })).label).toBe('Configured · not checked');
    expect(keyReadiness('FAL_KEY', cache, health({ FAL: entry('valid') }, { checkedAt: staleAt })).label).toBe('Configured · not checked');
  });

  it.each([
    ['no completed cache check', { checkedAt: null }, entry('valid')],
    ['non-finite cache timestamp', { checkedAt: NaN }, entry('valid')],
    ['infinite cache timestamp', { checkedAt: Infinity }, entry('valid')],
    ['future cache timestamp', { checkedAt: NOW + 1 }, entry('valid')],
    ['future provider timestamp', {}, entry('valid', NOW + 1)],
    ['malformed provider timestamp', {}, { ...entry('valid'), last_checked: 'invalid-time' }],
  ] as const)('does not trust %s', (_reason, overrides, provider) => {
    expect(keyReadiness('FAL_KEY', credentials({ apiKeys: { FAL_KEY: TOKEN } }),
      health({ FAL: provider }, overrides)).label).toBe('Configured · not checked');
  });

  it('does not verify a contradictory valid check that reports no configured credential', () => {
    const inconsistent = health({ FAL: { ...entry('valid'), configured: false } });
    expect(keyReadiness('FAL_KEY', credentials({ apiKeys: { FAL_KEY: TOKEN } }), inconsistent).label)
      .toBe('Configured · not checked');
  });

  it('keeps checking and transport errors distinct from credential rejection and hides raw errors', () => {
    const cache = credentials({ apiKeys: { FAL_KEY: TOKEN } });
    expect(keyReadiness('FAL_KEY', cache, health({ FAL: entry('valid') }, { loading: true })))
      .toMatchObject({ label: 'Checking connection', tone: 'neutral' });
    const ready = keyReadiness('FAL_KEY', cache, health({}, { error: 'https://private.test/?token=fixture-private' }));
    expect(ready).toMatchObject({ label: 'Check unavailable', tone: 'warning' });
    expect(ready.detail).toContain('configured');
    expect(JSON.stringify(ready)).not.toMatch(/private\.test|fixture-private/);
  });

  it('uses FAL only when the direct credential is absent and prefers direct when both are configured', () => {
    const bothValid = health({ Google: entry('valid'), FAL: entry('valid') });
    expect(modelReadiness(dualRoute, {}, credentials({ apiKeys: { FAL_KEY: TOKEN } }), bothValid)).toMatchObject({
      label: 'Verified credential', connectionLabel: 'fal.ai API', setupTarget: { kind: 'api-key', key: 'FAL_KEY' },
    });
    expect(modelReadiness(dualRoute, {}, credentials({ apiKeys: { GOOGLE_API_KEY: TOKEN, FAL_KEY: TOKEN } }), bothValid)).toMatchObject({
      label: 'Verified credential', connectionLabel: 'Google API', setupTarget: { kind: 'api-key', key: 'GOOGLE_API_KEY' },
    });
    // With nothing set, setup points at Vertex: the Gemini API previews retire on 2026-10-22.
    expect(modelReadiness(dualRoute, {}, credentials(), bothValid)).toMatchObject({
      label: 'Setup required', setupTarget: { kind: 'api-key', key: 'GOOGLE_VERTEX_CREDENTIALS' },
    });
  });

  it.each([
    ['nano-banana-fal', 'fal.ai', 'FAL key', 'FAL_KEY'],
    ['krea-image-google-nano-banana-2', 'Krea', 'Krea API key', 'KREA_API_TOKEN'],
  ])('says which route %s takes: your Google key, else its fal or Krea copy', (id, copy, copyKey, fallbackKey) => {
    const definition = NODE_DEFINITIONS[id];
    const direct = modelReadiness(definition, {}, credentials({ apiKeys: { GOOGLE_API_KEY: TOKEN, [fallbackKey]: TOKEN } }), health());
    expect(direct).toMatchObject({ connectionLabel: 'Google API', setupTarget: { kind: 'api-key', key: 'GOOGLE_API_KEY' } });
    expect(direct.detail).toContain("Runs on Google's own API with your Google key");
    const fallback = modelReadiness(definition, {}, credentials({ apiKeys: { [fallbackKey]: TOKEN } }), health());
    expect(fallback).toMatchObject({ setupTarget: { kind: 'api-key', key: fallbackKey } });
    expect(fallback.detail).toContain(`Runs on ${copy} with your ${copyKey}`);
    expect(fallback.detail).toContain('Add a Google key to run on Google directly');
    const none = modelReadiness(definition, {}, credentials(), health());
    expect(none).toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key: 'GOOGLE_API_KEY' } });
    expect(none.detail).toContain(`or on ${copy} with a ${copyKey}`);
  });

  it('keeps a Krea copy with an explicit size on Krea and says why', () => {
    const definition = NODE_DEFINITIONS['krea-image-google-nano-banana-2'];
    const keys = { GOOGLE_API_KEY: TOKEN, KREA_API_TOKEN: TOKEN };
    const ready = modelReadiness(definition, freeze({ _kreaAuth: 'api-token', width: 1920 }), credentials({ apiKeys: keys }), health());
    expect(ready).toMatchObject({ connectionLabel: 'Krea API key', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' } });
    expect(ready.detail).toContain('This recipe sets width, which only Krea takes, so it runs on Krea.');
    const googleOnly = modelReadiness(definition, freeze({ width: 1920 }), credentials({ apiKeys: { GOOGLE_API_KEY: TOKEN } }), health());
    expect(googleOnly).toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' } });
  });

  it('keeps Veo 3.1 Fast at 4K on Krea (Vertex renders Fast at 1080p at most) and says why', () => {
    const definition = NODE_DEFINITIONS['krea-video-google-veo-3-1-fast'];
    const keys = { GOOGLE_VERTEX_CREDENTIALS: TOKEN, KREA_API_TOKEN: TOKEN };
    const ready = modelReadiness(definition, freeze({ _kreaAuth: 'api-token', resolution: '4K' }), credentials({ apiKeys: keys }), health());
    expect(ready).toMatchObject({ connectionLabel: 'Krea API key', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' } });
    expect(ready.detail).toContain("Google Vertex's own API doesn't take resolution 4K, so it runs on Krea. Change resolution to run on Google Vertex.");
    const hd = modelReadiness(definition, freeze({ _kreaAuth: 'api-token', resolution: '1080p' }), credentials({ apiKeys: keys }), health());
    expect(hd).toMatchObject({ setupTarget: { kind: 'api-key', key: 'GOOGLE_VERTEX_CREDENTIALS' } });
    expect(hd.detail).toContain("Runs on Google Vertex's own API");
  });

  it('keeps a GPT Image 2 fal size OpenAI can\'t render on fal and says why', () => {
    const definition = NODE_DEFINITIONS['gpt-image-2-fal-generate'];
    const cache = credentials({ apiKeys: { OPENAI_API_KEY: TOKEN, FAL_KEY: TOKEN } });
    const direct = modelReadiness(definition, freeze({ image_size: 'landscape_4_3' }), cache, health());
    expect(direct.connectionLabel).toBe('OpenAI API');
    expect(direct.detail).toContain("Runs on OpenAI's own API with your OpenAI key");
    const ready = modelReadiness(definition, freeze({ image_size: 'square' }), cache, health());
    expect(ready).toMatchObject({ connectionLabel: 'fal.ai API', setupTarget: { kind: 'api-key', key: 'FAL_KEY' } });
    expect(ready.detail).toContain("OpenAI's own API doesn't take image_size square, so it runs on FAL. Change image_size to run on OpenAI.");
  });

  it('points a Krea GPT Image 2 recipe with no keys at the OpenAI key, and keeps a sized one on Krea', () => {
    const definition = NODE_DEFINITIONS['krea-image-openai-gpt-image-2'];
    expect(modelReadiness(definition, freeze({}), credentials(), health()))
      .toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key: 'OPENAI_API_KEY' } });
    const sized = modelReadiness(definition, freeze({ width: 1920 }), credentials({ apiKeys: { OPENAI_API_KEY: TOKEN } }), health());
    expect(sized).toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' } });
    expect(sized.detail).toContain('This recipe sets width, which only Krea takes, so it runs on Krea.');
  });

  it('moves GPT Image 1.5 to fal from OpenAI\'s shutdown date', () => {
    const definition = NODE_DEFINITIONS['gpt-image-1-5'];
    const cache = credentials({ apiKeys: { OPENAI_API_KEY: TOKEN, FAL_KEY: TOKEN } });
    vi.setSystemTime(Date.parse('2026-11-30T12:00:00'));
    expect(modelReadiness(definition, freeze({}), cache, health()).connectionLabel).toBe('OpenAI API');
    vi.setSystemTime(Date.parse('2026-12-01T12:00:00'));
    const ready = modelReadiness(definition, freeze({}), cache, health());
    expect(ready.connectionLabel).toBe('fal.ai API');
    expect(ready.detail).toContain('OpenAI retires this model on its own API from 2026-12-01, so it runs on FAL.');
  });

  it('keeps a Hailuo duration MiniMax does not sell on Krea and says why', () => {
    const definition = NODE_DEFINITIONS['krea-video-minimax-hailuo-02'];
    const keys = { MINIMAX_API_KEY: TOKEN, KREA_API_TOKEN: TOKEN };
    const ready = modelReadiness(definition, freeze({ duration: 8 }), credentials({ apiKeys: keys }), health());
    expect(ready).toMatchObject({ connectionLabel: 'Krea API key', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' } });
    expect(ready.detail).toContain("MiniMax's own API doesn't take duration 8, so it runs on Krea. Change duration to run on MiniMax.");
    const combo = modelReadiness(definition, freeze({ resolution: '1080p', duration: 10 }), credentials({ apiKeys: keys }), health());
    expect(combo.detail).toContain("MiniMax's own API doesn't take 1080p at 10 seconds, so it runs on Krea. Change resolution to run on MiniMax.");
    const direct = modelReadiness(definition, freeze({ duration: 6 }), credentials({ apiKeys: keys }), health());
    expect(direct.detail).toContain("Runs on MiniMax's own API with your MiniMax key, billed by MiniMax.");
  });

  it.each([
    ['seedream-4-5', 'fal.ai', 'FAL_KEY', freeze({ image_size: 'square' }), 'image_size'],
    ['krea-image-bytedance-seedream-5-lite', 'Krea', 'KREA_API_TOKEN', freeze({ width: 1024, height: 1024 }), 'width'],
  ])('runs %s on BytePlus, keeps a size BytePlus can\'t render on its copy, and suggests the copy\'s key first',
    (id, copy, fallbackKey, unsized, param) => {
      const definition = NODE_DEFINITIONS[id];
      const keys = credentials({ apiKeys: { BYTEPLUS_API_KEY: TOKEN, [fallbackKey]: TOKEN } });
      const sized = id === 'seedream-4-5' ? freeze({}) : freeze({ width: 2048, height: 2048 });
      const direct = modelReadiness(definition, sized, keys, health());
      expect(direct).toMatchObject({ connectionLabel: 'BytePlus API', setupTarget: { kind: 'api-key', key: 'BYTEPLUS_API_KEY' } });
      expect(direct.detail).toContain("Runs on BytePlus's own API with your BytePlus key, billed by BytePlus.");
      const blocked = modelReadiness(definition, unsized, keys, health());
      expect(blocked.setupTarget).toEqual({ kind: 'api-key', key: fallbackKey });
      expect(blocked.detail).toContain(`BytePlus can't render this recipe's ${param} exactly, so it runs on ${copy === 'fal.ai' ? 'FAL' : copy}.`);
      // Nothing set: BytePlus isn't sold in the United States, so setup points at the copy.
      const none = modelReadiness(definition, sized, credentials(), health());
      expect(none).toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key: fallbackKey } });
      expect(none.detail).toContain('Runs on BytePlus with your BytePlus key, or on');
    });

  it.each([
    ['krea-video-bytedance-seedance-2', freeze({ upscale: true }), 'upscale', 'upscale true'],
    ['krea-video-bytedance-seedance-2-5', freeze({ duration: 7.5 }), 'duration', 'duration 7.5'],
    ['krea-video-bytedance-seedance-1-0-pro', freeze({ aspect_ratio: '9:21' }), 'aspect_ratio', 'aspect_ratio 9:21'],
  ])('keeps %s on Krea for a %s value BytePlus doesn\'t take, and says which setting', (id, params, param, detail) => {
    const definition = NODE_DEFINITIONS[id];
    const keys = credentials({ apiKeys: { BYTEPLUS_API_KEY: TOKEN, KREA_API_TOKEN: TOKEN } });
    expect(modelReadiness(definition, freeze({}), keys, health()).connectionLabel).toBe('BytePlus API');
    const kept = modelReadiness(definition, params, keys, health());
    expect(kept.setupTarget).toEqual({ kind: 'api-key', key: 'KREA_API_TOKEN' });
    expect(kept.detail).toContain(`BytePlus's own API doesn't take ${detail}, so it runs on Krea. Change ${param} to run on BytePlus.`);
  });

  it('moves Nano Banana (2.5) to fal from Google\'s shutdown date and says so', () => {
    const definition = NODE_DEFINITIONS['nano-banana-fal'];
    const cache = credentials({ apiKeys: { GOOGLE_API_KEY: TOKEN, FAL_KEY: TOKEN } });
    expect(modelReadiness(definition, freeze({ model: 'nano-banana' }), cache, health()).connectionLabel).toBe('Google API');
    vi.setSystemTime(Date.parse('2027-03-15T12:00:00'));
    const ready = modelReadiness(definition, freeze({ model: 'nano-banana' }), cache, health());
    expect(ready).toMatchObject({ connectionLabel: 'fal.ai API', setupTarget: { kind: 'api-key', key: 'FAL_KEY' } });
    expect(ready.detail).toContain('Google retires this model on its own API from 2027-03-15, so it runs on FAL.');
    expect(modelReadiness(definition, freeze({ model: 'nano-banana-2' }), cache, health()).connectionLabel).toBe('Google API');
  });

  it('names Runway as the copy for its resold ElevenLabs models and asks for an ElevenLabs voice', () => {
    const definition = NODE_DEFINITIONS['runway-tts'];
    const keys = { ELEVENLABS_API_KEY: TOKEN, RUNWAY_API_KEY: TOKEN };
    const preset = modelReadiness(definition, freeze({ voiceId: 'Maya' }), credentials({ apiKeys: keys }), health());
    expect(preset).toMatchObject({ connectionLabel: 'Runway API', setupTarget: { kind: 'api-key', key: 'RUNWAY_API_KEY' } });
    expect(preset.detail).toContain('Runs on Runway with your Runway key.');
    expect(preset.detail).toContain('This recipe sets no ElevenLabs voice_id, so it uses Runway. Set it to run on ElevenLabs.');
    const voiced = modelReadiness(definition, freeze({ voice_id: 'pNInz6obpgDQGcFmaJgB' }), credentials({ apiKeys: keys }), health());
    expect(voiced).toMatchObject({ connectionLabel: 'ElevenLabs API', setupTarget: { kind: 'api-key', key: 'ELEVENLABS_API_KEY' } });
    expect(voiced.detail).toContain("Runs on ElevenLabs's own API with your ElevenLabs key, billed by ElevenLabs.");
    const dubbing = modelReadiness(NODE_DEFINITIONS['runway-dubbing'], freeze({}), credentials({ apiKeys: { RUNWAY_API_KEY: TOKEN } }), health());
    expect(dubbing.detail).toContain('Runs on Runway with your Runway key. Add an ElevenLabs key to run on ElevenLabs directly.');
  });

  it('keeps a Krea copy on the signed-in plan even with a Google key', () => {
    const ready = modelReadiness(NODE_DEFINITIONS['krea-image-google-nano-banana-pro'], freeze({ _kreaAuth: 'mcp' }),
      credentials({ apiKeys: { GOOGLE_API_KEY: TOKEN }, kreaConnection: { status: 'connected' } }), health());
    expect(ready).toMatchObject({ label: 'Krea signed in', setupTarget: { kind: 'krea-mcp' } });
  });

  it('prefers Vertex over the Gemini API key when both direct credentials are set', () => {
    const ready = modelReadiness(dualRoute, {}, credentials({ apiKeys: {
      GOOGLE_VERTEX_CREDENTIALS: TOKEN, GOOGLE_API_KEY: TOKEN, FAL_KEY: TOKEN,
    } }), health({ 'Google Vertex': entry('configured_unverified'), Google: entry('valid'), FAL: entry('valid') }));
    expect(ready).toMatchObject({ setupTarget: { kind: 'api-key', key: 'GOOGLE_VERTEX_CREDENTIALS' } });
  });

  it('never masks a rejected direct credential with a verified FAL fallback', () => {
    const ready = modelReadiness(dualRoute, {}, credentials({ apiKeys: { GOOGLE_API_KEY: TOKEN, FAL_KEY: TOKEN } }),
      health({ Google: entry('invalid'), FAL: entry('valid') }));
    expect(ready).toMatchObject({ label: 'Credential rejected', connectionLabel: 'Google API', tone: 'warning',
      setupTarget: { kind: 'api-key', key: 'GOOGLE_API_KEY' } });
    expect(ready.detail).not.toContain('Verified');
  });

  it('keeps a saved Ideogram Reframe recipe on FAL without its direct resolution, while new defaults use direct', () => {
    const definition = NODE_DEFINITIONS['ideogram-reframe'];
    const cache = credentials({ apiKeys: { IDEOGRAM_API_KEY: TOKEN, FAL_KEY: TOKEN } });
    const checked = health({ Ideogram: entry('invalid'), FAL: entry('valid') });
    const saved = freeze({ image_size: 'square_hd' });
    expect(modelReadiness(definition, saved, cache, checked)).toMatchObject({ label: 'Verified credential',
      connectionLabel: 'fal.ai API', setupTarget: { kind: 'api-key', key: 'FAL_KEY' } });
    const resolution = definition.directParams?.find((param) => param.key === 'resolution')?.default;
    expect(resolution).toBeTruthy();
    expect(modelReadiness(definition, freeze({ resolution }), cache, checked)).toMatchObject({ label: 'Credential rejected',
      connectionLabel: 'Ideogram API', setupTarget: { kind: 'api-key', key: 'IDEOGRAM_API_KEY' } });
    expect(modelReadiness(definition, saved, credentials({ apiKeys: { IDEOGRAM_API_KEY: TOKEN } }), checked)).toMatchObject({
      label: 'Setup required', setupTarget: { kind: 'api-key', key: 'FAL_KEY' } });
  });

  it.each([kreaImage, kreaVideo])('retains API-token billing for an old $displayName recipe despite a signed-in account', (definition) => {
    const cache = credentials({ kreaConnection: { status: 'connected' }, kreaConnectionMode: 'mcp' });
    expect(modelReadiness(definition, freeze({ prompt: 'fixture logo' }), cache, health())).toMatchObject({
      label: 'Setup required', connectionLabel: 'Krea API key', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' },
    });
    const configured = modelReadiness(definition, {}, credentials({ ...cache, apiKeys: { KREA_API_TOKEN: TOKEN } }), health({ Krea: entry('valid') }));
    expect(configured.label).toBe('Verified credential');
    expect(configured.detail).toContain('API balance');
  });

  it.each([
    ['disconnected', 'Krea sign-in required'],
    ['connecting', 'Finish Krea sign-in'],
    ['needs_auth', 'Krea sign-in required'],
    ['error', 'Connection unavailable'],
  ] as const)('does not substitute a token for saved Krea MCP mode while %s', (status, label) => {
    const ready = modelReadiness(kreaVideo, freeze({ _kreaAuth: 'mcp' }), credentials({
      apiKeys: { KREA_API_TOKEN: TOKEN }, kreaConnection: { status }, kreaConnectionMode: 'api-token',
    }), health({ Krea: entry('valid') }));
    expect(ready).toMatchObject({ label, tone: 'warning', connectionLabel: 'Krea sign-in', setupTarget: { kind: 'krea-mcp' } });
    expect(ready.detail).toBe('This recipe uses Krea sign-in. Sign in to Krea in Settings; an API key doesn’t replace it.');
  });

  it('describes Krea sign-in separately from verified model availability or API credit checks', () => {
    const ready = modelReadiness(kreaImage, freeze({ _kreaAuth: 'mcp' }), credentials({
      kreaConnection: { status: 'connected', tools: ['generate', 'get_job'] },
    }), health({ Krea: entry('invalid') }));
    expect(ready).toMatchObject({ label: 'Krea signed in', tone: 'neutral', connectionLabel: 'Krea sign-in' });
    expect(ready.detail).toContain('compute units');
    expect(ready.detail).toContain('when you explicitly run');
    expect(ready.detail).not.toMatch(/verified|API balance/i);
  });

  it('waits for unknown MCP status while retaining independently loaded sign-in when API keys have not loaded', () => {
    const params = freeze({ _kreaAuth: 'mcp' });
    expect(modelReadiness(kreaImage, params, credentials({ loaded: false }), health())).toMatchObject({
      label: 'Connection not loaded', tone: 'neutral', connectionLabel: 'Krea sign-in', setupTarget: { kind: 'krea-mcp' },
    });
    expect(modelReadiness(kreaImage, params, credentials({ loaded: false, kreaConnection: { status: 'connected' } }), health())).toMatchObject({
      label: 'Krea signed in', tone: 'neutral', connectionLabel: 'Krea sign-in',
    });
  });

  it.each(['krea-2-generate', 'krea-style-search', 'krea-style-train', 'krea-library-manage'])('follows the saved billing choice on %s', (id) => {
    const signedIn = credentials({ kreaConnection: { status: 'connected' } });
    expect(modelReadiness(NODE_DEFINITIONS[id], freeze({ _kreaAuth: 'mcp' }), signedIn, health()))
      .toMatchObject({ label: 'Krea signed in', setupTarget: { kind: 'krea-mcp' } });
    // Recipes saved before the choice existed keep the API token.
    expect(modelReadiness(NODE_DEFINITIONS[id], freeze({}), signedIn, health())).toMatchObject({
      label: 'Setup required', connectionLabel: 'Krea API key', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' },
    });
  });

  it.each(['krea-moodboard-search', 'krea-moodboard-create'])('always needs Krea sign-in for account-only %s', (id) => {
    expect(modelReadiness(NODE_DEFINITIONS[id], freeze({}), credentials({ kreaConnection: { status: 'needs_auth' } }), health()))
      .toMatchObject({ label: 'Krea sign-in required', setupTarget: { kind: 'krea-mcp' } });
  });

  it('keeps the local Krea style-reference helper independent of token and MCP credentials', () => {
    expect(modelReadiness(NODE_DEFINITIONS['krea-image-style-reference'], freeze({ _kreaAuth: 'mcp' }),
      credentials({ kreaConnection: { status: 'needs_auth' } }), health())).toMatchObject({
      label: 'No API key required', tone: 'neutral',
    });
  });

  it('offers external Nous OAuth setup instead of treating a keyless definition as ready', () => {
    const definition = NODE_DEFINITIONS['nous-portal-universal'];
    const ready = modelReadiness(definition, {}, credentials(), health());
    expect(ready).toMatchObject({ label: 'Sign-in not checked', tone: 'neutral', connectionLabel: 'Nous sign-in',
      setupTarget: { kind: 'external', provider: 'nous' } });
    expect(ready.detail).toContain('local Hermes OAuth login');
    expect(modelReadiness(definition, {}, credentials(), health({ Nous: entry('not_configured') })).label).toBe('Setup required');
    expect(modelReadiness(definition, {}, credentials(), health({ Nous: entry('valid') })).label).toBe('Verified credential');
    expect(modelReadiness(definition, {}, credentials(), health({}, { loading: true })).label).toBe('Checking connection');
  });

  it.each([
    [undefined, 'FAL_KEY', 'Seedream 4.5'],
    ['flux-1-dev', 'FAL_KEY', 'Seedream 4.5'],
    ['seedream-4-5', 'FAL_KEY', 'Seedream 4.5'],
    ['nano-banana', 'GOOGLE_API_KEY', 'Nano Banana'],
    // Nano Banana's fal copy also runs on the Gemini API (2026-10-14); with
    // no key set, setup points at the maker's key, as for Veo and Meshy.
    ['nano-banana-fal-edit', 'GOOGLE_API_KEY', 'Nano Banana Edit (FAL)'],
    ['flux-kontext', 'FAL_KEY', 'FLUX Kontext'],
  ])('derives Cinema %s readiness from the actual scene base model', (model, key, name) => {
    const params = freeze({ scene: { base: { model }, shots: [{ id: 'retained-shot', prompt: 'fixture' }] } });
    const ready = modelReadiness(NODE_DEFINITIONS['cinema-scene'], params, credentials(), health());
    expect(ready).toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key } });
    expect(ready.detail).toContain(`${name} is the scene base model`);
  });

  it('keeps unsupported saved Cinema base models explicit without silently choosing another provider', () => {
    const params = freeze({ scene: { base: { model: 'saved-unknown-model' }, shots: [{ id: 'previous-result', imageUrl: '/kept.png' }] } });
    const ready = modelReadiness(NODE_DEFINITIONS['cinema-scene'], params, credentials({ apiKeys: { FAL_KEY: TOKEN } }), health({ FAL: entry('valid') }));
    expect(ready).toMatchObject({ label: 'Scene model unavailable', tone: 'warning' });
    expect(ready.setupTarget).toBeUndefined();
    expect(params.scene.base.model).toBe('saved-unknown-model');
    expect(params.scene.shots[0].imageUrl).toBe('/kept.png');
  });

  it('reads a QC node as local in heuristic mode and as a vision-model key in vision-llm mode', () => {
    const qc = NODE_DEFINITIONS['qc-frame-review'];
    expect(modelReadiness(qc, { mode: 'heuristic' }, credentials(), health())).toMatchObject({ label: 'No API key required' });
    const keyless = modelReadiness(qc, { mode: 'vision-llm' }, credentials(), health());
    expect(keyless).toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key: 'ANTHROPIC_API_KEY' } });
    expect(keyless.detail).toContain('no list price');
    // The handler uses the first key that is set, so readiness checks that one.
    const openai = modelReadiness(qc, { mode: 'vision-llm' }, credentials({ apiKeys: { OPENAI_API_KEY: TOKEN } }), health());
    expect(openai.setupTarget).toEqual({ kind: 'api-key', key: 'OPENAI_API_KEY' });
  });

  it('reads a QC node in Jev mode as the TypeSafe key, whatever vision keys are set', () => {
    const qc = NODE_DEFINITIONS['qc-composited-look'];
    const local = modelReadiness(qc, {}, credentials(), health());
    expect(local.detail).toContain('mode jev calls typesafe with TYPESAFE_API_KEY');
    const keyless = modelReadiness(qc, { mode: 'jev' }, credentials({ apiKeys: { OPENAI_API_KEY: TOKEN } }), health());
    expect(keyless).toMatchObject({ label: 'Setup required', setupTarget: { kind: 'api-key', key: 'TYPESAFE_API_KEY' } });
    expect(keyless.detail).toContain('Calls a typesafe model with TYPESAFE_API_KEY.');
    expect(keyless.detail).not.toContain('no list price');
    const keyed = modelReadiness(qc, { mode: 'jev' }, credentials({ apiKeys: { TYPESAFE_API_KEY: TOKEN } }), health());
    expect(keyed.setupTarget).toEqual({ kind: 'api-key', key: 'TYPESAFE_API_KEY' });
    expect(keyed.label).not.toBe('Setup required');
  });

  it('explains Paper and local-input prerequisites without an API setup target or a ready promise', () => {
    const paper = modelReadiness(NODE_DEFINITIONS['paper-source'], {}, credentials(), health());
    expect(paper).toMatchObject({ label: 'Paper link required', tone: 'neutral' });
    expect(paper.detail).toContain('local Paper app');
    expect(paper.detail).toContain('refreshing never generate');
    expect(paper.setupTarget).toBeUndefined();
    const local = modelReadiness(NODE_DEFINITIONS['image-input'], {}, credentials(), health());
    expect(local).toMatchObject({ label: 'No API key required', tone: 'neutral' });
    expect(local.detail).toContain('inputs and local tools may still need setup');
    expect(local.setupTarget).toBeUndefined();
  });

  it.each([
    ['current', 'Paper snapshot linked', 'neutral'],
    ['unavailable', 'Paper source unavailable', 'warning'],
    ['missing', 'Paper source unavailable', 'warning'],
  ] as const)('retains a saved Paper snapshot while its source is %s', (state, label, tone) => {
    const params = freeze({ _paperSource: { id: 'source-fixture', state,
      snapshot: { hash: 'saved-hash', previewUrl: '/api/outputs/paper/kept.png' } } });
    const ready = modelReadiness(NODE_DEFINITIONS['paper-source'], params, credentials(), health());
    expect(ready).toMatchObject({ label, tone });
    expect(ready.detail).toContain('saved Paper snapshot is retained');
    expect(ready.detail).toContain('refresh never generates');
    expect(ready.setupTarget).toBeUndefined();
    expect(params._paperSource.snapshot.previewUrl).toBe('/api/outputs/paper/kept.png');
  });

  it('leaves saved params, outputs, connection choices and cached health immutable across repeated checks', () => {
    const params = freeze({ _kreaAuth: 'mcp', prompt: 'saved prompt', recipe: { snapshot: '/immutable.png' },
      output: { image: '/previous.png' }, history: [{ status: 'done', id: 'earlier-run' }] });
    const cache = credentials({ apiKeys: { KREA_API_TOKEN: TOKEN }, kreaConnection: { status: 'connected', tools: ['generate'] },
      kreaConnectionMode: 'api-token' });
    const checked = health({ Krea: entry('valid') });
    const before = JSON.stringify({ params, cache, checked });
    modelReadiness(kreaImage, params, cache, checked);
    keyReadiness('KREA_API_TOKEN', cache, checked);
    modelReadiness(NODE_DEFINITIONS['paper-source'], params, cache, checked);
    expect(JSON.stringify({ params, cache, checked })).toBe(before);
  });
});
