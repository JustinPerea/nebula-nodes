import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing components
// ---------------------------------------------------------------------------

const getSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const updateCredentialMock = vi.fn();
const deleteSettingsApiKeyMock = vi.fn();
const getKreaConnectionMock = vi.fn();
const connectKreaMock = vi.fn();
const checkKreaConnectionMock = vi.fn();
const disconnectKreaMock = vi.fn();
const getKreaPlansMock = vi.fn();
const startKreaTrialMock = vi.fn();
const providerApiFetchMock = vi.fn();

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => providerApiFetchMock(...args),
}));

vi.mock('../src/lib/api', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  updateSettings: (...args: unknown[]) => updateSettingsMock(...args),
  updateCredential: (...args: unknown[]) => updateCredentialMock(...args),
  deleteSettingsApiKey: (...args: unknown[]) => deleteSettingsApiKeyMock(...args),
}));

vi.mock('../src/lib/kreaConnection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: (...args: unknown[]) => getKreaConnectionMock(...args),
  connectKrea: (...args: unknown[]) => connectKreaMock(...args),
  checkKreaConnection: (...args: unknown[]) => checkKreaConnectionMock(...args),
  disconnectKrea: (...args: unknown[]) => disconnectKreaMock(...args),
  getKreaPlans: (...args: unknown[]) => getKreaPlansMock(...args),
  startKreaTrial: (...args: unknown[]) => startKreaTrialMock(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { Settings } from '../src/components/panels/Settings';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';
import { useSettingsDraftStore } from '../src/store/settingsDraftStore';
import { useProviderReadinessStore } from '../src/store/providerReadinessStore';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_DRAFT_STATE = { ...useSettingsDraftStore.getState() };

beforeEach(() => {
  useProviderReadinessStore.getState().invalidate();
  providerApiFetchMock.mockReset();
  useSettingsDraftStore.setState(INITIAL_DRAFT_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
  useUIStore.setState((state) => ({
    panels: {
      ...state.panels,
      settings: { ...state.panels.settings, visible: true },
    },
  }));

  getSettingsMock.mockReset();
  updateSettingsMock.mockReset();
  updateCredentialMock.mockReset();
  deleteSettingsApiKeyMock.mockReset().mockResolvedValue({ status: 'removed' });
  updateSettingsMock.mockResolvedValue({ status: 'ok' });
  updateCredentialMock.mockResolvedValue({ status: 'updated' });
  getKreaConnectionMock.mockReset().mockResolvedValue({ status: 'disconnected' });
  connectKreaMock.mockReset().mockResolvedValue({ status: 'connecting',
    authorizationUrl: 'https://www.krea.ai/auth/v1/oauth/authorize?state=test' });
  checkKreaConnectionMock.mockReset().mockResolvedValue({ status: 'connected', tools: ['list_models'] });
  disconnectKreaMock.mockReset().mockResolvedValue({ status: 'disconnected' });
  getKreaPlansMock.mockReset();
  startKreaTrialMock.mockReset();
  vi.spyOn(window, 'open').mockReturnValue(null);

  // Clean window.nebulaDesktop between tests
  delete (window as Record<string, unknown>).nebulaDesktop;
});

afterEach(() => {
  useProviderReadinessStore.getState().invalidate();
  vi.useRealTimers();
  delete (window as Record<string, unknown>).nebulaDesktop;
  vi.restoreAllMocks();
});

describe('Settings provider discovery handoff', () => {
  it('retries an initial settings read if a newer credential cache refresh overtakes it', async () => {
    let finishLoad!: (value: Record<string, unknown>) => void;
    getSettingsMock.mockReturnValueOnce(new Promise<Record<string, unknown>>((resolve) => { finishLoad = resolve; }))
      .mockResolvedValueOnce({ apiKeys: { FAL_KEY: '***current' }, kreaConnectionMode: 'mcp' });
    render(<Settings />);
    act(() => useUIStore.getState().setSettingsCache({ FAL_KEY: '***current' }, 'mcp'));
    await act(async () => finishLoad({ apiKeys: { OPENAI_API_KEY: '***outdated' } }));
    await expandApiKeys();
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    expect(screen.getByLabelText('fal.ai API key')).toHaveValue('***current');
    expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ FAL_KEY: '***current' });
    expect(useUIStore.getState().settingsCache.kreaConnectionMode).toBe('mcp');
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it('opens and focuses the requested API-key field without changing graph, draft or checking providers', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: { OPENAI_API_KEY: '***saved' } });
    const graph = useGraphStore.getState();
    act(() => useUIStore.getState().openProviderSetup({ kind: 'api-key', key: 'OPENAI_API_KEY' }));
    render(<Settings />);
    const key = await screen.findByRole('textbox', { name: 'Output Path' });
    expect(key).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('OpenAI API key')).toHaveFocus());
    expect(screen.getByRole('button', { name: /API Keys/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('***saved');
    expect(providerApiFetchMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes).toBe(graph.nodes);
    expect(useGraphStore.getState().edges).toBe(graph.edges);
    expect(useGraphStore.getState().runHistory).toBe(graph.runHistory);
  });

  it('retains unsaved provider edits when setup is opened for another provider', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: { OPENAI_API_KEY: '***saved' } });
    render(<Settings />);
    await expandApiKeys();
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'fixture-unsaved' } });
    act(() => useUIStore.getState().openProviderSetup({ kind: 'api-key', key: 'FAL_KEY' }));
    await waitFor(() => expect(screen.getByLabelText('fal.ai API key')).toHaveFocus());
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('fixture-unsaved');
    expect(getSettingsMock).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeDisabled();
    expect(providerApiFetchMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it.each(['krea-mcp', 'nous'])('focuses %s setup without starting sign-in, checking or generating', async (kind) => {
    getSettingsMock.mockResolvedValue({ apiKeys: {} });
    act(() => useUIStore.getState().openProviderSetup(kind === 'krea-mcp' ? { kind } : { kind: 'external', provider: 'nous' }));
    render(<Settings />);
    if (kind === 'krea-mcp') await waitFor(() => expect(screen.getByRole('button', { name: 'Connect to Krea' })).toHaveFocus());
    else {
      await waitFor(() => expect(screen.getByRole('region', { name: 'Nous Portal setup' })).toHaveFocus());
      expect(screen.getByText('hermes-daedalus model')).toBeInTheDocument();
    }
    expect(connectKreaMock).not.toHaveBeenCalled();
    expect(checkKreaConnectionMock).not.toHaveBeenCalled();
    expect(providerApiFetchMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('checks saved credentials only on explicit action, and shows credential proof without model claims', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: { OPENAI_API_KEY: '***saved' } });
    providerApiFetchMock.mockResolvedValue(new Response(JSON.stringify({ providers: {
      OpenAI: { configured: true, status: 'valid', last_checked: new Date().toISOString() },
    } })));
    render(<Settings />);
    await expandApiKeys();
    expect(providerApiFetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check connections' }));
    await screen.findByText('Verified credential');
    expect(screen.getByText('1 verified credential. Checks expire after five minutes.')).toBeInTheDocument();
    expect(providerApiFetchMock.mock.calls).toEqual([['/api/health/providers?refresh=true']]);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it.each(['stale', 'future'])('excludes %s check timestamps from its verified credential count', async (timestamp) => {
    getSettingsMock.mockResolvedValue({ apiKeys: { OPENAI_API_KEY: '***saved' } });
    render(<Settings />);
    await expandApiKeys();
    act(() => useProviderReadinessStore.setState({ providers: { OpenAI: {
      configured: true, status: 'valid', last_checked: new Date(Date.now() + (timestamp === 'future' ? 60_000 : -300_000)).toISOString(),
    } }, checkedAt: Date.now() }));
    expect(screen.getByText('0 verified credentials. Checks expire after five minutes.')).toBeInTheDocument();
    expect(screen.queryByText('Verified credential')).not.toBeInTheDocument();
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it.each(['save', 'remove'])('invalidates a pending check at %s start before the mutation finishes', async (operation) => {
    let finishCheck!: (value: Response) => void;
    providerApiFetchMock.mockReturnValue(new Promise<Response>((resolve) => { finishCheck = resolve; }));
    getSettingsMock.mockResolvedValue({ apiKeys: { OPENAI_API_KEY: '***saved' } });
    updateSettingsMock.mockReturnValue(new Promise(() => {}));
    deleteSettingsApiKeyMock.mockReturnValue(new Promise(() => {}));
    render(<Settings />);
    await expandApiKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Check connections' }));
    if (operation === 'save') {
      fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'fixture-new-key' } });
      clickSave();
    } else fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI API key' }));
    await act(async () => finishCheck(new Response(JSON.stringify({ providers: {
      OpenAI: { configured: true, status: 'valid', last_checked: new Date().toISOString() },
    } }))));
    expect(useProviderReadinessStore.getState()).toMatchObject({ providers: {}, checkedAt: null, loading: false });
    expect(screen.queryByText('Verified credential')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set up the window.nebulaDesktop bridge for desktop mode tests.
 */
function setupDesktopBridge(overrides?: {
  set?: (provider: string, key: string) => Promise<unknown>;
  clear?: (provider: string) => Promise<unknown>;
  has?: (provider: string) => Promise<unknown>;
  plaintextKeyWarning?: string[];
  kreaOpen?: (url: string) => Promise<unknown>;
}) {
  const credentials = Object.freeze({
    set: overrides?.set ?? vi.fn().mockResolvedValue({ ok: true }),
    has: overrides?.has ?? vi.fn().mockResolvedValue({ ok: true, has: false }),
    clear: overrides?.clear ?? vi.fn().mockResolvedValue({ ok: true }),
  });
  const migration = Object.freeze({
    status: vi.fn().mockResolvedValue({ ok: true, status: 'complete' }),
    retry: vi.fn().mockResolvedValue({ ok: true, status: 'complete' }),
  });

  (window as Record<string, unknown>).nebulaDesktop = Object.freeze({
    platform: 'darwin',
    shell: 'electron',
    apiBaseUrl: 'http://127.0.0.1:9999',
    wsBaseUrl: 'ws://127.0.0.1:9999',
    credentials,
    migration,
    ...(overrides?.kreaOpen ? { kreaLinks: Object.freeze({ open: overrides.kreaOpen }) } : {}),
    plaintextKeyWarning: Object.freeze(overrides?.plaintextKeyWarning ?? []),
  });

  return { credentials, migration };
}

/**
 * Wait for the settings panel to finish loading and expand the API Keys section.
 */
async function expandApiKeys() {
  await waitFor(() => {
    expect(screen.getByText('API Keys')).toBeInTheDocument();
  });
  const toggle = screen.getByText('API Keys').closest('button');
  expect(toggle).toBeTruthy();
  fireEvent.click(toggle!);
  await waitFor(() => {
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
  });
}

/**
 * Click the Save Settings button.
 */
function clickSave() {
  const saveButton = screen.getByText('Save Settings');
  fireEvent.click(saveButton);
}

// ---------------------------------------------------------------------------
// Tests: Browser mode (unchanged behavior)
// ---------------------------------------------------------------------------

describe('Settings — browser mode (no desktop bridge)', () => {
  it('keeps interface and connection settings without alternate theme choices', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {}, outputPath: '' });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText('Interface')).toBeInTheDocument());

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Connections')).toBeInTheDocument();
    expect(screen.queryByText('Skin')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByText('Only render on-screen nodes; show minimap. Recommended for large graphs.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close settings panel' })).toHaveFocus();
  });

  it('closes from focused settings controls with Escape and restores the opener', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {}, outputPath: '' });
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    useUIStore.getState().setLeftDock('settings');
    const rendered = render(<Settings />);
    try {
      const close = await screen.findByRole('button', { name: 'Close settings panel' });
      await waitFor(() => expect(close).toHaveFocus());
      fireEvent.keyDown(close, { key: 'Escape' });
      expect(useUIStore.getState().panels.settings.visible).toBe(false);
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      rendered.unmount();
      opener.remove();
    }
  });

  it('does not show the Keychain badge', async () => {
    getSettingsMock.mockResolvedValue({
      apiKeys: { OPENAI_API_KEY: 'test-fake-key-123' },
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('API Keys')).toBeInTheDocument();
    });

    expect(screen.queryByText('Managed by macOS Keychain')).not.toBeInTheDocument();
  });

  it('does not show a plaintext warning banner', async () => {
    getSettingsMock.mockResolvedValue({
      apiKeys: { OPENAI_API_KEY: 'test-fake-key-123' },
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('API Keys')).toBeInTheDocument();
    });

    expect(screen.queryByText(/Plaintext credentials detected/i)).not.toBeInTheDocument();
  });

  it('saves all settings including apiKeys via PUT /api/settings', async () => {
    getSettingsMock.mockResolvedValue({
      apiKeys: { OPENAI_API_KEY: 'test-fake-key-123' },
      routing: {},
      outputPath: '/custom',
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Save Settings')).toBeInTheDocument();
    });

    clickSave();

    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    });

    const callArgs = updateSettingsMock.mock.calls[0][0];
    expect(callArgs.apiKeys).toBeDefined();
    expect(callArgs.outputPath).toBe('/custom');
  });
});

