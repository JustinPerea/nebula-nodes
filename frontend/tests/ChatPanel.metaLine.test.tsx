import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The chat panel's meta line is a label (design): the agent's state in plain words, the panel's state only
// while it is busy, and the session id in the hover title.

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
  apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: false, agents: [] });
  apiMocks.fetchChatModels.mockImplementation(async (agent: 'claude' | 'codex') => catalog(agent));
});

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  vi.unstubAllGlobals();
});


const meta = () => document.querySelector('.chat-panel__meta') as HTMLElement;
const claude = (over: object = {}) => ({ installed: true, loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: null, message: 'Logged in via the CLI.', ...over });
const codex = (over: object = {}) => ({ installed: true, loggedIn: true, mode: 'chatgpt', message: 'Codex says hi.', ...over });

describe('the chat panel meta line', () => {
  it('names the plan, drops the idle word and keeps the CLI message in the hover title', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    render(<ChatPanel />);
    await waitFor(() => expect(meta().textContent).toBe('Claude · Max plan'));
    expect(meta().querySelector('span')).toHaveAttribute('title', 'Logged in via the CLI.');
  });

  it.each([
    [{ installed: false }, 'Codex isn’t installed'],
    [{ loggedIn: false }, 'Codex needs a sign-in'],
    [{ mode: 'chatgpt' }, 'Codex · your ChatGPT plan'],
    [{ mode: 'api' }, 'Codex · billed to your API key'],
    [{ mode: 'access_token' }, 'Codex · signed in with a token'],
    [{ mode: 'other' }, 'Codex · signed in'],
  ])('says Codex %j as "%s"', async (status, line) => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    apiMocks.fetchCodexStatus.mockResolvedValue(codex(status));
    render(<ChatPanel />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Codex' })); });
    await waitFor(() => expect(meta().textContent).toBe(line));
  });

  it('says Nebula couldn’t check the agent when the status call fails for another reason', async () => {
    apiMocks.fetchClaudeStatus.mockRejectedValue(new Error('boom'));
    render(<ChatPanel />);
    await waitFor(() => expect(meta().textContent).toBe('Nebula couldn’t check Claude'));
  });
});
