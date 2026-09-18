import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing components
// ---------------------------------------------------------------------------

const getSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const updateCredentialMock = vi.fn();

vi.mock('../src/lib/api', () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
  updateSettings: (...args: unknown[]) => updateSettingsMock(...args),
  updateCredential: (...args: unknown[]) => updateCredentialMock(...args),
}));

vi.mock('../src/components/SkinPicker', () => ({
  SkinPicker: () => null,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { Settings } from '../src/components/panels/Settings';
import { useUIStore } from '../src/store/uiStore';

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

  // Clean window.nebulaDesktop between tests
  delete (window as Record<string, unknown>).nebulaDesktop;
});

afterEach(() => {
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
