import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Round 11 of PR #114 (GM): /clear clears this tab's session always; the
// canvas clear is the backend's and is refused while a run is going. Before
// round 11 the chat said "Session cleared. Next message starts a fresh
// conversation with an empty canvas." whatever the backend answered.

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchChatModels: vi.fn(), fetchPersonalAgents: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus, fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchChatModels: apiMocks.fetchChatModels, fetchPersonalAgents: apiMocks.fetchPersonalAgents,
}));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
import { ChatPanel } from '../src/components/panels/ChatPanel';
import { useUIStore } from '../src/store/uiStore';
const initialUI = useUIStore.getState();

class ChatSocket extends WebSocket {
  static instances: ChatSocket[] = [];
  constructor(url: string | URL) { super(url); ChatSocket.instances.push(this); }
  open() {
    Object.defineProperty(this, 'readyState', { value: WebSocket.OPEN, writable: true, configurable: true });
    this.onopen?.call(this, new Event('open'));
  }
  send() {}
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    Object.defineProperty(this, 'readyState', { value: WebSocket.CLOSED, writable: true, configurable: true });
    this.onclose?.call(this, new CloseEvent('close'));
  }
}

let clearAnswer: () => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks(); ChatSocket.instances = []; vi.stubGlobal('WebSocket', ChatSocket);
  localStorage.clear(); sessionStorage.clear();
  useUIStore.setState(initialUI, true);
  useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } } }));
  apiMocks.fetchClaudeStatus.mockResolvedValue({ installed: true, loggedIn: true });
  apiMocks.fetchCodexStatus.mockResolvedValue({ installed: true, loggedIn: true, mode: 'chatgpt' });
  apiMocks.fetchChatModels.mockImplementation(async (agent: string) => ({
    agent, status: 'ready', auth: { mode: 'claudeai' },
    catalog: { source: 'test', runtimeVersion: 'test', fetchedAt: '2026-10-26T12:00:00Z' },
    models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true, defaultEffort: 'medium',
      supportedEfforts: [{ id: 'medium', label: 'Medium' }] }],
  }));
  apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [] });
  clearAnswer = async () => new Response('{}');
  apiMocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => (
    path.startsWith('/api/graph') && init?.method === 'DELETE' ? clearAnswer() : new Response('{}')));
});
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); vi.unstubAllGlobals(); });

async function typeClear() {
  render(<ChatPanel />);
  await waitFor(() => expect(ChatSocket.instances).toHaveLength(1));
  await act(async () => ChatSocket.instances[0].open());
  const input = screen.getByPlaceholderText('Message…');
  fireEvent.change(input, { target: { value: '/clear' } });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: false }); });
  await waitFor(() => expect(apiMocks.apiFetch).toHaveBeenCalledWith('/api/graph?force=true', { method: 'DELETE' }));
}

describe('/clear in the chat panel', () => {
  it('a canvas clear refused during a run: GM\'s session line, and the refusal under Clear\'s heading', async () => {
    clearAnswer = async () => new Response(
      JSON.stringify({ detail: 'A run is still going. Wait for it to finish or stop it first.' }),
      { status: 409, headers: { 'content-type': 'application/json' } });
    await typeClear();
    expect(await screen.findByText(
      "Session cleared. Next message starts a fresh conversation. The canvas wasn't cleared.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-chat-notice]')?.textContent).toBe(
      "Couldn't clear the canvas. A run is still going. Wait for it to finish or stop it first."));
    expect(screen.queryByText(/with an empty canvas/)).toBeNull();
  });

  it('a canvas clear that went through keeps the empty-canvas line', async () => {
    await typeClear();
    expect(await screen.findByText(
      'Session cleared. Next message starts a fresh conversation with an empty canvas.')).toBeTruthy();
    expect(document.querySelector('[data-chat-notice]')).toBeNull();
  });
});