describe('Settings — Krea MCP connection', () => {
  beforeEach(() => {
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {}, outputPath: '' });
  });

  it('starts consent, exposes a browser link and leaves recipes and generation untouched', async () => {
    const params = { prompt: 'saved logo', _kreaAuth: 'api-token' };
    const nodes = [{ id: 'saved', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Saved Krea recipe', definitionId: 'krea-image-openai-gpt-image-2',
        params, state: 'idle' as const, outputs: {} } }];
    useGraphStore.setState({ nodes, edges: [], runHistory: [] });
    const executeNode = vi.spyOn(useGraphStore.getState(), 'executeNode');
    const executeGraph = vi.spyOn(useGraphStore.getState(), 'executeGraph');
    render(<Settings />);
    await screen.findByText('Not connected');

    fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' }));
    const link = await screen.findByRole('link', { name: 'Open Krea sign-in' });
    expect(link).toHaveAttribute('href', 'https://www.krea.ai/auth/v1/oauth/authorize?state=test');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/workspace’s compute units/)).toBeInTheDocument();
    expect(connectKreaMock).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().nodes).toEqual(nodes);
    expect(useGraphStore.getState().runHistory).toEqual([]);
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('polls pending consent and allows checking and disconnecting without changing the default', async () => {
    render(<Settings />);
    await screen.findByText('Not connected');
    vi.useFakeTimers();
    getKreaConnectionMock.mockResolvedValueOnce({ status: 'connected', tools: ['generate_image'] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' })); });
    expect(screen.getByText('Waiting for Krea sign-in…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Krea sign-in' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check connection' })); });
    expect(checkKreaConnectionMock).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    expect(disconnectKreaMock).toHaveBeenCalledOnce();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Default Krea connection for new nodes' })).toHaveValue('api-token');
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('shows Krea plans on request when connected and opens checkout only from a link', async () => {
    getKreaConnectionMock.mockResolvedValue({ status: 'connected', tools: ['show_plans'] });
    getKreaPlansMock.mockResolvedValue({ trialAvailable: true, annualSavingsPct: 40,
      manageUrl: 'https://www.krea.ai/pricing', plans: [{ id: 'creator_pro', name: 'Pro', prominent: false,
        units: 20000, price: 35, annualPrice: 21, examples: [], features: [],
        checkoutUrl: 'https://www.krea.ai/pricing?plan=creator_pro', annualCheckoutUrl: null }] });
    startKreaTrialMock.mockResolvedValue('https://checkout.stripe.com/c/pay/cs_1');
    render(<Settings />);
    await screen.findByText('Connected');
    expect(getKreaPlansMock).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show Krea plans' })); });
    expect(screen.getByText('$35/mo · $21/mo yearly')).toBeInTheDocument();
    expect(screen.getByText('20,000 compute units')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View on Krea' })).toHaveAttribute('href', 'https://www.krea.ai/pricing?plan=creator_pro');
    expect(startKreaTrialMock).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start a free Pro trial' })); });
    const checkout = screen.getByRole('link', { name: 'Open trial checkout' });
    expect(checkout).toHaveAttribute('href', 'https://checkout.stripe.com/c/pay/cs_1');
    expect(checkout).toHaveAttribute('target', '_blank');
    expect(window.open).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('hides plans until Krea is connected', async () => {
    render(<Settings />);
    await screen.findByText('Not connected');
    expect(screen.queryByRole('button', { name: 'Show Krea plans' })).not.toBeInTheDocument();
  });

  it('saves the future-node default explicitly and does not rewrite existing nodes', async () => {
    const saved = { id: 'old', type: 'model-node', position: { x: 0, y: 0 }, data: {
      label: 'Old recipe', definitionId: 'krea-video-kling-kling-3-0',
      params: { duration: 5 }, state: 'idle' as const, outputs: {},
    } };
    useGraphStore.setState({ nodes: [saved], runHistory: [] });
    await act(async () => { render(<Settings />); });
    const select = await screen.findByRole('combobox', { name: 'Default Krea connection for new nodes' });
    const savedDefault = useUIStore.getState().settingsCache.kreaConnectionMode;
    fireEvent.change(select, { target: { value: 'mcp' } });
    expect(useUIStore.getState().settingsCache.kreaConnectionMode).toBe(savedDefault);
    expect(updateSettingsMock).not.toHaveBeenCalled();
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {}, kreaConnectionMode: 'mcp' });
    clickSave();
    await waitFor(() => expect(useUIStore.getState().settingsCache.kreaConnectionMode).toBe('mcp'));
    expect(updateSettingsMock.mock.calls[0][0]).toMatchObject({ kreaConnectionMode: 'mcp' });
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({ duration: 5 });
    expect(useGraphStore.getState().runHistory).toEqual([]);
  });

  it('automatically uses the desktop external-browser bridge and keeps the manual fallback', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true });
    setupDesktopBridge({ kreaOpen: open });
    render(<Settings />);
    await screen.findByText('Not connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' }));
    const link = await screen.findByRole('link', { name: 'Open Krea sign-in' });
    expect(open).toHaveBeenCalledOnce();
    expect(window.open).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith('https://www.krea.ai/auth/v1/oauth/authorize?state=test');
  });

  it('reserves a browser tab in the click before waiting for Krea registration', async () => {
    let finishConnect!: (state: { status: 'connecting'; authorizationUrl: string }) => void;
    connectKreaMock.mockImplementationOnce(() => new Promise((resolve) => { finishConnect = resolve; }));
    const signInWindow = { opener: window, closed: false, document: { title: '', body: { textContent: '' } },
      location: { replace: vi.fn() }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(signInWindow as unknown as Window);
    render(<Settings />);
    await screen.findByText('Not connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' }));
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(signInWindow.opener).toBeNull();
    expect(signInWindow.location.replace).not.toHaveBeenCalled();
    const url = 'https://www.krea.ai/auth/v1/oauth/authorize?state=test';
    await act(async () => { finishConnect({ status: 'connecting', authorizationUrl: url }); });
    expect(signInWindow.location.replace).toHaveBeenCalledExactlyOnceWith(url);
    expect(screen.getByRole('link', { name: 'Open Krea sign-in' })).toHaveAttribute('href', url);
    expect(signInWindow.close).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'closed'])('keeps an actionable link when the browser tab is %s', async (reason) => {
    const replace = vi.fn();
    if (reason === 'closed') vi.mocked(window.open).mockReturnValue({ opener: null, closed: true,
      document: { body: {} }, location: { replace }, close: vi.fn() } as unknown as Window);
    render(<Settings />);
    await screen.findByText('Not connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Click Open Krea sign-in below');
    expect(screen.getByRole('link', { name: 'Open Krea sign-in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart sign-in' })).toBeEnabled();
    expect(window.open).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    await screen.findByText('Connected');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(window.open).toHaveBeenCalledOnce();
  });

  it('opens sign-in even when the browser prevents decorating the blank tab', async () => {
    const signInWindow = { opener: window, closed: false,
      get document() { throw new Error('fixture document unavailable'); },
      location: { replace: vi.fn() }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(signInWindow as unknown as Window);
    render(<Settings />);
    await screen.findByText('Not connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' }));
    await screen.findByRole('link', { name: 'Open Krea sign-in' });
    expect(signInWindow.opener).toBeNull();
    expect(signInWindow.location.replace).toHaveBeenCalledExactlyOnceWith('https://www.krea.ai/auth/v1/oauth/authorize?state=test');
    expect(signInWindow.close).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['untrusted URL', 'registration failure'])('closes the blank tab after %s', async (reason) => {
    const signInWindow = { opener: null, closed: false, document: { body: {} },
      location: { replace: vi.fn() }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(signInWindow as unknown as Window);
    if (reason === 'untrusted URL') connectKreaMock.mockResolvedValueOnce({ status: 'connecting',
      authorizationUrl: 'https://untrusted.test/?token=fixture' });
    else connectKreaMock.mockRejectedValueOnce(new Error('Could not update the Krea connection.'));
    render(<Settings />);
    await screen.findByText('Not connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' }));
    await screen.findByRole('alert');
    expect(signInWindow.close).toHaveBeenCalledOnce();
    expect(signInWindow.location.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Open Krea sign-in' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('token=fixture');
  });

  it('keeps the manual fallback when the desktop browser launch fails', async () => {
    const open = vi.fn().mockRejectedValue(new Error('fixture launch failure'));
    setupDesktopBridge({ kreaOpen: open });
    render(<Settings />);
    await screen.findByText('Not connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Krea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Click Open Krea sign-in below');
    expect(screen.getByRole('link', { name: 'Open Krea sign-in' })).toBeInTheDocument();
    expect(open).toHaveBeenCalledOnce();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('does not open a browser when Settings loads or polls an already pending sign-in', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true });
    setupDesktopBridge({ kreaOpen: open });
    getKreaConnectionMock.mockResolvedValue({ status: 'connecting',
      authorizationUrl: 'https://www.krea.ai/auth/v1/oauth/authorize?state=test' });
    vi.useFakeTimers();
    await act(async () => { render(<Settings />); });
    expect(screen.getByText('Waiting for Krea sign-in…')).toBeInTheDocument();
    const checksBeforePoll = getKreaConnectionMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getKreaConnectionMock).toHaveBeenCalledTimes(checksBeforePoll + 1);
    expect(connectKreaMock).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('never renders an untrusted authorization URL as a link', async () => {
    getKreaConnectionMock.mockResolvedValue({ status: 'needs_auth',
      authorizationUrl: 'https://untrusted.test/?token=fixture', error: 'Sign in again.' });
    render(<Settings />);
    await screen.findByText('Sign-in needed');
    expect(screen.queryByRole('link', { name: 'Open Krea sign-in' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in again.');
    expect(document.body).not.toHaveTextContent('token=fixture');
  });
});

// ---------------------------------------------------------------------------
// Tests: Desktop mode — Keychain badge (VAL-UX-003)
// ---------------------------------------------------------------------------

describe('Settings — desktop mode Keychain badge (VAL-UX-003)', () => {
  it('shows "Managed by macOS Keychain" badge when nebulaDesktop.credentials is present', async () => {
    setupDesktopBridge();
    getSettingsMock.mockResolvedValue({
      apiKeys: { OPENAI_API_KEY: '***test' },
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Managed by macOS Keychain')).toBeInTheDocument();
    });
  });

  it('badge is not shown when bridge is absent (browser mode)', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {} });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('API Keys')).toBeInTheDocument();
    });

    expect(screen.queryByText('Managed by macOS Keychain')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: Desktop mode — credential IPC routing (VAL-UX-003)
// ---------------------------------------------------------------------------

describe('Settings — desktop mode credential IPC routing (VAL-UX-003)', () => {
  it('routes new key through credentials.set() and updateCredential() instead of PUT apiKeys', async () => {
    const { credentials } = setupDesktopBridge();
    getSettingsMock.mockResolvedValue({
      apiKeys: {},
      routing: {},
      outputPath: '/custom',
    });

    render(<Settings />);
    await expandApiKeys();

    // Type a new key into the OpenAI field
    const openaiInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(openaiInput, { target: { value: 'test-new-openai-key' } });

    clickSave();

    await waitFor(() => {
      expect(credentials.set).toHaveBeenCalledWith('OPENAI_API_KEY', 'test-new-openai-key');
    });
    expect(updateCredentialMock).toHaveBeenCalledWith('OPENAI_API_KEY', 'test-new-openai-key');

    // Non-secret settings still go through PUT /api/settings (without apiKeys)
    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    });
    const settingsCall = updateSettingsMock.mock.calls[0][0];
    expect(settingsCall.apiKeys).toBeUndefined();
    expect(settingsCall.outputPath).toBe('/custom');
  });

  it('routes key clear through credentials.clear() and updateCredential() with empty string', async () => {
    const { credentials } = setupDesktopBridge();
    // Load settings with a masked key (was configured)
    getSettingsMock.mockResolvedValue({
      apiKeys: { OPENAI_API_KEY: '***test' },
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await expandApiKeys();

    // Clear the OpenAI field
    const openaiInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(openaiInput, { target: { value: '' } });

    clickSave();

    await waitFor(() => {
      expect(credentials.clear).toHaveBeenCalledWith('OPENAI_API_KEY');
    });
    expect(updateCredentialMock).toHaveBeenCalledWith('OPENAI_API_KEY', '');
  });

  it('skips unchanged masked keys (does not call set or clear)', async () => {
    const { credentials } = setupDesktopBridge();
    getSettingsMock.mockResolvedValue({
      apiKeys: { OPENAI_API_KEY: '***test', FAL_KEY: '***key1' },
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await expandApiKeys();

    // Don't change any fields — just save
    clickSave();

    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    });

    // No credential operations for unchanged masked keys
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.clear).not.toHaveBeenCalled();
    expect(updateCredentialMock).not.toHaveBeenCalled();
  });

  it('still sends non-secret settings through PUT /api/settings in desktop mode', async () => {
    setupDesktopBridge();
    getSettingsMock.mockResolvedValue({
      apiKeys: {},
      routing: { flux: 'fal' },
      outputPath: '/custom-output',
      exportFolder: '/exports',
      zoomTelemetryEnabled: true,
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('Save Settings')).toBeInTheDocument();
    });

    clickSave();

    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    });

    const callArgs = updateSettingsMock.mock.calls[0][0];
    expect(callArgs.routing).toEqual({ flux: 'fal' });
    expect(callArgs.outputPath).toBe('/custom-output');
    expect(callArgs.exportFolder).toBe('/exports');
    expect(callArgs.zoomTelemetryEnabled).toBe(true);
    // apiKeys must NOT be in the PUT payload in desktop mode
    expect(callArgs.apiKeys).toBeUndefined();
  });

  it('handles credential.set failure gracefully', async () => {
    const { credentials } = setupDesktopBridge({
      set: vi.fn().mockResolvedValue({ ok: false, error: 'SAFE_STORAGE_UNAVAILABLE' }),
    });
    getSettingsMock.mockResolvedValue({
      apiKeys: {},
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await expandApiKeys();

    const openaiInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(openaiInput, { target: { value: 'test-new-key-value' } });

    clickSave();

    // Should show error state
    await waitFor(() => {
      expect(screen.getByText(/Error — Retry/)).toBeInTheDocument();
    });
    expect(credentials.set).toHaveBeenCalledWith('OPENAI_API_KEY', 'test-new-key-value');
  });
});

