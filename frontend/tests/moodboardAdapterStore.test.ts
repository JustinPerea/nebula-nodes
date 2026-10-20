import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../src/lib/backend', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { useMoodboardAdapterStore } = await import('../src/store/moodboardAdapterStore');

beforeEach(() => useMoodboardAdapterStore.setState({ entries: null, loading: false, failed: false }));
afterEach(() => apiFetch.mockReset());

describe('moodboard adapter store', () => {
  it('loads the table once from GET /api/moodboard/adapters', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ entries: { 'flux-2-pro': { channel: 'text-only' } } })));
    await useMoodboardAdapterStore.getState().load();
    await useMoodboardAdapterStore.getState().load();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/moodboard/adapters');
    expect(useMoodboardAdapterStore.getState()).toMatchObject({
      entries: { 'flux-2-pro': { channel: 'text-only' } }, failed: false });
  });

  it('stays empty on a failed or malformed answer, and tries again next time', async () => {
    apiFetch.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    await useMoodboardAdapterStore.getState().load();
    expect(useMoodboardAdapterStore.getState()).toMatchObject({ entries: null, loading: false, failed: true });
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] })));
    await useMoodboardAdapterStore.getState().load();
    expect(useMoodboardAdapterStore.getState().entries).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
