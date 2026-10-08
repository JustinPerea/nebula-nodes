import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: fetch,
}));
import { useProviderReadinessStore } from '../src/store/providerReadinessStore';
import { useUIStore } from '../src/store/uiStore';
import { PROVIDER_HEALTH_TTL_MS } from '../src/lib/providerReadiness';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
function response(provider = 'OpenAI', status = 'valid') {
  return new Response(JSON.stringify({ providers: { [provider]: { configured: true, status,
    last_checked: new Date(Date.now()).toISOString(), detail: 'https://private.test/?token=fixture-private' } } }),
  { headers: { 'content-type': 'application/json' } });
}
beforeEach(() => { fetch.mockReset(); useProviderReadinessStore.getState().invalidate(); });
afterEach(() => { useProviderReadinessStore.getState().invalidate(); vi.useRealTimers(); });

describe('explicit provider connection checks', () => {
  it('does no checking on import or credential cache changes; explicit checks use only the health endpoint', async () => {
    const initial = useUIStore.getState().settingsCache;
    useUIStore.getState().setSettingsCache({ OPENAI_API_KEY: '***fixture' });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(response());
    await useProviderReadinessStore.getState().checkConnections();
    expect(fetch.mock.calls).toEqual([['/api/health/providers?refresh=true']]);
    expect(useProviderReadinessStore.getState().providers.OpenAI.status).toBe('valid');
    expect(JSON.stringify(useProviderReadinessStore.getState())).not.toContain('fixture-private');
    useUIStore.setState({ settingsCache: initial });
  });

  it.each(['settings-saved', 'cache-revision'])('discards checks begun before a %s change', async (change) => {
    const pending = deferred<Response>();
    fetch.mockReturnValue(pending.promise);
    const check = useProviderReadinessStore.getState().checkConnections();
    if (change === 'settings-saved') window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
    else useUIStore.getState().setSettingsCache({ OPENAI_API_KEY: '***new-fixture' });
    pending.resolve(response());
    await check;
    expect(useProviderReadinessStore.getState()).toMatchObject({ providers: {}, checkedAt: null, loading: false, error: null });
  });

  it('only accepts the newest explicit check', async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = useProviderReadinessStore.getState().checkConnections();
    const second = useProviderReadinessStore.getState().checkConnections();
    current.resolve(response('OpenAI', 'invalid'));
    await second;
    old.resolve(response('OpenAI', 'valid'));
    await first;
    expect(useProviderReadinessStore.getState().providers.OpenAI.status).toBe('invalid');
  });

  it('expires continuously displayed verification with one shared timer and no new provider request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T16:00:00Z'));
    fetch.mockResolvedValue(response());
    await useProviderReadinessStore.getState().checkConnections();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(PROVIDER_HEALTH_TTL_MS - 1);
    expect(useProviderReadinessStore.getState().providers.OpenAI.status).toBe('valid');
    await vi.advanceTimersByTimeAsync(1);
    expect(useProviderReadinessStore.getState()).toMatchObject({ providers: {}, checkedAt: null });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('sanitizes transport failures and rejects malformed status data', async () => {
    fetch.mockRejectedValueOnce(new Error('https://private.test/?token=secret'));
    await useProviderReadinessStore.getState().checkConnections();
    expect(useProviderReadinessStore.getState().error).toContain('Connections could not be checked');
    expect(useProviderReadinessStore.getState().error).not.toContain('secret');
    fetch.mockResolvedValue(response('OpenAI', 'surprise-status'));
    await useProviderReadinessStore.getState().checkConnections();
    expect(useProviderReadinessStore.getState()).toMatchObject({ providers: {}, checkedAt: null, loading: false });
    expect(useProviderReadinessStore.getState().error).toContain('Connections could not be checked');
  });
});
