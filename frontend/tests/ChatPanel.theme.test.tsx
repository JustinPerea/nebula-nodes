import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(),
  fetchCodexStatus: vi.fn(),
  fetchChatModels: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus,
  fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchChatModels: apiMocks.fetchChatModels,
}));

vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));

import { ChatPanel } from '../src/components/panels/ChatPanel';
import { applySkinBodyClass, loadSkin } from '../src/lib/skins';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();

const modelCatalogs = {
  claude: {
    agent: 'claude', status: 'ready', auth: { mode: 'claudeai' },
    catalog: { source: 'claude-code', runtimeVersion: 'test', fetchedAt: '2026-10-09T12:00:00Z' },
    models: [
      { id: 'sonnet', label: 'Sonnet', isDefault: true, defaultEffort: 'medium', supportedEfforts: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] },
      { id: 'opus', label: 'Opus', isDefault: false, defaultEffort: 'high', supportedEfforts: [{ id: 'high', label: 'High' }, { id: 'max', label: 'Max' }] },
    ],
  },
  codex: {
    agent: 'codex', status: 'ready', auth: { mode: 'chatgpt' },
    catalog: { source: 'codex-app-server', runtimeVersion: 'test', fetchedAt: '2026-10-09T12:00:00Z' },
    models: [
      { id: 'gpt-test', label: 'GPT Test', isDefault: true, defaultEffort: 'medium', supportedEfforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }] },
    ],
  },
};

class ChatTestSocket extends WebSocket {
  static instances: ChatTestSocket[] = [];
  sent: Record<string, unknown>[] = [];

  constructor(url: string | URL) {
    super(url);
    ChatTestSocket.instances.push(this);
  }

  open() {
    Object.defineProperty(this, 'readyState', { value: WebSocket.OPEN, writable: true, configurable: true });
    this.onopen?.call(this, new Event('open'));
  }

  send(data: string) { this.sent.push(JSON.parse(data)); }

  receive(event: unknown) {
    this.onmessage?.call(this, new MessageEvent('message', { data: JSON.stringify(event) }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  ChatTestSocket.instances = [];
  vi.stubGlobal('WebSocket', ChatTestSocket);
  window.localStorage.clear();
  loadSkin();
  applySkinBodyClass();
  useUIStore.setState(initialUI, true);
  useUIStore.setState((state) => ({
    panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } },
  }));
  apiMocks.fetchClaudeStatus.mockResolvedValue({ installed: true, loggedIn: true });
  apiMocks.fetchCodexStatus.mockResolvedValue({ installed: true, loggedIn: true, mode: 'chatgpt' });
  apiMocks.fetchChatModels.mockImplementation(async (agent: keyof typeof modelCatalogs) => modelCatalogs[agent]);
});

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  vi.unstubAllGlobals();
});

async function connected() {
  render(<ChatPanel />);
  await waitFor(() => expect(ChatTestSocket.instances).toHaveLength(1));
  const socket = ChatTestSocket.instances[0];
  await act(async () => socket.open());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Choose chat model' })).toHaveTextContent('Sonnet'));
  return socket;
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' }));
  return screen.findByRole('dialog', { name: 'Chat model settings' });
}

function closePicker() {
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
}

function sendText(text: string) {
  const input = screen.getByPlaceholderText('Message…');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
  return input;
}

