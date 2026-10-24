import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// error-copy review: apiFetch now throws ConnectionLostError (message: GM's
// connection line) when no answer comes back. The chat panel must still read
// that as "the backend is down", not as "log in to Claude/Codex again".

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(),
  fetchCodexStatus: vi.fn(),
  fetchChatModels: vi.fn(), fetchPersonalAgents: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus,
  fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchChatModels: apiMocks.fetchChatModels,
  fetchPersonalAgents: apiMocks.fetchPersonalAgents,
}));

vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));

import { ChatPanel } from '../src/components/panels/ChatPanel';
import { ConnectionLostError, RequestFailedError } from '../src/lib/errorCopy';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();

const catalog = (agent: 'claude' | 'codex') => ({
  agent, status: 'ready', auth: { mode: agent === 'claude' ? 'claudeai' : 'chatgpt' },
  catalog: { source: 'test', runtimeVersion: 'test', fetchedAt: '2026-10-22T12:00:00Z' },
  models: [{ id: `${agent}-m`, label: `${agent} model`, isDefault: true, defaultEffort: 'medium', supportedEfforts: [{ id: 'medium', label: 'Medium' }] }],
});

class ChatTestSocket extends WebSocket {
  static instances: ChatTestSocket[] = [];
  constructor(url: string | URL) { super(url); ChatTestSocket.instances.push(this); }
  send() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  ChatTestSocket.instances = [];
  vi.stubGlobal('WebSocket', ChatTestSocket);
  window.localStorage.clear();
  useUIStore.setState(initialUI, true);
  useUIStore.setState((state) => ({
    panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } },
  }));
  const lost = () => Promise.reject(new ConnectionLostError(new TypeError('Failed to fetch')));
  apiMocks.fetchClaudeStatus.mockImplementation(lost);
  apiMocks.fetchCodexStatus.mockImplementation(lost);
  apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: false, agents: [] });
  apiMocks.fetchChatModels.mockImplementation(async (agent: 'claude' | 'codex') => catalog(agent));
});

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  vi.unstubAllGlobals();
});

function expectBackendOfflineHint() {
  const hint = document.querySelector('[data-chat-agent-connect]') as HTMLElement | null;
  expect(hint).not.toBeNull();
  expect(hint!).toHaveTextContent('Start Nebula backend');
  expect(hint!).toHaveTextContent('Backend offline');
  expect(hint!.textContent).not.toMatch(/Connect Claude|Connect ChatGPT Account|claude auth login|codex login/);
}

describe('ChatPanel with the Nebula backend unreachable', () => {
  it('Claude: shows the start-backend hint, not login advice', async () => {
    render(<ChatPanel />);
    await waitFor(() => expect(apiMocks.fetchClaudeStatus).toHaveBeenCalled());
    await waitFor(expectBackendOfflineHint);
    expect(screen.queryByText('Claude status unavailable')).toBeNull();
  });

  it('Codex: shows the start-backend hint, not ChatGPT login advice', async () => {
    render(<ChatPanel />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Codex' })); });
    await waitFor(() => expect(apiMocks.fetchCodexStatus).toHaveBeenCalled());
    await waitFor(expectBackendOfflineHint);
    expect(screen.queryByText('Codex status unavailable')).toBeNull();
  });

  // typeerror (2026-10-24): a TypeError that isn't fetch's no-answer (a bug or
  // a data problem in the browser) is not "the backend is down".
  it('a browser TypeError is not read as the backend being offline', async () => {
    apiMocks.fetchClaudeStatus.mockImplementation(() => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'installed')")));
    render(<ChatPanel />);
    await waitFor(() => expect(apiMocks.fetchClaudeStatus).toHaveBeenCalled());
    const [label] = await screen.findAllByText('Claude status unavailable');
    expect(label).toHaveAttribute('title', "Couldn't check Claude status. Try again, or reload if it keeps happening.");
    expect(screen.queryByText('Nebula backend offline')).toBeNull();
    expect(document.querySelector('[data-chat-agent-connect]')?.textContent ?? '').not.toContain('Backend offline');
  });
});

// typeerror2 (2026-10-24): "backend offline" is decided by the error's kind
// and status, never its words. No answer (isNoAnswer), or a gateway status
// (502/503/504) with no reason of the backend's: the Vite proxy (or another
// gateway) answering for a backend it couldn't reach. A refusal whose reason
// happens to say "network" is the backend answering.
describe('ChatPanel decides "backend offline" from kind and status', () => {
  const HEADING = "Couldn't check Claude status.";

  async function expectNotOffline() {
    render(<ChatPanel />);
    await waitFor(() => expect(apiMocks.fetchClaudeStatus).toHaveBeenCalled());
    await screen.findAllByText('Claude status unavailable');
    expect(screen.queryByText('Nebula backend offline')).toBeNull();
    expect(document.querySelector('[data-chat-agent-connect]')?.textContent ?? '').not.toContain('Backend offline');
  }

  it('a 4xx whose reason says "network" is not offline', async () => {
    apiMocks.fetchClaudeStatus.mockImplementation(() => Promise.reject(
      new RequestFailedError(HEADING, 400, { detail: 'The network policy on this machine blocks the Claude CLI.' })));
    await expectNotOffline();
  });

  it('a plain Error with fetch\'s words that nothing classified is not offline', async () => {
    apiMocks.fetchClaudeStatus.mockImplementation(() => Promise.reject(new Error('Failed to fetch')));
    await expectNotOffline();
  });

  it('the backend\'s own 500 is the backend answering, not offline', async () => {
    apiMocks.fetchClaudeStatus.mockImplementation(() => Promise.reject(new RequestFailedError(HEADING, 500)));
    await expectNotOffline();
  });

  it('a 503 with the backend\'s own written reason is the backend answering, not offline', async () => {
    apiMocks.fetchClaudeStatus.mockImplementation(() => Promise.reject(
      new RequestFailedError(HEADING, 503, { detail: 'Claude CLI is busy.' })));
    await expectNotOffline();
  });

  it.each([502, 503, 504])('a %i with no reason (the proxy could not reach the backend) is offline', async (status) => {
    apiMocks.fetchClaudeStatus.mockImplementation(() => Promise.reject(new RequestFailedError(HEADING, status)));
    render(<ChatPanel />);
    await waitFor(() => expect(apiMocks.fetchClaudeStatus).toHaveBeenCalled());
    await waitFor(expectBackendOfflineHint);
    expect((await screen.findAllByText('Nebula backend offline')).length).toBeGreaterThan(0);
  });

  it('an AbortError nobody asked for (no answer) is offline', async () => {
    apiMocks.fetchClaudeStatus.mockImplementation(() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')));
    render(<ChatPanel />);
    await waitFor(() => expect(apiMocks.fetchClaudeStatus).toHaveBeenCalled());
    await waitFor(expectBackendOfflineHint);
  });
});
