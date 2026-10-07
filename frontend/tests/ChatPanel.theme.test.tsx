import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(),
  fetchCodexStatus: vi.fn(),
  fetchNousModels: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus,
  fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchNousModels: apiMocks.fetchNousModels,
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

class ChatTestSocket extends WebSocket {
  static instances: ChatTestSocket[] = [];

  constructor(url: string | URL) {
    super(url);
    ChatTestSocket.instances.push(this);
  }

  open() {
    Object.defineProperty(this, 'readyState', { value: WebSocket.OPEN, writable: true, configurable: true });
    this.onopen?.call(this, new Event('open'));
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
  apiMocks.fetchNousModels.mockResolvedValue({
    models: [{ id: 'test/text-model', name: 'Test text model', output_modalities: ['text'] }],
    count: 1,
  });
});

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  vi.unstubAllGlobals();
});

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
    const fallback = screen.getByRole('button', { name: 'Claude' });
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

  it('keeps Slava when switching agents while retaining Daedalus model and autonomy controls', async () => {
    const { container } = render(<ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Daedalus' }));

    expect(container.querySelector('.chat-panel')).toHaveAttribute('data-chat-agent', 'daedalus');
    expect(useUIStore.getState().skin).toBe('slava-restraint');
    expect(document.body.className).toBe('app-slava-restraint');
    expect(window.localStorage.getItem('nebula:skin')).toBe('slava-restraint');
    expect(screen.queryByRole('button', { name: 'Verdant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Obsidian' })).not.toBeInTheDocument();
    expect(document.querySelector('.hermes-bloom-portal')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Step ⏸' }));
    expect(screen.getByRole('button', { name: 'Step ⏸' })).toHaveClass('chat-panel__autonomy-btn--active');
    fireEvent.click(screen.getByRole('button', { name: 'Auto ▶' }));
    expect(screen.getByRole('button', { name: 'Auto ▶' })).toHaveClass('chat-panel__autonomy-btn--active');

    fireEvent.click(screen.getByRole('button', { name: /moonshotai\/kimi-k2\.6/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Test text model/ }));
    expect(window.localStorage.getItem('nebula:daedalus-model')).toBe('test/text-model');
    expect(window.localStorage.getItem('nebula:daedalus-provider')).toBe('nous');

    for (const agent of ['Claude', 'Codex', 'Daedalus']) {
      fireEvent.click(screen.getByRole('button', { name: agent }));
      expect(document.body.className).toBe('app-slava-restraint');
      expect(useUIStore.getState().skin).toBe('slava-restraint');
    }
    await waitFor(() => expect(screen.getByRole('button', { name: /test\/text-model/ })).toBeInTheDocument());
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });
});
