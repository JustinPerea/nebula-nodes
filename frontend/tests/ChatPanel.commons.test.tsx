import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({ fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchNousModels: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus, fetchCodexStatus: apiMocks.fetchCodexStatus, fetchNousModels: apiMocks.fetchNousModels,
}));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
import { ChatPanel } from '../src/components/panels/ChatPanel';
import { resetCommonsSessionForTests } from '../src/lib/commonsApi';
import { useUIStore } from '../src/store/uiStore';
const initialUI = useUIStore.getState();

class ChatSocket extends WebSocket {
  static instances: ChatSocket[] = [];
  sent: Record<string, unknown>[] = [];
  constructor(url: string | URL) { super(url); ChatSocket.instances.push(this); }
  open() {
    Object.defineProperty(this, 'readyState', { value: WebSocket.OPEN, writable: true, configurable: true });
    this.onopen?.call(this, new Event('open'));
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(event: unknown) { this.onmessage?.call(this, new MessageEvent('message', { data: JSON.stringify(event) })); }
}
beforeEach(() => {
  vi.clearAllMocks(); ChatSocket.instances = []; vi.stubGlobal('WebSocket', ChatSocket);
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/'); resetCommonsSessionForTests();
  useUIStore.setState(initialUI, true);
  useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } } }));
  apiMocks.fetchClaudeStatus.mockResolvedValue({ installed: true, loggedIn: true });
  apiMocks.fetchCodexStatus.mockResolvedValue({ installed: true, loggedIn: true, mode: 'chatgpt' });
  apiMocks.fetchNousModels.mockResolvedValue({ models: [], count: 0 });
});
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); vi.unstubAllGlobals(); });
async function connected() {
  render(<ChatPanel />);
  await waitFor(() => expect(ChatSocket.instances).toHaveLength(1));
  const socket = ChatSocket.instances[0];
  await act(async () => socket.open());
  return socket;
}
async function sendText(text: string) {
  const input = screen.getByPlaceholderText('Message…');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
  return input;
}

describe('Commons chat integration', () => {
  it('retains normal Daedalus/model/autonomy and sends no Commons metadata while disabled', async () => {
    const socket = await connected();
    expect(screen.queryByRole('textbox', { name: 'Chat brand' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Daedalus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Step ⏸' }));
    await sendText('Make a simple graph');
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ type: 'send', agent: 'daedalus', autonomy: 'step', model: 'moonshotai/kimi-k2.6', provider: 'openrouter' });
    expect(socket.sent[0]).not.toHaveProperty('brand');
    expect(socket.sent[0]).not.toHaveProperty('commonsToken');
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });
  it('includes human session and brand, retains opaque conversation continuation, then starts fresh for a new brand', async () => {
    useUIStore.getState().setCommonsEnabled(true);
    const token = crypto.randomUUID(); sessionStorage.setItem('nebula.commons.token', token);
    const socket = await connected();
    const brand = screen.getByRole('textbox', { name: 'Chat brand' });
    fireEvent.change(brand, { target: { value: 'Example brand' } });
    await sendText('Look at these references');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({ type: 'send', agent: 'claude', autonomy: 'auto', commonsToken: token, brand: 'Example brand', sessionId: null });
    expect(brand).toBeDisabled();
    await act(async () => { socket.receive({ type: 'session', sessionId: 'opaque-conversation' }); socket.receive({ type: 'done' }); });
    await sendText('Continue the same review');
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toMatchObject({ sessionId: 'opaque-conversation', brand: 'Example brand', commonsToken: token });
    await act(async () => socket.receive({ type: 'done' }));
    fireEvent.change(brand, { target: { value: 'New brand' } });
    await sendText('Start with new references');
    await waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(socket.sent[2]).toMatchObject({ sessionId: null, brand: 'New brand', commonsToken: token });
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });
  it('shows the native scope restriction and preserves a draft when human authority is missing', async () => {
    useUIStore.getState().setCommonsEnabled(true);
    const socket = await connected();
    expect(screen.getByRole('button', { name: 'Daedalus' })).toBeDisabled();
    expect(screen.getByText('Private reference chats: Claude or Codex.')).toBeTruthy();
    const input = await sendText('Keep this unsent message');
    expect(await screen.findByText(/no UI session/)).toBeTruthy();
    expect(input).toHaveValue('Keep this unsent message');
    expect(socket.sent).toHaveLength(0);
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Chat brand' })).toBeEnabled();
  });
  it('sends human scope on an explicit approval continuation', async () => {
    useUIStore.getState().setCommonsEnabled(true);
    const token = crypto.randomUUID(); sessionStorage.setItem('nebula.commons.token', token);
    const socket = await connected();
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat brand' }), { target: { value: 'Example' } });
    await act(async () => { socket.receive({ type: 'session', sessionId: 'opaque-id' }); socket.receive({ type: 'approval_request', summary: 'Review this plan' }); socket.receive({ type: 'done' }); });
    expect(socket.sent).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({ message: 'APPROVED: continue', sessionId: 'opaque-id', brand: 'Example', commonsToken: token });
  });
});