describe('ChatPanel appearance', () => {
  it('focuses an enabled control while connecting and restores its opener when Escape closes it', async () => {
    useUIStore.setState((state) => ({
      panels: { ...state.panels, chat: { ...state.panels.chat, visible: false } },
    }));
    render(<><button onClick={() => useUIStore.getState().togglePanel('chat')}>Open chat</button><ChatPanel /></>);
    const opener = screen.getByRole('button', { name: 'Open chat' });
    opener.focus();
    fireEvent.click(opener);
    const input = await screen.findByRole('textbox');
    expect(input).toBeDisabled();
    const fallback = screen.getByRole('button', { name: 'Choose chat model' });
    await waitFor(() => expect(fallback).toHaveFocus());
    expect(fallback).toBeEnabled();
    fireEvent.keyDown(fallback, { key: 'Escape' });
    expect(useUIStore.getState().panels.chat.visible).toBe(false);
    expect(opener).toHaveFocus();
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });

  it('focuses the enabled composer on reopening without stealing focus when connection becomes ready', async () => {
    useUIStore.setState((state) => ({
      panels: { ...state.panels, chat: { ...state.panels.chat, visible: false } },
    }));
    render(<><button onClick={() => useUIStore.getState().togglePanel('chat')}>Open chat</button><ChatPanel /></>);
    const opener = screen.getByRole('button', { name: 'Open chat' });
    opener.focus();
    fireEvent.click(opener);
    const input = await screen.findByRole('textbox');
    await waitFor(() => expect(ChatTestSocket.instances).toHaveLength(1));

    const close = screen.getByRole('button', { name: 'Close chat panel' });
    close.focus();
    await act(async () => ChatTestSocket.instances[0].open());
    expect(input).toBeEnabled();
    expect(close).toHaveFocus();

    fireEvent.click(close);
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useUIStore.getState().panels.chat.visible).toBe(false);
    expect(opener).toHaveFocus();
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });

  it('keeps the active appearance when switching providers and removes Daedalus from the picker', async () => {
    const socket = await connected();
    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    await screen.findByRole('radio', { name: 'GPT Test' });
    expect(document.querySelector('.chat-panel')).toHaveAttribute('data-chat-agent', 'codex');
    expect(useUIStore.getState().skin).toBe('slava-restraint');
    expect(document.body.className).toBe('app-slava-restraint');
    expect(window.localStorage.getItem('nebula:skin')).toBe('slava-restraint');
    expect(screen.queryByRole('button', { name: 'Verdant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Obsidian' })).not.toBeInTheDocument();
    expect(document.querySelector('.hermes-bloom-portal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Daedalus' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    await screen.findByRole('radio', { name: 'Sonnet' });
    expect(document.body.className).toBe('app-slava-restraint');
    expect(useUIStore.getState().skin).toBe('slava-restraint');
    expect(socket.sent).toHaveLength(0);
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });

  it('remembers each provider selection without sending a chat turn', async () => {
    const socket = await connected();
    await openPicker();
    fireEvent.click(screen.getByRole('radio', { name: 'Opus' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Max' }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'GPT Test' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Extra high' }));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Opus' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'Max' })).toBeChecked();
    expect(JSON.parse(window.localStorage.getItem('nebula:chat-selection')!)).toMatchObject({
      agent: 'claude', claude: { model: 'opus', effort: 'max' }, codex: { model: null, effort: 'xhigh' },
    });
    expect(socket.sent).toHaveLength(0);
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });

  it('preserves conversation history and same-provider sessions, then starts a fresh session when the provider changes', async () => {
    const socket = await connected();
    sendText('Review this graph');
    expect(socket.sent[0]).toMatchObject({ agent: 'claude', model: 'sonnet', effort: null, sessionId: null });
    await act(async () => {
      socket.receive({ type: 'session', sessionId: 'claude-conversation' });
      socket.receive({ type: 'text', text: 'The first review is saved.' });
      socket.receive({ type: 'done' });
    });
    await openPicker();
    fireEvent.click(screen.getByRole('radio', { name: 'Opus' }));
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    closePicker();
    expect(screen.getByText('The first review is saved.')).toBeInTheDocument();
    expect(socket.sent).toHaveLength(1);
    sendText('Continue with more detail');
    expect(socket.sent[1]).toMatchObject({ agent: 'claude', model: 'opus', effort: 'high', sessionId: 'claude-conversation' });
    await act(async () => socket.receive({ type: 'done' }));
    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    await screen.findByRole('radio', { name: 'GPT Test' });
    fireEvent.click(screen.getByRole('radio', { name: 'Extra high' }));
    closePicker();
    expect(screen.getByText('Review this graph')).toBeInTheDocument();
    expect(screen.getByText('The first review is saved.')).toBeInTheDocument();
    expect(socket.sent).toHaveLength(2);
    sendText('Now inspect with Codex');
    expect(socket.sent[2]).toMatchObject({ agent: 'codex', model: 'gpt-test', effort: 'xhigh', sessionId: null });
  });

  it('locks provider, model and effort selection while a turn is running', async () => {
    const socket = await connected();
    sendText('Inspect the graph');
    expect(socket.sent).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Choose chat model' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' }));
    expect(screen.queryByRole('dialog', { name: 'Chat model settings' })).not.toBeInTheDocument();
    await act(async () => socket.receive({ type: 'done' }));
    expect(screen.getByRole('button', { name: 'Choose chat model' })).toBeEnabled();
  });

  it('refreshes rejected model choices without resending, keeps history and requires explicit repair', async () => {
    const socket = await connected();
    sendText('Save the first review');
    await act(async () => {
      socket.receive({ type: 'session', sessionId: 'saved-review' });
      socket.receive({ type: 'text', text: 'Earlier review remains available.' });
      socket.receive({ type: 'done' });
    });
    await openPicker();
    fireEvent.click(screen.getByRole('radio', { name: 'Opus' }));
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    closePicker();
    sendText('Run a deeper review');
    expect(socket.sent).toHaveLength(2);
    apiMocks.fetchChatModels.mockImplementation(async (agent: keyof typeof modelCatalogs, refresh: boolean) => (
      agent === 'claude' && refresh
        ? { ...modelCatalogs.claude, models: [modelCatalogs.claude.models[0]] }
        : modelCatalogs[agent]
    ));
    await act(async () => {
      socket.receive({ type: 'error', code: 'model_unsupported', message: 'Opus is no longer offered.' });
      socket.receive({ type: 'done' });
    });
    await waitFor(() => expect(apiMocks.fetchChatModels).toHaveBeenCalledWith('claude', true));
    await openPicker();
    await screen.findByText('Saved model is unavailable. Choose a model from this CLI.');
    expect(screen.getByRole('radio', { name: 'Sonnet' })).not.toBeChecked();
    closePicker();
    expect(screen.getByText('Earlier review remains available.')).toBeInTheDocument();
    expect(screen.getByText('Run a deeper review')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('nebula:chat-selection')!).claude).toEqual({ model: 'opus', effort: 'high' });
    const draft = sendText('Wait until I choose again');
    expect(draft).toHaveValue('Wait until I choose again');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(socket.sent).toHaveLength(2);
    await openPicker();
    fireEvent.click(screen.getByRole('radio', { name: 'Sonnet' }));
    closePicker();
    expect(socket.sent).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(socket.sent).toHaveLength(3);
    expect(socket.sent[2]).toMatchObject({ message: 'Wait until I choose again', model: 'sonnet', effort: 'high', sessionId: 'saved-review' });
  });

  it.each([
    { title: 'model', model: 'retired-model', effort: 'medium' },
    { title: 'effort', model: 'sonnet', effort: 'unsupported-effort' },
  ])('preserves a stale saved $title and requires a valid explicit selection before sending', async ({ title, model, effort }) => {
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({
      agent: 'claude', claude: { model, effort }, codex: { model: null, effort: null },
    }));
    render(<ChatPanel />);
    await waitFor(() => expect(ChatTestSocket.instances).toHaveLength(1));
    const socket = ChatTestSocket.instances[0];
    await act(async () => socket.open());
    await openPicker();
    await screen.findByRole('radio', { name: 'Sonnet' });
    closePicker();
    const input = sendText('Keep this draft until I choose');
    expect(socket.sent).toHaveLength(0);
    expect(input).toHaveValue('Keep this draft until I choose');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(JSON.parse(window.localStorage.getItem('nebula:chat-selection')!).claude).toEqual({ model, effort });
    await openPicker();
    fireEvent.click(screen.getByRole('radio', { name: title === 'model' ? 'Sonnet' : 'High' }));
    closePicker();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ agent: 'claude', model: 'sonnet' });
  });

  it('retains the draft and does not send when the live model catalog cannot be loaded', async () => {
    apiMocks.fetchChatModels.mockRejectedValue(new Error('Catalog unavailable'));
    render(<ChatPanel />);
    await waitFor(() => expect(ChatTestSocket.instances).toHaveLength(1));
    const socket = ChatTestSocket.instances[0];
    await act(async () => socket.open());
    await waitFor(() => expect(apiMocks.fetchChatModels).toHaveBeenCalled());
    const input = sendText('Wait for the account catalog');
    expect(input).toHaveValue('Wait for the account catalog');
    expect(socket.sent).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});
