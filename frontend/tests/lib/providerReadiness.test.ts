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

const kreaImage = NODE_DEFINITIONS['krea-image-openai-gpt-image-2'];
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
    expect(modelReadiness(dualRoute, {}, credentials(), bothValid)).toMatchObject({
      label: 'Setup required', setupTarget: { kind: 'api-key', key: 'GOOGLE_API_KEY' },
    });
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
      label: 'Setup required', connectionLabel: 'Krea API token', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' },
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
    expect(ready.detail).toContain('an API token does not replace');
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
      label: 'Setup required', connectionLabel: 'Krea API token', setupTarget: { kind: 'api-key', key: 'KREA_API_TOKEN' },
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
    ['nano-banana-fal-edit', 'FAL_KEY', 'Nano Banana Edit (FAL)'],
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
