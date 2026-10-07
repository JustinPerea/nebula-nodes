import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing components
// ---------------------------------------------------------------------------

const getSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const updateCredentialMock = vi.fn();
const getKreaConnectionMock = vi.fn();
const connectKreaMock = vi.fn();
const checkKreaConnectionMock = vi.fn();
const disconnectKreaMock = vi.fn();

vi.mock('../src/lib/api', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  updateSettings: (...args: unknown[]) => updateSettingsMock(...args),
  updateCredential: (...args: unknown[]) => updateCredentialMock(...args),
}));

vi.mock('../src/lib/kreaConnection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: (...args: unknown[]) => getKreaConnectionMock(...args),
  connectKrea: (...args: unknown[]) => connectKreaMock(...args),
  checkKreaConnection: (...args: unknown[]) => checkKreaConnectionMock(...args),
  disconnectKrea: (...args: unknown[]) => disconnectKreaMock(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { Settings } from '../src/components/panels/Settings';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const INITIAL_UI_STATE = { ...useUIStore.getState() };

beforeEach(() => {
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
  updateSettingsMock.mockResolvedValue({ status: 'ok' });
  updateCredentialMock.mockResolvedValue({ status: 'updated' });
  getKreaConnectionMock.mockReset().mockResolvedValue({ status: 'disconnected' });
  connectKreaMock.mockReset().mockResolvedValue({ status: 'connecting',
    authorizationUrl: 'https://www.krea.ai/auth/v1/oauth/authorize?state=test' });
  checkKreaConnectionMock.mockReset().mockResolvedValue({ status: 'connected', tools: ['list_models'] });
  disconnectKreaMock.mockReset().mockResolvedValue({ status: 'disconnected' });
  vi.spyOn(window, 'open').mockReturnValue(null);

  // Clean window.nebulaDesktop between tests
  delete (window as Record<string, unknown>).nebulaDesktop;
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as Record<string, unknown>).nebulaDesktop;
  vi.restoreAllMocks();
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

  it('saves the future-node default explicitly and does not rewrite existing nodes', async () => {
    const saved = { id: 'old', type: 'model-node', position: { x: 0, y: 0 }, data: {
      label: 'Old recipe', definitionId: 'krea-video-kling-kling-3-0',
      params: { duration: 5 }, state: 'idle' as const, outputs: {},
    } };
    useGraphStore.setState({ nodes: [saved], runHistory: [] });
    await act(async () => { render(<Settings />); });
    const select = await screen.findByRole('combobox', { name: 'Default Krea connection for new nodes' });
    fireEvent.change(select, { target: { value: 'mcp' } });
    expect(useUIStore.getState().settingsCache.kreaConnectionMode).toBeUndefined();
    expect(updateSettingsMock).not.toHaveBeenCalled();
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
