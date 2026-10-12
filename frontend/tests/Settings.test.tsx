import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within, cleanup } from '@testing-library/react';

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
import { resetSettingsWrites } from '../src/lib/settingsWrites';
import { resetRunCostConfirmMigration } from '../src/lib/runCostConfirm';
import { readServiceAccount } from '../src/components/panels/settings/rowHelpers';

// ---------------------------------------------------------------------------
// Setup and helpers
// ---------------------------------------------------------------------------

const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_DRAFT_STATE = { ...useSettingsDraftStore.getState() };
const KREA_URL = 'https://www.krea.ai/auth/v1/oauth/authorize?state=test';

beforeEach(() => {
  useProviderReadinessStore.getState().invalidate();
  resetSettingsWrites();
  resetRunCostConfirmMigration();
  providerApiFetchMock.mockReset();
  useSettingsDraftStore.setState(INITIAL_DRAFT_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
  useUIStore.setState((state) => ({
    panels: { ...state.panels, settings: { ...state.panels.settings, visible: true } },
  }));
  getSettingsMock.mockReset();
  updateSettingsMock.mockReset().mockResolvedValue({ status: 'ok' });
  updateCredentialMock.mockReset().mockResolvedValue({ status: 'updated' });
  deleteSettingsApiKeyMock.mockReset().mockResolvedValue({ status: 'removed' });
  getKreaConnectionMock.mockReset().mockResolvedValue({ status: 'disconnected' });
  connectKreaMock.mockReset().mockResolvedValue({ status: 'connecting', authorizationUrl: KREA_URL });
  checkKreaConnectionMock.mockReset().mockResolvedValue({ status: 'connected', tools: ['list_models'] });
  disconnectKreaMock.mockReset().mockResolvedValue({ status: 'disconnected' });
  getKreaPlansMock.mockReset();
  startKreaTrialMock.mockReset();
  vi.spyOn(window, 'open').mockReturnValue(null);
  delete (window as Record<string, unknown>).nebulaDesktop;
});

afterEach(() => {
  useProviderReadinessStore.getState().invalidate();
  vi.useRealTimers();
  delete (window as Record<string, unknown>).nebulaDesktop;
  vi.restoreAllMocks();
});

function setupDesktopBridge(overrides?: {
  set?: (provider: string, key: string) => Promise<unknown>;
  clear?: (provider: string) => Promise<unknown>;
  plaintextKeyWarning?: string[];
  kreaOpen?: (url: string) => Promise<unknown>;
  choose?: (defaultPath?: string) => Promise<unknown>;
}) {
  const credentials = Object.freeze({
    set: overrides?.set ?? vi.fn().mockResolvedValue({ ok: true }),
    has: vi.fn().mockResolvedValue({ ok: true, has: false }),
    clear: overrides?.clear ?? vi.fn().mockResolvedValue({ ok: true }),
  });
  const folders = Object.freeze({ choose: overrides?.choose ?? vi.fn().mockResolvedValue({ ok: true, path: null }) });
  (window as Record<string, unknown>).nebulaDesktop = Object.freeze({
    platform: 'darwin',
    shell: 'electron',
    apiBaseUrl: 'http://127.0.0.1:9999',
    wsBaseUrl: 'ws://127.0.0.1:9999',
    credentials,
    folders,
    migration: Object.freeze({ status: vi.fn(), retry: vi.fn() }),
    ...(overrides?.kreaOpen ? { kreaLinks: Object.freeze({ open: overrides.kreaOpen }) } : {}),
    plaintextKeyWarning: Object.freeze(overrides?.plaintextKeyWarning ?? []),
  });
  return { credentials, folders };
}

/** Render with these saved settings and wait for the Providers tab. The run
 * cost threshold is saved unless a test says otherwise (an older settings file
 * without it makes the panel copy this browser's value over once). */
async function renderSettings(settings: Record<string, unknown> = { apiKeys: {} }) {
  getSettingsMock.mockResolvedValue({ runCostConfirmUsd: 1, ...settings });
  const rendered = render(<Settings />);
  await screen.findByRole('searchbox', { name: 'Search providers and models' });
  return rendered;
}

function healthResponse(providers: Record<string, string>) {
  const now = new Date().toISOString();
  return new Response(JSON.stringify({ providers: Object.fromEntries(Object.entries(providers)
    .map(([name, status]) => [name, { configured: status !== 'not_configured', status, last_checked: now }])) }));
}

function list(name: RegExp) {
  return screen.getByRole('region', { name });
}

function rowNames(region: HTMLElement) {
  return [...region.querySelectorAll('.settings-row__name')].map((node) => node.textContent);
}

function row(label: string) {
  const name = [...document.querySelectorAll('.settings-row__name')].find((node) => node.textContent === label);
  if (!name) throw new Error(`No row ${label}`);
  return name.closest('.settings-row') as HTMLElement;
}

function openTab(name: 'Providers' | 'Preferences' | 'Storage') {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));
}