// ---------------------------------------------------------------------------
// Tests: Desktop mode — plaintext key warning (VAL-UX-005)
// ---------------------------------------------------------------------------

describe('Settings — plaintext key warning (VAL-UX-005)', () => {
  it('shows warning banner when plaintextKeyWarning is non-empty', async () => {
    setupDesktopBridge({ plaintextKeyWarning: ['OPENAI_API_KEY', 'FAL_KEY'] });
    getSettingsMock.mockResolvedValue({
      apiKeys: {},
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/Plaintext credentials detected/i)).toBeInTheDocument();
    });

    // Should mention the affected providers
    expect(screen.getByText(/OPENAI_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/FAL_KEY/)).toBeInTheDocument();
  });

  it('does not show warning when plaintextKeyWarning is empty', async () => {
    setupDesktopBridge({ plaintextKeyWarning: [] });
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {} });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('API Keys')).toBeInTheDocument();
    });

    expect(screen.queryByText(/Plaintext credentials detected/i)).not.toBeInTheDocument();
  });

  it('does not show warning in browser mode', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {} });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText('API Keys')).toBeInTheDocument();
    });

    expect(screen.queryByText(/Plaintext credentials detected/i)).not.toBeInTheDocument();
  });

  it('warning has role="alert" for accessibility', async () => {
    setupDesktopBridge({ plaintextKeyWarning: ['OPENAI_API_KEY'] });
    getSettingsMock.mockResolvedValue({ apiKeys: {}, routing: {} });

    render(<Settings />);
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/Plaintext credentials detected/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Desktop mode — multiple key updates in one save
// ---------------------------------------------------------------------------

describe('Settings — desktop mode batch key updates', () => {
  it('processes multiple key changes in a single save', async () => {
    const { credentials } = setupDesktopBridge();
    getSettingsMock.mockResolvedValue({
      apiKeys: { OPENAI_API_KEY: '***old1', ANTHROPIC_API_KEY: '***old2' },
      routing: {},
      outputPath: '',
    });

    render(<Settings />);
    await expandApiKeys();

    // Change OpenAI key
    const openaiInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(openaiInput, { target: { value: 'test-new-openai' } });

    // Clear Anthropic key
    const anthropicInput = screen.getByPlaceholderText('sk-ant-...');
    fireEvent.change(anthropicInput, { target: { value: '' } });

    clickSave();

    await waitFor(() => {
      expect(credentials.set).toHaveBeenCalledWith('OPENAI_API_KEY', 'test-new-openai');
    });
    expect(credentials.clear).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    expect(updateCredentialMock).toHaveBeenCalledWith('OPENAI_API_KEY', 'test-new-openai');
    expect(updateCredentialMock).toHaveBeenCalledWith('ANTHROPIC_API_KEY', '');
  });
});

// Deferred requests exercise ownership and recovery without a real credential.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setSettingsVisible(visible: boolean) {
  act(() => useUIStore.setState((state) => ({
    panels: { ...state.panels, settings: { ...state.panels.settings, visible } },
  })));
}

describe('Settings — load, draft, and provider removal safety', () => {
  it.each([{}, { apiKeys: [] }, { apiKeys: { OPENAI_API_KEY: 12 } }])('rejects malformed settings instead of enabling defaults (%j)', async (response) => {
    getSettingsMock.mockResolvedValue(response);
    render(<Settings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not load');
    expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('keeps a failed GET actionable and cannot save initial defaults; Retry loads the real form', async () => {
    getSettingsMock.mockRejectedValueOnce(new Error('fixture settings unavailable'));
    render(<Settings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not load');
    expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Output Path')).not.toBeInTheDocument();
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByRole('alert')).toHaveTextContent('Settings could not load');
    vi.useRealTimers();
    getSettingsMock.mockResolvedValueOnce({ apiKeys: {}, outputPath: '/saved-path' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading settings' }));
    expect(await screen.findByLabelText('Output Path')).toHaveValue('/saved-path');
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('offers neither editable fields nor Save before an initial pending GET resolves', async () => {
    const load = deferred<Record<string, unknown>>();
    getSettingsMock.mockReturnValueOnce(load.promise);
    render(<Settings />);
    expect(await screen.findByText('Loading settings…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Output Path')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument();
    await act(async () => load.resolve({ apiKeys: {}, outputPath: '/loaded' }));
    expect(screen.getByLabelText('Output Path')).toHaveValue('/loaded');
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('ignores an old load after closing and reopening, including after the newer form is edited', async () => {
    const oldLoad = deferred<Record<string, unknown>>();
    const newLoad = deferred<Record<string, unknown>>();
    getSettingsMock.mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise);
    render(<Settings />);
    await screen.findByText('Loading settings…');
    setSettingsVisible(false);
    setSettingsVisible(true);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(2));
    await act(async () => newLoad.resolve({ apiKeys: {}, outputPath: '/newer' }));
    fireEvent.change(screen.getByLabelText('Output Path'), { target: { value: '/newer-edit' } });
    await act(async () => oldLoad.resolve({ apiKeys: {}, outputPath: '/old' }));
    expect(screen.getByLabelText('Output Path')).toHaveValue('/newer-edit');
    expect(screen.getByText(/Unsaved changes stay here/)).toBeInTheDocument();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('retains unsaved fields and credentials through dismiss and unmount without browser persistence', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: {}, outputPath: '/original', exportFolder: '/original-exports' });
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    const rendered = render(<Settings />);
    await expandApiKeys();
    localWrite.mockClear();
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'fixture-private-draft' } });
    fireEvent.change(screen.getByLabelText('Output Path'), { target: { value: '/draft-output' } });
    fireEvent.change(screen.getByLabelText('Default Save Folder'), { target: { value: '/draft-exports' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Default Krea connection for new nodes' }), { target: { value: 'mcp' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Demo zoom telemetry/ }));
    expect(localWrite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings panel' }));
    rendered.unmount();
    setSettingsVisible(true);
    render(<Settings />);
    await expandApiKeys();
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('fixture-private-draft');
    expect(screen.getByLabelText('Output Path')).toHaveValue('/draft-output');
    expect(screen.getByLabelText('Default Save Folder')).toHaveValue('/draft-exports');
    expect(screen.getByRole('combobox', { name: 'Default Krea connection for new nodes' })).toHaveValue('mcp');
    expect(screen.getByRole('checkbox', { name: /Demo zoom telemetry/ })).toBeChecked();
    expect(getSettingsMock).toHaveBeenCalledOnce();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    expect(screen.getByLabelText('Output Path')).toHaveValue('/original');
    expect(screen.queryByText(/Unsaved changes stay here/)).not.toBeInTheDocument();
  });

  it('keeps a failed save and intended edits available, and only explicitly retries the write', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: {}, outputPath: '/original' });
    updateSettingsMock.mockRejectedValueOnce(new Error('fixture write failure'));
    render(<Settings />);
    await screen.findByLabelText('Output Path');
    fireEvent.change(screen.getByLabelText('Output Path'), { target: { value: '/intended' } });
    clickSave();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your edits are still here');
    expect(screen.getByLabelText('Output Path')).toHaveValue('/intended');
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByRole('alert')).toHaveTextContent('could not be saved');
    vi.useRealTimers();
    expect(updateSettingsMock).toHaveBeenCalledOnce();
    getSettingsMock.mockResolvedValueOnce({ apiKeys: {}, outputPath: '/intended' });
    fireEvent.click(screen.getByRole('button', { name: 'Error — Retry' }));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
    expect(updateSettingsMock).toHaveBeenCalledTimes(2);
    expect(updateSettingsMock.mock.calls[1][0].outputPath).toBe('/intended');
  });

  it('blocks edits and a second save while a write is pending, including after unmount and reopen', async () => {
    const write = deferred<{ status: string }>();
    getSettingsMock.mockResolvedValueOnce({ apiKeys: {}, outputPath: '/original' })
      .mockResolvedValueOnce({ apiKeys: {}, outputPath: '/saved-draft' });
    updateSettingsMock.mockReturnValueOnce(write.promise);
    const rendered = render(<Settings />);
    await screen.findByLabelText('Output Path');
    fireEvent.change(screen.getByLabelText('Output Path'), { target: { value: '/saved-draft' } });
    const save = screen.getByRole('button', { name: 'Save Settings' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(screen.getByLabelText('Output Path')).toBeDisabled();
    rendered.unmount();
    render(<Settings />);
    expect(await screen.findByLabelText('Output Path')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(updateSettingsMock).toHaveBeenCalledOnce();
    await act(async () => write.resolve({ status: 'saved' }));
    expect(screen.getByLabelText('Output Path')).toHaveValue('/saved-draft');
    expect(screen.getByLabelText('Output Path')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument();
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes after a successful save without repeating the write when refresh fails', async () => {
    getSettingsMock.mockResolvedValueOnce({ apiKeys: {}, outputPath: '/original' })
      .mockRejectedValueOnce(new Error('fixture refresh failure'));
    render(<Settings />);
    await screen.findByLabelText('Output Path');
    fireEvent.change(screen.getByLabelText('Output Path'), { target: { value: '/saved' } });
    clickSave();
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings were saved');
    expect(screen.getByLabelText('Output Path')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument();
    getSettingsMock.mockResolvedValueOnce({ apiKeys: {}, outputPath: '/saved' });
    expect(screen.queryByText(/Unsaved changes stay here/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
    expect(updateSettingsMock).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Output Path')).toHaveValue('/saved');
  });

  it('treats whitespace-only browser key edits as blank without removing the configured key', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: { OPENAI_API_KEY: '***configured' } });
    render(<Settings />); await expandApiKeys();
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: '   ' } });
    clickSave(); await waitFor(() => expect(updateSettingsMock).toHaveBeenCalled());
    expect(updateSettingsMock.mock.calls[0][0].apiKeys.OPENAI_API_KEY).toBe('');
    expect(deleteSettingsApiKeyMock).not.toHaveBeenCalled();
  });
  it('explains that blanking a configured browser key keeps it, and removal is explicit', async () => {
    getSettingsMock.mockResolvedValue({ apiKeys: { OPENAI_API_KEY: '***configured' } });
    render(<Settings />);
    await expandApiKeys();
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: '' } });
    expect(screen.getByText('This key is still configured. Use Remove to disconnect it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove OpenAI API key' })).toBeInTheDocument();
    expect(deleteSettingsApiKeyMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('removes one provider, refreshes readiness and retains unrelated drafts through reopening', async () => {
    getSettingsMock.mockResolvedValueOnce({ apiKeys: { OPENAI_API_KEY: '***openai', ANTHROPIC_API_KEY: '***anthropic' }, outputPath: '/original' })
      .mockResolvedValueOnce({ apiKeys: { ANTHROPIC_API_KEY: '***anthropic' }, outputPath: '/original' });
    useUIStore.getState().setSettingsCache({ OPENAI_API_KEY: '***openai', ANTHROPIC_API_KEY: '***anthropic' });
    const rendered = render(<Settings />);
    await expandApiKeys();
    fireEvent.change(screen.getByLabelText('Output Path'), { target: { value: '/unsaved-output' } });
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: 'fixture-anthropic-edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI API key' }));
    expect(await screen.findByText('OpenAI key removed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Output Path')).toBeEnabled());
    expect(deleteSettingsApiKeyMock).toHaveBeenCalledExactlyOnceWith('OPENAI_API_KEY');
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove OpenAI API key' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Anthropic API key')).toHaveValue('fixture-anthropic-edit');
    expect(screen.getByLabelText('Output Path')).toHaveValue('/unsaved-output');
    expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ ANTHROPIC_API_KEY: '***anthropic' });
    rendered.unmount();
    render(<Settings />);
    await expandApiKeys();
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    expect(screen.getByLabelText('Output Path')).toHaveValue('/unsaved-output');
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('keeps a successfully deleted key absent when GET fails, then retries only refresh', async () => {
    getSettingsMock.mockResolvedValueOnce({ apiKeys: { OPENAI_API_KEY: '***openai', FAL_KEY: '***fal' } })
      .mockRejectedValueOnce(new Error('fixture refresh failure'));
    useUIStore.getState().setSettingsCache({ OPENAI_API_KEY: '***openai', FAL_KEY: '***fal' });
    render(<Settings />);
    await expandApiKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI API key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The key was removed');
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ FAL_KEY: '***fal' });
    expect(screen.queryByRole('button', { name: 'Save Settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Output Path')).toBeDisabled();
    getSettingsMock.mockResolvedValueOnce({ apiKeys: { FAL_KEY: '***fal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(deleteSettingsApiKeyMock).toHaveBeenCalledOnce();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    expect(screen.getByLabelText('fal.ai API key')).toHaveValue('***fal');
  });

  it('keeps removal errors visible and retries only the selected provider', async () => {
    getSettingsMock.mockResolvedValueOnce({ apiKeys: { OPENAI_API_KEY: '***openai', FAL_KEY: '***fal' } })
      .mockResolvedValueOnce({ apiKeys: { FAL_KEY: '***fal' } });
    deleteSettingsApiKeyMock.mockRejectedValueOnce(new Error('fixture deletion failure'));
    render(<Settings />);
    await expandApiKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI API key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry Remove');
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('***openai');
    expect(screen.getByLabelText('fal.ai API key')).toHaveValue('***fal');
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI API key' }));
    await screen.findByText('OpenAI key removed.');
    expect(deleteSettingsApiKeyMock.mock.calls).toEqual([['OPENAI_API_KEY'], ['OPENAI_API_KEY']]);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});
