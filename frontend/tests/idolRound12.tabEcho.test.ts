/**
 * PR #203 round 12, review 11 copy MEDIUM-1, as the live app runs it: the id
 * this tab's settings writes carry (apiFetch's X-Nebula-Tab) is the id its
 * socket drops the echo of. Round 12's first build kept a second id in
 * settingsSignal.ts; apiFetch overwrote the header with lib/tabId.ts's, so
 * every echo read as a change made elsewhere and the person's own save was
 * said twice in the live app, while tests that took both ids from one module
 * passed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSettingsApiKey, updateCredential, updateSettings } from '../src/lib/api';
import { wsClient } from '../src/lib/wsClient';
import { SETTINGS_SAVED_EVENT } from '../src/store/settingsChangedSocket';

const sentTabs: (string | null)[] = [];

beforeEach(() => {
  sentTabs.length = 0;
  vi.stubGlobal('nebulaDesktop', { apiBaseUrl: 'http://127.0.0.1:56789' });
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    sentTabs.push(new Headers(init?.headers).get('X-Nebula-Tab'));
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const heard = (origin: string | undefined) => {
  const events: unknown[] = [];
  const listener = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener(SETTINGS_SAVED_EVENT, listener);
  (wsClient as unknown as { dispatch: (event: unknown) => void })
    .dispatch({ type: 'settingsChanged', keys: ['HF_TOKEN'], ...(origin ? { origin } : {}) });
  window.removeEventListener(SETTINGS_SAVED_EVENT, listener);
  return events;
};

describe('the echo of a settings write this tab sent (review 11, copy MEDIUM-1)', () => {
  it('carries one tab id on the save, the removal and the desktop credential write', async () => {
    await updateSettings({ apiKeys: { HF_TOKEN: 'hf_fixture' } });
    await deleteSettingsApiKey('HF_TOKEN');
    await updateCredential('HF_TOKEN', '');
    expect(sentTabs).toHaveLength(3);
    expect(sentTabs[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(new Set(sentTabs).size).toBe(1);
  });

  it('is dropped when it comes back with the id the write sent', async () => {
    await updateSettings({ apiKeys: { HF_TOKEN: 'hf_fixture' } });
    expect(heard(sentTabs[0]!)).toEqual([]);
  });

  it('is said when another tab, the CLI or nothing named the write', async () => {
    await updateSettings({ apiKeys: { HF_TOKEN: 'hf_fixture' } });
    expect(heard('tab-another-window-0001')).toEqual([{ source: 'remote', keys: ['HF_TOKEN'] }]);
    expect(heard(undefined)).toEqual([{ source: 'remote', keys: ['HF_TOKEN'] }]);
  });
});
