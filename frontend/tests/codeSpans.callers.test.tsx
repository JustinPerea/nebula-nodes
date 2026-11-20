/**
 * Design: a `…` span draws as inline code only on the lines whose text is a backend, provider or agent
 * message (LineText `code`). One render per caller that turns it on, and one for a caller that leaves it off.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: () => new Promise<Response>(() => {}),
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
const api = vi.hoisted(() => ({
  getOutsideSpend: vi.fn(), fetchPersonalAgents: vi.fn(), setConnectedAppLimit: vi.fn(),
  fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchChatModels: vi.fn(), startCodexChatGPTLogin: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getOutsideSpend: (...a: unknown[]) => api.getOutsideSpend(...a),
  fetchPersonalAgents: (...a: unknown[]) => api.fetchPersonalAgents(...a),
  setConnectedAppLimit: (...a: unknown[]) => api.setConnectedAppLimit(...a),
  fetchClaudeStatus: (...a: unknown[]) => api.fetchClaudeStatus(...a),
  fetchCodexStatus: (...a: unknown[]) => api.fetchCodexStatus(...a),
  fetchChatModels: (...a: unknown[]) => api.fetchChatModels(...a),
  startCodexChatGPTLogin: (...a: unknown[]) => api.startCodexChatGPTLogin(...a),
}));
const krea = vi.hoisted(() => ({ getKreaConnection: vi.fn(), getKreaPlans: vi.fn() }));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: (...a: unknown[]) => krea.getKreaConnection(...a),
  getKreaPlans: (...a: unknown[]) => krea.getKreaPlans(...a),
}));

const { FailureNotice } = await import('../src/lib/errorCopy');
const { FailureLines } = await import('../src/components/failure/FailureLines');
const { NodeError } = await import('../src/components/nodes/NodeError');
const { ConnectedApps } = await import('../src/components/panels/settings/ConnectedApps');
const { ProvidersTab } = await import('../src/components/panels/settings/ProvidersTab');
const { ChatPanel } = await import('../src/components/panels/ChatPanel');
const { CanvasMessageNotice } = await import('../src/components/canvas/CanvasMessageNotice');
const { useSettingsDraftStore } = await import('../src/store/settingsDraftStore');
const { useProviderReadinessStore } = await import('../src/store/providerReadinessStore');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');
const { KREA_ROW } = await import('../src/components/panels/settings/rowHelpers');

const initialDraft = useSettingsDraftStore.getState();
const initialUI = useUIStore.getState();
const SAVED = {
  apiKeys: {}, routing: {}, kreaConnectionMode: 'mcp', outputPath: '/out', exportFolder: '/exports',
  zoomTelemetryEnabled: false, agentSpend: { sessionUsd: 5, models: {} },
} as unknown as NonNullable<typeof initialDraft.saved>;
const APPS = { outside: { spentUsd: 0, kreaPlanRuns: 0 }, connect: { available: false },
  apps: [{ id: 'a1', name: 'Hermes', client: null, color: null, dailyUsd: 5, spentUsd: 0, kreaPlanRuns: 0 }] };
const MESSAGE = 'Run `codex login` first.';
const written = () => new FailureNotice('', MESSAGE, { standalone: true });
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const codes = (root: ParentNode) => [...root.querySelectorAll('code.code-span')].map((c) => c.textContent);

beforeEach(() => {
  useSettingsDraftStore.setState({ ...initialDraft, saved: SAVED, keyDrafts: {}, fieldDrafts: {}, openRow: null, pending: {}, errors: {} });
  api.getOutsideSpend.mockReset().mockResolvedValue(APPS);
  api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [] });
  api.setConnectedAppLimit.mockReset().mockRejectedValue(written());
  krea.getKreaConnection.mockReset().mockResolvedValue({ status: 'connected' });
  krea.getKreaPlans.mockReset().mockRejectedValue(written());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useProviderReadinessStore.setState({ error: null }); useGraphStore.setState({ messageNotice: null }); useUIStore.setState(initialUI, true); });

describe('callers that turn code spans on', () => {
  it('FailureLines draws a span only with `code`', () => {
    const on = render(<FailureLines failure={MESSAGE} code />);
    expect(codes(on.container)).toEqual(['codex login']);
    cleanup();
    const copy = { heading: '', reason: MESSAGE, cause: '', button: '', what: '' };
    expect(codes(render(<FailureLines failure={copy} code />).container)).toEqual(['codex login']);
    cleanup();
    expect(codes(render(<FailureLines failure={MESSAGE} />).container)).toEqual([]);
  });

  it('NodeError', () => {
    const { container } = render(<NodeError person={MESSAGE} />);
    expect(codes(container)).toEqual(['codex login']);
    expect(container.querySelector('.model-node__error-message')!.textContent).not.toContain('`');
  });

  it('Connected apps error line', async () => {
    const { container } = render(<ConnectedApps view={APPS as never} loadError={null} onChanged={() => {}} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Hermes daily limit' }), { target: { value: '10' } });
    await flush();
    expect(codes(container.querySelector('.settings-row__error')!)).toEqual(['codex login']);
  });

  it('Providers health error line', async () => {
    const { container } = render(<ProvidersTab saved={SAVED} />);
    await flush();
    act(() => useProviderReadinessStore.setState({ error: MESSAGE }));
    expect(codes(container.querySelector('.settings-row__error')!)).toEqual(['codex login']);
  });

  it('Krea plans error line', async () => {
    useSettingsDraftStore.setState({ openRow: { id: KREA_ROW, mode: 'manage' } });
    const { container } = render(<ProvidersTab saved={SAVED} />);
    await flush();
    fireEvent.click(await screen.findByRole('button', { name: 'Show plans' }));
    await flush();
    await waitFor(() => expect(codes(container)).toEqual(['codex login']));
  });

  it('the Codex ChatGPT sign-in error line', async () => {
    api.fetchClaudeStatus.mockReset().mockResolvedValue({ installed: true, loggedIn: true });
    api.fetchCodexStatus.mockReset().mockResolvedValue({ installed: true, loggedIn: false });
    api.fetchChatModels.mockReset().mockImplementation(async (agent: string) => ({
      agent, status: 'ready', auth: { mode: 'chatgpt' }, catalog: { source: 't', runtimeVersion: 't', fetchedAt: '2026-10-09T12:00:00Z' },
      models: [{ id: 'm', label: 'M', isDefault: true, defaultEffort: 'medium', supportedEfforts: [{ id: 'medium', label: 'Medium' }] }],
    }));
    api.startCodexChatGPTLogin.mockReset().mockRejectedValue(written());
    vi.stubGlobal('WebSocket', class extends WebSocket { send() {} });
    useUIStore.setState((s) => ({ panels: { ...s.panels, chat: { ...s.panels.chat, visible: true } } }));
    const { container } = render(<ChatPanel />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Codex' })); });
    await flush();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT account' })); });
    await flush();
    await waitFor(() => expect(codes(container.querySelector('.chat-panel__connect-progress')!)).toEqual(['codex login']));
  });
});

describe('a caller that leaves code spans off', () => {
  it('CanvasMessageNotice keeps backticks as typed', () => {
    useGraphStore.setState({ messageNotice: { id: 1, text: 'Nebula couldn’t add “a`b`.png”.', tone: 'error' } as never });
    const { container } = render(<CanvasMessageNotice />);
    expect(codes(container)).toEqual([]);
    expect(container.textContent).toContain('a`b`.png');
  });
});
