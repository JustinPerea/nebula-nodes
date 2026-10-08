import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({ ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch }));
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({}), fetchCLIGraph: () => new Promise(() => {}),
}));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: vi.fn().mockResolvedValue({ status: 'disconnected' }),
}));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => <div>Current canvas</div> }));
vi.mock('../src/components/CanvasTabs', () => ({ CanvasTabs: () => null }));
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => null }));
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ProviderRecoveryStatus', () => ({ ProviderRecoveryStatus: () => null }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => null }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => null }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({ NodeInspectorPopover: () => null }));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/panels/Settings', () => ({ Settings: () => null }));
vi.mock('../src/components/panels/ChatPanel', async () => {
  const { useState } = await import('react');
  return { ChatPanel: function Chat() {
    const [value, setValue] = useState('Saved conversation');
    return <button onClick={() => setValue('Continued conversation')}>{value}</button>;
  } };
});
vi.mock('../src/components/commons/CommonsView', async () => {
  const { useUIStore } = await import('../src/store/uiStore');
  return { CommonsView: () => <button onClick={() => useUIStore.getState().exitCommons()}>Return from Commons</button> };
});
import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { getSettings } from '../src/lib/api';
const initialUI = useUIStore.getState();
beforeEach(() => { vi.mocked(getSettings).mockReset(); useUIStore.setState(initialUI, true); api.fetch.mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { headers: { 'content-type': 'application/json' } })); });
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

it('does not restore old configured keys after the Settings panel has refreshed removal readiness', async () => {
  const load = deferred<Record<string, unknown>>();
  vi.mocked(getSettings).mockReturnValueOnce(load.promise);
  render(<App />);
  act(() => useUIStore.getState().setSettingsCache({ FAL_KEY: '***remaining' }, 'mcp'));
  await act(async () => load.resolve({ apiKeys: { OPENAI_API_KEY: '***removed', FAL_KEY: '***remaining' } }));
  expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ FAL_KEY: '***remaining' });
  expect(useUIStore.getState().settingsCache.kreaConnectionMode).toBe('mcp');
});

it('only accepts the newest settings-saved refresh, even when an earlier refresh resolves first', async () => {
  const oldRefresh = deferred<Record<string, unknown>>();
  const newRefresh = deferred<Record<string, unknown>>();
  vi.mocked(getSettings).mockResolvedValueOnce({ apiKeys: {} })
    .mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(newRefresh.promise);
  render(<App />);
  await waitFor(() => expect(useUIStore.getState().settingsCache.loaded).toBe(true));
  act(() => {
    window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
    window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
  });
  await act(async () => oldRefresh.resolve({ apiKeys: { OPENAI_API_KEY: '***outdated' } }));
  expect(useUIStore.getState().settingsCache.apiKeys).toEqual({});
  await act(async () => newRefresh.resolve({ apiKeys: { FAL_KEY: '***current' } }));
  expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ FAL_KEY: '***current' });
});

it('does not apply a pending initial or saved refresh after App unmounts', async () => {
  const initialLoad = deferred<Record<string, unknown>>();
  const refresh = deferred<Record<string, unknown>>();
  vi.mocked(getSettings).mockReturnValueOnce(initialLoad.promise).mockReturnValueOnce(refresh.promise);
  const app = render(<App />);
  act(() => window.dispatchEvent(new CustomEvent('nebula:settings-saved')));
  app.unmount();
  const cache = useUIStore.getState().settingsCache;
  await act(async () => {
    initialLoad.resolve({ apiKeys: { OPENAI_API_KEY: '***stale-initial' } });
    refresh.resolve({ apiKeys: { FAL_KEY: '***stale-refresh' } });
  });
  expect(useUIStore.getState().settingsCache).toBe(cache);
});

it('still loads keys when the separate Krea connection check updates first', async () => {
  const load = deferred<Record<string, unknown>>();
  vi.mocked(getSettings).mockReturnValueOnce(load.promise);
  render(<App />);
  await waitFor(() => expect(useUIStore.getState().settingsCache.kreaConnection?.status).toBe('disconnected'));
  await act(async () => load.resolve({ apiKeys: { FAL_KEY: '***current' } }));
  expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ FAL_KEY: '***current' });
  expect(useUIStore.getState().settingsCache.loaded).toBe(true);
});