async function addKey(label: string, value: string) {
  fireEvent.click(screen.getByRole('button', { name: `Add ${label} key` }));
  const input = await screen.findByLabelText(`${label} API key`);
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(input.closest('form')!);
}

function removeKey(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Manage ${label}` }));
  fireEvent.click(screen.getByRole('button', { name: `Remove ${label} API key` }));
  fireEvent.click(screen.getByRole('button', { name: `Confirm removing the ${label} API key` }));
}

// ---------------------------------------------------------------------------
// Shell: loading, tabs, closing
// ---------------------------------------------------------------------------

describe('Settings shell', () => {
  it('opens on Providers with the tab focused, three tabs and no panel-wide Save', async () => {
    await renderSettings();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Providers', 'Preferences', 'Storage']);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Providers/ })).toHaveFocus());
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'settings-tab-providers');
    expect(screen.queryByRole('button', { name: /Save Settings/ })).not.toBeInTheDocument();
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it('moves between tabs with the arrow, Home and End keys', async () => {
    await renderSettings();
    const providers = screen.getByRole('tab', { name: /Providers/ });
    fireEvent.keyDown(providers, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Preferences' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Preferences' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Preferences' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Storage' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Storage' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Providers/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Providers/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Storage' })).toHaveAttribute('tabindex', '-1');
  });

  it('counts connected providers on the Providers tab', async () => {
    getKreaConnectionMock.mockResolvedValue({ status: 'connected' });
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa', FAL_KEY: '***bbbb', GOOGLE_API_KEY: '' } });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Providers/ })).toHaveTextContent('Providers3'));
  });

  it('keeps a failed first load actionable, and Try again loads the panel', async () => {
    getSettingsMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ runCostConfirmUsd: 1, apiKeys: {} });
    render(<Settings />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Settings couldn't load");
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('searchbox', { name: 'Search providers and models' });
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('shows nothing editable until the first load finishes', async () => {
    getSettingsMock.mockReturnValue(new Promise(() => {}));
    render(<Settings />);
    expect(screen.getByText('Loading settings…')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: /Add .* key/ })).not.toBeInTheDocument();
  });

  it('retries an initial read if a newer credential cache refresh overtakes it', async () => {
    let finishLoad!: (value: Record<string, unknown>) => void;
    getSettingsMock.mockReturnValueOnce(new Promise<Record<string, unknown>>((resolve) => { finishLoad = resolve; }))
      .mockResolvedValueOnce({ runCostConfirmUsd: 1, apiKeys: { FAL_KEY: '***current' }, kreaConnectionMode: 'mcp' });
    render(<Settings />);
    act(() => useUIStore.getState().setSettingsCache({ FAL_KEY: '***current' }, 'mcp'));
    await act(async () => finishLoad({ runCostConfirmUsd: 1, apiKeys: { OPENAI_API_KEY: '***outdated' } }));
    await screen.findByRole('searchbox');
    expect(rowNames(list(/^Connected/))).toContain('fal.ai');
    expect(rowNames(list(/^Connected/))).not.toContain('OpenAI');
    expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ FAL_KEY: '***current' });
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it('closes on Escape from a tab and restores the opener', async () => {
    getSettingsMock.mockResolvedValue({ runCostConfirmUsd: 1, apiKeys: {} });
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    useUIStore.getState().setLeftDock('settings');
    const rendered = render(<Settings />);
    try {
      const tab = await screen.findByRole('tab', { name: /Providers/ });
      await waitFor(() => expect(tab).toHaveFocus());
      fireEvent.keyDown(tab, { key: 'Escape' });
      expect(useUIStore.getState().panels.settings.visible).toBe(false);
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      rendered.unmount();
      opener.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

describe('Settings — providers list and search', () => {
  it('lists connected providers first and sorts the rest by how many nodes they unlock', async () => {
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    expect(rowNames(list(/^Connected/))).toEqual(['OpenAI']);
    const toAdd = rowNames(list(/^Add a provider/));
    expect(toAdd).not.toContain('OpenAI');
    expect(toAdd.indexOf('Krea · API token')).toBeLessThan(toAdd.indexOf('fal.ai'));
    expect(toAdd.indexOf('fal.ai')).toBeLessThan(toAdd.indexOf('Ideogram'));
    expect(toAdd.indexOf('Ideogram')).toBeLessThan(toAdd.indexOf('Anthropic'));
    expect(within(row('fal.ai')).getByText(/^\d+ nodes: Kling V3, FLUX 2 Pro/)).toBeInTheDocument();
    expect(within(row('Ideogram')).getByText(/Ideogram 4/)).toBeInTheDocument();
  });

  it('says "Connect a provider" when nothing is connected yet', async () => {
    await renderSettings();
    expect(screen.queryByRole('region', { name: /^Connected/ })).not.toBeInTheDocument();
    expect(list(/^Connect a provider/)).toBeInTheDocument();
  });

  it('finds every provider that runs a model by name, and Escape clears the search, not the panel', async () => {
    await renderSettings({ apiKeys: { GOOGLE_API_KEY: '***gggg' } });
    const search = screen.getByRole('searchbox', { name: 'Search providers and models' });
    fireEvent.change(search, { target: { value: 'Veo' } });
    const names = [...rowNames(list(/^Connected/)), ...rowNames(list(/^Add a provider/))];
    expect(names).toEqual(expect.arrayContaining(['Google · Gemini API', 'Google · Vertex AI', 'fal.ai']));
    expect(names).not.toContain('Anthropic');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(useUIStore.getState().panels.settings.visible).toBe(true);
    fireEvent.change(search, { target: { value: 'zzzz-no-such-model' } });
    expect(screen.getByText('No provider runs “zzzz-no-such-model”.')).toBeInTheDocument();
  });
});

describe('Settings — adding, replacing and removing keys (browser)', () => {
  it('saves one key on its own, moves it to Connected, focuses it and checks it once', async () => {
    providerApiFetchMock.mockResolvedValue(healthResponse({ Ideogram: 'invalid' }));
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    expect(providerApiFetchMock).not.toHaveBeenCalled();
    await addKey('Ideogram', '  fixture-ideogram  ');
    await waitFor(() => expect(rowNames(list(/^Connected/))).toContain('Ideogram'));
    expect(updateSettingsMock.mock.calls).toEqual([[{ apiKeys: { IDEOGRAM_API_KEY: 'fixture-ideogram' } }]]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage Ideogram' })).toHaveFocus());
    await waitFor(() => expect(within(row('Ideogram')).getByText('Key rejected')).toBeInTheDocument());
    expect(providerApiFetchMock.mock.calls).toEqual([['/api/health/providers?refresh=true']]);
    expect(screen.getByText('Ideogram key saved. Checking it now.')).toBeInTheDocument();
    expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ OPENAI_API_KEY: '***aaaa', IDEOGRAM_API_KEY: '***gram' });
  });

  it('keeps the check when the app reads back the same keys after a save', async () => {
    providerApiFetchMock.mockResolvedValue(healthResponse({ Ideogram: 'valid' }));
    await renderSettings({ apiKeys: {} });
    await addKey('Ideogram', 'fixture-ideogram');
    await waitFor(() => expect(within(row('Ideogram')).getByText('Connected')).toBeInTheDocument());
    act(() => useUIStore.getState().setSettingsCache({ ...useUIStore.getState().settingsCache.apiKeys }));
    expect(within(row('Ideogram')).getByText('Connected')).toBeInTheDocument();
    act(() => useUIStore.getState().setSettingsCache({ IDEOGRAM_API_KEY: '***diff' }));
    expect(within(row('Ideogram')).queryByText('Connected')).not.toBeInTheDocument();
  });

  it.each([
    ['valid', 'Connected'], ['invalid', 'Key rejected'], ['unauthorized', 'No API access'],
    ['insufficient_credits', 'Out of credits'], ['error', "Couldn't check"], ['configured_unverified', 'Saved'],
  ])('shows a %s check as "%s" only after Check connections', async (status, text) => {
    providerApiFetchMock.mockResolvedValue(healthResponse({ OpenAI: status }));
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    expect(within(row('OpenAI')).getByText('Saved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check connections' }));
    expect(await within(row('OpenAI')).findByText(text)).toBeInTheDocument();
    expect(providerApiFetchMock).toHaveBeenCalledOnce();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('keeps the typed key and shows an error when saving fails, without checking', async () => {
    updateSettingsMock.mockRejectedValueOnce(new Error('offline'));
    await renderSettings();
    await addKey('Anthropic', 'fixture-anthropic');
    expect(await screen.findByRole('alert')).toHaveTextContent("The key couldn't be saved. Your text is still here; try again.");
    expect(screen.getByLabelText('Anthropic API key')).toHaveValue('fixture-anthropic');
    expect(rowNames(list(/^Connect a provider/))).toContain('Anthropic');
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it('cancels key entry with Escape, discarding the text, without closing Settings', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Add Anthropic key' }));
    const input = await screen.findByLabelText('Anthropic API key');
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: 'half-typed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Anthropic API key')).not.toBeInTheDocument();
    expect(useUIStore.getState().panels.settings.visible).toBe(true);
    expect(useSettingsDraftStore.getState().keyDrafts).toEqual({});
    expect(screen.getByRole('button', { name: 'Add Anthropic key' })).toHaveFocus();
  });

  it('keeps unsaved key text when Settings closes and reopens, but never in browser storage', async () => {
    const rendered = await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Add Anthropic key' }));
    fireEvent.change(await screen.findByLabelText('Anthropic API key'), { target: { value: 'fixture-secret' } });
    rendered.unmount();
    await renderSettings();
    expect(screen.getByLabelText('Anthropic API key')).toHaveValue('fixture-secret');
    expect(JSON.stringify({ ...localStorage })).not.toContain('fixture-secret');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('fixture-secret');
  });

  it('undoes a newly added key from the notice', async () => {
    providerApiFetchMock.mockResolvedValue(healthResponse({}));
    await renderSettings();
    await addKey('Anthropic', 'fixture-anthropic');
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(deleteSettingsApiKeyMock).toHaveBeenCalledWith('ANTHROPIC_API_KEY'));
    await waitFor(() => expect(rowNames(list(/^Connect a provider/))).toContain('Anthropic'));
    expect(screen.getByText('Anthropic key removed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Anthropic key' })).toHaveFocus());
  });

  it('replaces a saved key without offering Undo (the old key is gone)', async () => {
    providerApiFetchMock.mockResolvedValue(healthResponse({ OpenAI: 'valid' }));
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Manage OpenAI' }));
    expect(screen.getByRole('button', { name: 'Replace key' })).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Key page ↗' })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    const input = await screen.findByLabelText('OpenAI API key');
    fireEvent.change(input, { target: { value: 'fixture-new' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('OpenAI key saved. Checking it now.');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(updateSettingsMock.mock.calls).toEqual([[{ apiKeys: { OPENAI_API_KEY: 'fixture-new' } }]]);
  });

  it('asks before removing: Keep and Escape back out without deleting or closing', async () => {
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Manage OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI API key' }));
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI API key' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Keep' })).not.toBeInTheDocument();
    // The row is still open: the first Escape backs out of the confirmation only.
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    expect(useUIStore.getState().panels.settings.visible).toBe(true);
    expect(deleteSettingsApiKeyMock).not.toHaveBeenCalled();
  });

  it('removes a key on the second press and moves the row back to the add list', async () => {
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa', FAL_KEY: '***ffff' } });
    removeKey('OpenAI');
    await waitFor(() => expect(rowNames(list(/^Add a provider/))).toContain('OpenAI'));
    expect(deleteSettingsApiKeyMock.mock.calls).toEqual([['OPENAI_API_KEY']]);
    expect(useUIStore.getState().settingsCache.apiKeys).toEqual({ FAL_KEY: '***ffff' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add OpenAI key' })).toHaveFocus());
    expect(screen.getByText('OpenAI key removed.')).toBeInTheDocument();
  });

  it('keeps the row and shows an error when removal fails', async () => {
    deleteSettingsApiKeyMock.mockRejectedValueOnce(new Error('offline'));
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    removeKey('OpenAI');
    expect(await screen.findByRole('alert')).toHaveTextContent("The key couldn't be removed. Try again.");
    expect(rowNames(list(/^Connected/))).toContain('OpenAI');
  });

  it('invalidates a running check when a key changes', async () => {
    let finishCheck!: (value: Response) => void;
    providerApiFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finishCheck = resolve; }));
    deleteSettingsApiKeyMock.mockReturnValue(new Promise(() => {}));
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa', FAL_KEY: '***ffff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check connections' }));
    updateSettingsMock.mockResolvedValue({ status: 'ok' });
    await addKey('Anthropic', 'fixture-anthropic');
    providerApiFetchMock.mockReturnValue(new Promise(() => {}));
    await act(async () => finishCheck(healthResponse({ OpenAI: 'valid' })));
    expect(within(row('OpenAI')).queryByText('Connected')).not.toBeInTheDocument();
  });
});

describe('Settings — Vertex service-account key', () => {
  const key = JSON.stringify({ type: 'service_account', project_id: 'demo-project', client_email: 'veo@demo-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n' });

  it('reads the key file and names the account and project, never the private key', () => {
    expect(readServiceAccount(key)).toEqual({ ok: true, email: 'veo@demo-project.iam.gserviceaccount.com', project: 'demo-project' });
    expect(readServiceAccount('{')).toMatchObject({ ok: false });
    expect(readServiceAccount('{"type":"authorized_user"}')).toMatchObject({ ok: false });
    expect(readServiceAccount(JSON.stringify({ ...JSON.parse(key), private_key: undefined }))).toMatchObject({ ok: false });
  });

  it('takes a chosen key file, shows what it found and saves the JSON', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Add Google · Vertex AI key' }));
    const save = await screen.findByRole('button', { name: 'Save key' });
    expect(save).toBeDisabled();
    const file = new File([key], 'demo-key.json', { type: 'application/json' });
    const input = document.querySelector<HTMLInputElement>('.settings-sa input[type="file"]')!;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect(await screen.findByText('✓ demo-key.json')).toBeInTheDocument();
    expect(screen.getByText('veo@demo-project.iam.gserviceaccount.com')).toBeInTheDocument();
    expect(screen.getByText(/Project demo-project/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('BEGIN PRIVATE KEY');
    fireEvent.click(save);
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ apiKeys: { GOOGLE_VERTEX_CREDENTIALS: key } }));
  });

  it('accepts pasted JSON and explains what is wrong with it', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Add Google · Vertex AI key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Paste JSON instead' }));
    const area = screen.getByLabelText('Google · Vertex AI service-account JSON');
    fireEvent.change(area, { target: { value: '{"type":"authorized_user"}' } });
    expect(screen.getByRole('alert')).toHaveTextContent('not a service-account key');
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled();
    fireEvent.change(area, { target: { value: key } });
    expect(screen.getByRole('button', { name: 'Save key' })).toBeEnabled();
  });
});

describe('Settings — setup links from nodes', () => {
  it('opens and focuses the requested key field without writing, checking or touching the graph', async () => {
    getSettingsMock.mockResolvedValue({ runCostConfirmUsd: 1, apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    const graph = useGraphStore.getState();
    useSettingsDraftStore.setState({ tab: 'storage' });
    act(() => useUIStore.getState().openProviderSetup({ kind: 'api-key', key: 'OPENAI_API_KEY' }));
    render(<Settings />);
    await waitFor(() => expect(screen.getByLabelText('OpenAI API key')).toHaveFocus());
    expect(screen.getByRole('tab', { name: /Providers/ })).toHaveAttribute('aria-selected', 'true');
    expect(providerApiFetchMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes).toBe(graph.nodes);
    expect(useGraphStore.getState().runHistory).toBe(graph.runHistory);
  });

  it('clears a search that would hide the requested row', async () => {
    await renderSettings();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Ideogram' } });
    act(() => useUIStore.getState().openProviderSetup({ kind: 'api-key', key: 'FAL_KEY' }));
    await waitFor(() => expect(screen.getByLabelText('fal.ai API key')).toHaveFocus());
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it.each(['krea-mcp', 'nous'] as const)('focuses %s setup without signing in, checking or generating', async (kind) => {
    getSettingsMock.mockResolvedValue({ runCostConfirmUsd: 1, apiKeys: {} });
    act(() => useUIStore.getState().openProviderSetup(kind === 'krea-mcp' ? { kind } : { kind: 'external', provider: 'nous' }));
    render(<Settings />);
    if (kind === 'krea-mcp') {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in to Krea' })).toHaveFocus());
    } else {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus());
      expect(screen.getByText('hermes-daedalus model')).toBeInTheDocument();
    }
    expect(connectKreaMock).not.toHaveBeenCalled();
    expect(checkKreaConnectionMock).not.toHaveBeenCalled();
    expect(providerApiFetchMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});

describe('Settings — desktop app (macOS Keychain)', () => {
  it('saves a key through the Keychain bridge, not PUT apiKeys', async () => {
    const { credentials } = setupDesktopBridge();
    providerApiFetchMock.mockResolvedValue(healthResponse({}));
    await renderSettings({ apiKeys: { FAL_KEY: '***ffff' } });
    expect(screen.getByText('Keys are stored in the macOS Keychain.')).toBeInTheDocument();
    await addKey('OpenAI', 'fixture-openai');
    await waitFor(() => expect(credentials.set).toHaveBeenCalledWith('OPENAI_API_KEY', 'fixture-openai'));
    expect(updateCredentialMock).toHaveBeenCalledWith('OPENAI_API_KEY', 'fixture-openai');
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('removes a key through the Keychain bridge', async () => {
    const { credentials } = setupDesktopBridge();
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    removeKey('OpenAI');
    await waitFor(() => expect(credentials.clear).toHaveBeenCalledWith('OPENAI_API_KEY'));
    expect(updateCredentialMock).toHaveBeenCalledWith('OPENAI_API_KEY', '');
    expect(deleteSettingsApiKeyMock).not.toHaveBeenCalled();
  });

  it('keeps the key text and says so when the Keychain refuses it', async () => {
    setupDesktopBridge({ set: vi.fn().mockResolvedValue({ ok: false, error: 'denied' }) });
    await renderSettings();
    await addKey('OpenAI', 'fixture-openai');
    expect(await screen.findByRole('alert')).toHaveTextContent("The key couldn't be saved");
    expect(updateCredentialMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('fixture-openai');
  });

  it('warns about plaintext keys found in the settings file', async () => {
    setupDesktopBridge({ plaintextKeyWarning: ['OPENAI_API_KEY', 'FAL_KEY'] });
    await renderSettings();
    expect(screen.getByRole('alert')).toHaveTextContent('Keys for OPENAI_API_KEY, FAL_KEY are stored as plain text');
  });

  it('shows neither Keychain note nor warning in the browser', async () => {
    await renderSettings({ apiKeys: { OPENAI_API_KEY: '***aaaa' } });
    expect(screen.queryByText('Keys are stored in the macOS Keychain.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Krea sign-in
// ---------------------------------------------------------------------------

describe('Settings — Krea sign-in', () => {
  it('starts consent, exposes a browser link and leaves recipes and generation untouched', async () => {
    const params = { prompt: 'saved logo', _kreaAuth: 'api-token' };
    const nodes = [{ id: 'saved', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Saved Krea recipe', definitionId: 'krea-image-openai-gpt-image-2', params, state: 'idle' as const, outputs: {} } }];
    useGraphStore.setState({ nodes, edges: [], runHistory: [] });
    const executeNode = vi.spyOn(useGraphStore.getState(), 'executeNode');
    await renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Krea' }));
    const link = await screen.findByRole('link', { name: /Open Krea sign-in/ });
    expect(link).toHaveAttribute('href', KREA_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(row('Krea · sign-in')).getByText('Waiting for sign-in…')).toBeInTheDocument();
    expect(connectKreaMock).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().nodes).toEqual(nodes);
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('polls pending consent, then checks and disconnects from the row menu', async () => {
    await renderSettings();
    await screen.findByRole('button', { name: 'Sign in to Krea' });
    vi.useFakeTimers();
    getKreaConnectionMock.mockResolvedValueOnce({ status: 'connected', tools: ['generate_image'] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in to Krea' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(within(row('Krea · sign-in')).getByText('Signed in')).toBeInTheDocument();
    expect(rowNames(list(/^Connected/))).toContain('Krea · sign-in');
    expect(screen.queryByRole('link', { name: /Open Krea sign-in/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Krea sign-in' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check connection' })); });
    expect(checkKreaConnectionMock).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    expect(disconnectKreaMock).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Sign in to Krea' })).toBeInTheDocument();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('shows plans on request when signed in and opens checkout only from a link', async () => {
    getKreaConnectionMock.mockResolvedValue({ status: 'connected', tools: ['show_plans'] });
    getKreaPlansMock.mockResolvedValue({ trialAvailable: true, annualSavingsPct: 40,
      manageUrl: 'https://www.krea.ai/pricing', plans: [{ id: 'creator_pro', name: 'Pro', prominent: false,
        units: 20000, price: 35, annualPrice: 21, examples: [], features: [],
        checkoutUrl: 'https://www.krea.ai/pricing?plan=creator_pro', annualCheckoutUrl: null }] });
    startKreaTrialMock.mockResolvedValue('https://checkout.stripe.com/c/pay/cs_1');
    await renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Krea sign-in' }));
    expect(getKreaPlansMock).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show plans' })); });
    expect(screen.getByText('$35/mo · $21/mo yearly')).toBeInTheDocument();
    expect(screen.getByText('20,000 compute units')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View on Krea' })).toHaveAttribute('href', 'https://www.krea.ai/pricing?plan=creator_pro');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start a free Pro trial' })); });
    expect(screen.getByRole('link', { name: /Open trial checkout/ })).toHaveAttribute('href', 'https://checkout.stripe.com/c/pay/cs_1');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('saves the default for new Krea nodes immediately without rewriting existing nodes', async () => {
    getKreaConnectionMock.mockResolvedValue({ status: 'connected' });
    const saved = { id: 'old', type: 'model-node', position: { x: 0, y: 0 }, data: {
      label: 'Old recipe', definitionId: 'krea-video-kling-kling-3-0', params: { duration: 5 }, state: 'idle' as const, outputs: {} } };
    useGraphStore.setState({ nodes: [saved], runHistory: [] });
    await renderSettings({ apiKeys: {}, kreaConnectionMode: 'api-token' });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Krea sign-in' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Default Krea connection for new nodes' }), { target: { value: 'mcp' } });
    await waitFor(() => expect(useUIStore.getState().settingsCache.kreaConnectionMode).toBe('mcp'));
    expect(updateSettingsMock.mock.calls).toEqual([[{ kreaConnectionMode: 'mcp' }]]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({ duration: 5 });
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it('keeps the default reachable while signed out if new nodes are set to use sign-in', async () => {
    await renderSettings({ apiKeys: {}, kreaConnectionMode: 'mcp' });
    expect(await screen.findByRole('combobox', { name: 'Default Krea connection for new nodes' })).toHaveValue('mcp');
  });

  it('reserves a browser tab in the click before waiting for Krea registration', async () => {
    let finishConnect!: (state: { status: 'connecting'; authorizationUrl: string }) => void;
    connectKreaMock.mockImplementationOnce(() => new Promise((resolve) => { finishConnect = resolve; }));
    const signInWindow = { opener: window, closed: false, document: { title: '', body: { textContent: '' } },
      location: { replace: vi.fn() }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(signInWindow as unknown as Window);
    await renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Krea' }));
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(signInWindow.opener).toBeNull();
    await act(async () => { finishConnect({ status: 'connecting', authorizationUrl: KREA_URL }); });
    expect(signInWindow.location.replace).toHaveBeenCalledExactlyOnceWith(KREA_URL);
    expect(signInWindow.close).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'closed'])('shows the fallback link without opening the menu when the tab is %s', async (reason) => {
    const replace = vi.fn();
    if (reason === 'closed') vi.mocked(window.open).mockReturnValue({ opener: null, closed: true,
      document: { body: {} }, location: { replace }, close: vi.fn() } as unknown as Window);
    await renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Krea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use Open Krea sign-in below');
    expect(screen.getByRole('link', { name: /Open Krea sign-in/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart sign-in' })).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    await within(row('Krea · sign-in')).findByText('Signed in');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(window.open).toHaveBeenCalledOnce();
  });

  it.each(['untrusted URL', 'registration failure'])('closes the blank tab after %s', async (reason) => {
    const signInWindow = { opener: null, closed: false, document: { body: {} }, location: { replace: vi.fn() }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(signInWindow as unknown as Window);
    if (reason === 'untrusted URL') connectKreaMock.mockResolvedValueOnce({ status: 'connecting', authorizationUrl: 'https://untrusted.test/?token=fixture' });
    else connectKreaMock.mockRejectedValueOnce(new Error("Couldn't update the Krea connection."));
    await renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Krea' }));
    await screen.findByRole('alert');
    expect(signInWindow.close).toHaveBeenCalledOnce();
    expect(signInWindow.location.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /Open Krea sign-in/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('token=fixture');
  });

  it('uses the desktop external-browser bridge and keeps the manual fallback', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true });
    setupDesktopBridge({ kreaOpen: open });
    await renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Krea' }));
    const link = await screen.findByRole('link', { name: /Open Krea sign-in/ });
    expect(open).toHaveBeenCalledOnce();
    expect(window.open).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(KREA_URL);
  });

  it('does not open a browser when Settings loads or polls an already pending sign-in', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true });
    setupDesktopBridge({ kreaOpen: open });
    getKreaConnectionMock.mockResolvedValue({ status: 'connecting', authorizationUrl: KREA_URL });
    getSettingsMock.mockResolvedValue({ runCostConfirmUsd: 1, apiKeys: {} });
    vi.useFakeTimers();
    await act(async () => { render(<Settings />); });
    expect(within(row('Krea · sign-in')).getByText('Waiting for sign-in…')).toBeInTheDocument();
    const checksBeforePoll = getKreaConnectionMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getKreaConnectionMock).toHaveBeenCalledTimes(checksBeforePoll + 1);
    expect(connectKreaMock).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('never renders an untrusted authorization URL as a link', async () => {
    getKreaConnectionMock.mockResolvedValue({ status: 'needs_auth', authorizationUrl: 'https://untrusted.test/?token=fixture', error: 'Sign in again.' });
    await renderSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again.');
    expect(screen.queryByRole('link', { name: /Open Krea sign-in/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('token=fixture');
  });
});

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

describe('Settings — preferences', () => {
  it('applies switches immediately, in this browser, without a backend write', async () => {
    useUIStore.setState({ canvasPerfMode: false, canvasMinimapEnabled: false });
    await renderSettings();
    openTab('Preferences');
    const minimap = screen.getByRole('switch', { name: /Minimap/ });
    expect(minimap).not.toBeChecked();
    fireEvent.click(minimap);
    expect(useUIStore.getState().canvasMinimapEnabled).toBe(true);
    expect(localStorage.getItem('nebula:canvas:minimapEnabled')).toBe('1');
    expect(useUIStore.getState().canvasPerfMode).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: /Agent log/ }));
    expect(useUIStore.getState().agentLogEnabled).toBe(true);
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it('shows Completion sound only while job notifications are on', async () => {
    useUIStore.setState({ notificationPrefs: { enabled: false, sound: false } });
    await renderSettings();
    openTab('Preferences');
    expect(screen.queryByRole('switch', { name: /Completion sound/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Job notifications/ }));
    expect(screen.getByRole('switch', { name: /Completion sound/ })).toBeInTheDocument();
  });

  it('applies the run-cost threshold at once and saves it, since agents are held to it too', async () => {
    await renderSettings({ apiKeys: {}, runCostConfirmUsd: 1 });
    openTab('Preferences');
    const select = screen.getByRole('combobox', { name: 'Ask before costly runs' });
    expect(select).toHaveValue('1');
    fireEvent.change(select, { target: { value: '5' } });
    expect(useUIStore.getState().runCostConfirmUsd).toBe(5);
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ runCostConfirmUsd: 5 }));
    fireEvent.change(select, { target: { value: 'off' } });
    expect(useUIStore.getState().runCostConfirmUsd).toBeNull();
    await waitFor(() => expect(updateSettingsMock).toHaveBeenLastCalledWith({ runCostConfirmUsd: null }));
    expect(screen.getByText(/There is no per-run limit/)).toBeInTheDocument();
    useUIStore.getState().setRunCostConfirmUsd(1);
  });

  it('puts the threshold back and says so when saving it fails', async () => {
    await renderSettings({ apiKeys: {}, runCostConfirmUsd: 2 });
    openTab('Preferences');
    updateSettingsMock.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Ask before costly runs' }), { target: { value: '10' } });
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save");
    expect(useUIStore.getState().runCostConfirmUsd).toBe(2);
    useUIStore.getState().setRunCostConfirmUsd(1);
  });

  it('takes the saved threshold over this browser, and saves a browser-only one once', async () => {
    useUIStore.setState({ runCostConfirmUsd: 5 });
    await renderSettings({ apiKeys: {}, runCostConfirmUsd: 20 });
    expect(useUIStore.getState().runCostConfirmUsd).toBe(20);
    expect(updateSettingsMock).not.toHaveBeenCalled();
    cleanup();
    resetRunCostConfirmMigration();
    useUIStore.setState({ runCostConfirmUsd: 5 });
    getSettingsMock.mockResolvedValue({ apiKeys: {} });
    render(<Settings />);
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ runCostConfirmUsd: 5 }));
    useUIStore.getState().setRunCostConfirmUsd(1);
  });

  it('limits what agents spend per chat session and per model', async () => {
    await renderSettings({ apiKeys: {}, runCostConfirmUsd: 1, agentSpend: { sessionUsd: null, models: {} } });
    openTab('Preferences');
    expect(screen.getByText(/The per-run limit above \(\$1\) applies to agents too/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Per chat session' }), { target: { value: '10' } });
    await waitFor(() => expect(updateSettingsMock).toHaveBeenLastCalledWith({ agentSpend: { sessionUsd: 10, models: {} } }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Limit a model' }), { target: { value: 'gpt-image-1-generate' } });
    await waitFor(() => expect(updateSettingsMock).toHaveBeenLastCalledWith({
      agentSpend: { sessionUsd: 10, models: { 'gpt-image-1-generate': { perRunUsd: 1, sessionUsd: null } } },
    }));
    const perSession = await screen.findByRole('combobox', { name: 'GPT Image 1 per session' });
    fireEvent.change(perSession, { target: { value: '25' } });
    await waitFor(() => expect(updateSettingsMock).toHaveBeenLastCalledWith({
      agentSpend: { sessionUsd: 10, models: { 'gpt-image-1-generate': { perRunUsd: 1, sessionUsd: 25 } } },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the limits for GPT Image 1' }));
    await waitFor(() => expect(updateSettingsMock).toHaveBeenLastCalledWith({ agentSpend: { sessionUsd: 10, models: {} } }));
    expect(screen.queryByRole('combobox', { name: 'GPT Image 1 per session' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('Settings — storage', () => {
  it('saves a folder when you leave the field, and an emptied one returns to the default', async () => {
    await renderSettings({ apiKeys: {}, outputPath: '/old', exportFolder: '' });
    openTab('Storage');
    const output = screen.getByRole('textbox', { name: 'Generated files' });
    expect(output).toHaveValue('/old');
    expect(screen.getByText(/takes effect after Nebula restarts/)).toBeInTheDocument();
    fireEvent.change(output, { target: { value: ' /new ' } });
    fireEvent.blur(output);
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ outputPath: '/new' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    fireEvent.change(output, { target: { value: '' } });
    fireEvent.keyDown(output, { key: 'Enter' });
    await waitFor(() => expect(updateSettingsMock).toHaveBeenLastCalledWith({ outputPath: null }));
    expect(providerApiFetchMock).not.toHaveBeenCalled();
  });

  it('does not write when the folder is unchanged, and Escape restores it without closing', async () => {
    await renderSettings({ apiKeys: {}, outputPath: '/old' });
    openTab('Storage');
    const output = screen.getByRole('textbox', { name: 'Generated files' });
    fireEvent.change(output, { target: { value: '/typo' } });
    fireEvent.keyDown(output, { key: 'Escape' });
    expect(output).toHaveValue('/old');
    expect(useUIStore.getState().panels.settings.visible).toBe(true);
    fireEvent.blur(output);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('keeps a typed folder and shows the error when saving fails', async () => {
    updateSettingsMock.mockRejectedValueOnce(new Error('offline'));
    await renderSettings({ apiKeys: {}, exportFolder: '' });
    openTab('Storage');
    const exports = screen.getByRole('textbox', { name: 'Exports' });
    fireEvent.change(exports, { target: { value: '/exports' } });
    fireEvent.blur(exports);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save. Try again.");
    expect(exports).toHaveValue('/exports');
  });

  it('picks folders with the desktop chooser, starting from the current one', async () => {
    const { folders } = setupDesktopBridge({ choose: vi.fn().mockResolvedValueOnce({ ok: true, path: '/picked' }).mockResolvedValueOnce({ ok: true, path: null }) });
    await renderSettings({ apiKeys: {}, outputPath: '/old' });
    openTab('Storage');
    fireEvent.click(screen.getByRole('button', { name: 'Choose generated files folder' }));
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ outputPath: '/picked' }));
    expect(folders.choose).toHaveBeenCalledWith('/old');
    fireEvent.click(screen.getByRole('button', { name: 'Choose exports folder' }));
    await waitFor(() => expect(folders.choose).toHaveBeenCalledTimes(2));
    expect(updateSettingsMock).toHaveBeenCalledOnce();
  });

  it('offers no chooser in the browser', async () => {
    await renderSettings();
    openTab('Storage');
    expect(screen.queryByRole('button', { name: /Choose .* folder/ })).not.toBeInTheDocument();
  });

  it('saves demo telemetry on its own and starts onboarding from Help & advanced', async () => {
    await renderSettings({ apiKeys: {}, zoomTelemetryEnabled: false });
    openTab('Storage');
    fireEvent.click(screen.getByRole('switch', { name: /Demo zoom telemetry/ }));
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith({ zoomTelemetryEnabled: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: /Demo zoom telemetry/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: /Show onboarding again/ }));
    expect(useUIStore.getState().panels.settings.visible).toBe(false);
    expect(useUIStore.getState().onboardingActive).toBe(true);
  });
});
