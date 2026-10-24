import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import {
  checkKreaConnection, connectKrea, disconnectKrea, getKreaConnection, getKreaPlans,
  isKreaAuthorizationUrl, isSafeKreaBillingUrl, startKreaTrial, kreaModeFor, nodeKeyStatus, supportsKreaAccount,
  usesKreaAccount, withNewKreaMode,
} from '../../src/lib/kreaConnection';
import { ConnectionLostError, FailureNotice } from '../../src/lib/errorCopy';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/backend', () => ({ apiFetch: apiFetchMock }));

const image = NODE_DEFINITIONS['krea-image-openai-gpt-image-2'];
const video = NODE_DEFINITIONS['krea-video-kling-kling-3-0'];

describe('Krea connection contract', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('offers account billing to every Krea node that declares it', () => {
    for (const id of ['krea-image-openai-gpt-image-2', 'krea-video-kling-kling-3-0',
      'krea-audio-elevenlabs-music-v2-5', 'krea-enhance-magnific-creative-enhance', 'krea-3d-microsoft-trellis-2']) {
      expect(supportsKreaAccount(NODE_DEFINITIONS[id]), id).toBe(true);
    }
    // Value-only nodes never call Krea, and other providers never see the choice.
    expect(supportsKreaAccount(NODE_DEFINITIONS['krea-image-style-reference'])).toBe(false);
    expect(supportsKreaAccount(NODE_DEFINITIONS['nano-banana'])).toBe(false);
  });

  it('applies the selected mode only to new account-capable params and preserves old API recipes', () => {
    const old = { prompt: 'a cat' };
    expect(withNewKreaMode(image, old, 'mcp')).toEqual({ ...old, _kreaAuth: 'mcp' });
    expect(old).toEqual({ prompt: 'a cat' });
    expect(kreaModeFor(image, old)).toBe('api-token');
    expect(kreaModeFor(image, { _kreaAuth: 'mcp' })).toBe('mcp');
    expect(usesKreaAccount(image, { _kreaAuth: 'mcp' })).toBe(true);
    expect(usesKreaAccount(NODE_DEFINITIONS['nano-banana'], { _kreaAuth: 'mcp' })).toBe(false);
    expect(withNewKreaMode(NODE_DEFINITIONS['nano-banana'], old, 'mcp')).toBe(old);
  });

  it('checks the chosen billing connection without accepting the other credential', () => {
    const oauth = { loaded: true, apiKeys: {}, kreaConnection: { status: 'connected' as const } };
    const api = { loaded: true, apiKeys: { KREA_API_TOKEN: 'fixture-only' },
      kreaConnection: { status: 'needs_auth' as const } };
    expect(nodeKeyStatus(image, { _kreaAuth: 'mcp' }, oauth)).toBeUndefined();
    expect(nodeKeyStatus(image, {}, oauth)).toBe('missing');
    expect(nodeKeyStatus(image, { _kreaAuth: 'api-token' }, api)).toBeUndefined();
    expect(nodeKeyStatus(image, { _kreaAuth: 'mcp' }, api)).toBe('missing');
    expect(nodeKeyStatus(video, { _kreaAuth: 'mcp' }, { ...oauth,
      kreaConnection: { status: 'connecting' } })).toBe('missing');
    expect(nodeKeyStatus(image, {}, { ...oauth, loaded: false })).toBeUndefined();
  });

  it('allows only the official consent page to open outside Nebula', () => {
    expect(isKreaAuthorizationUrl('https://www.krea.ai/auth/v1/oauth/authorize?state=fixture')).toBe(true);
    for (const url of ['http://www.krea.ai/auth/v1/oauth/authorize',
      'https://www.krea.ai.evil.test/auth/v1/oauth/authorize',
      'https://user:secret@www.krea.ai/auth/v1/oauth/authorize',
      'https://www.krea.ai/auth/v1/oauth/authorize#token', 'javascript:alert(1)',
      'https://www.krea.ai/other']) expect(isKreaAuthorizationUrl(url)).toBe(false);
  });

  it('uses only connector routes and never generation endpoints', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'disconnected' }) });
    await getKreaConnection();
    await connectKrea();
    await checkKreaConnection();
    await disconnectKrea();
    expect(apiFetchMock.mock.calls).toEqual([
      ['/api/krea/connection', { method: 'GET' }],
      ['/api/krea/connection/connect', { method: 'POST' }],
      ['/api/krea/connection/check', { method: 'POST' }],
      ['/api/krea/connection', { method: 'DELETE' }],
    ]);
  });

  it('keeps transport and response errors out of the visible error message', async () => {
    // Error copy round 3e (GM): "Couldn't {verb} {object}." then the reason;
    // never "Could not", and still never the error's own text (it can hold
    // credential-bearing URLs).
    const GENERAL = "Try again, or reload if it keeps happening.";
    const HEADING = "Couldn't update the Krea connection.";
    apiFetchMock.mockRejectedValueOnce(new Error('https://private.test/?token=fixture-secret'));
    await expect(connectKrea()).rejects.toThrow(`${HEADING} ${GENERAL}`);
    // No answer, as apiFetch throws it: the connection line (typeerror, 2026-10-24).
    apiFetchMock.mockRejectedValueOnce(new ConnectionLostError(new TypeError('Failed to fetch https://private.test/?token=fixture-secret')));
    await expect(connectKrea()).rejects.toThrow(`${HEADING} Nebula's server isn't answering. Make sure it's running, then try again.`);
    // A TypeError that isn't fetch's no-answer (a bug in the browser) is GM's general line, not "isn't answering".
    apiFetchMock.mockRejectedValueOnce(new TypeError('Do not know how to serialize a BigInt https://private.test/?token=fixture-secret'));
    await expect(connectKrea()).rejects.toThrow(`${HEADING} ${GENERAL}`);
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn() });
    await expect(checkKreaConnection()).rejects.toThrow(`${HEADING} Nebula didn't respond. Try again.`);
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('token=fixture'); } });
    const error = await getKreaConnection().catch((e: Error) => e);
    expect(error.message).toBe(`${HEADING} ${GENERAL}`);
    expect(error).toBeInstanceOf(FailureNotice);
  });

  it("names the plans and the trial by their action, never 'Could not'", async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: vi.fn() });
    await expect(getKreaPlans()).rejects.toThrow(/^Couldn't load the Krea plans\. /);
    apiFetchMock.mockRejectedValueOnce(new Error('https://private.test/?token=fixture-secret'));
    const trial = await startKreaTrial().catch((e: Error) => e);
    expect(trial.message).toMatch(/^Couldn't start the Krea trial\. /);
    expect(trial.message).not.toMatch(/token|Could not/);
  });

  it('loads plans and starts the trial only through the fixed plan routes', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      plans: [{ id: 'creator_pro', name: 'Pro', checkoutUrl: 'https://www.krea.ai/pricing?plan=creator_pro',
        annualCheckoutUrl: 'https://evil.test/pay' }],
      trialAvailable: true, annualSavingsPct: 40, manageUrl: 'http://www.krea.ai/pricing' }) });
    const plans = await getKreaPlans();
    expect(plans.plans[0].checkoutUrl).toBe('https://www.krea.ai/pricing?plan=creator_pro');
    expect(plans.plans[0].annualCheckoutUrl).toBeNull();
    expect(plans.manageUrl).toBeNull();
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_1' }) });
    await expect(startKreaTrial()).resolves.toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(apiFetchMock.mock.calls).toEqual([['/api/krea/plans'], ['/api/krea/trial', { method: 'POST' }]]);
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://stripe.evil.test/pay' }) });
    await expect(startKreaTrial()).rejects.toThrow('unexpected trial link');
  });

  it('accepts billing links only on Krea, or Stripe checkout for the trial', () => {
    expect(isSafeKreaBillingUrl('https://www.krea.ai/pricing')).toBe(true);
    expect(isSafeKreaBillingUrl('https://checkout.stripe.com/c/pay')).toBe(false);
    expect(isSafeKreaBillingUrl('https://checkout.stripe.com/c/pay', true)).toBe(true);
    for (const bad of ['http://www.krea.ai/', 'https://u:p@www.krea.ai/', 'https://www.krea.ai:8443/',
      'javascript:alert(1)', 'https://krea.ai.evil.test/', 42]) {
      expect(isSafeKreaBillingUrl(bad, true), String(bad)).toBe(false);
    }
  });
});
