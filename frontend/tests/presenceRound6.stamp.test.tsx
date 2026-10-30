/**
 * PR #204 round 6, review 4 NIT-2 and held-state-ui LOW-2: one send-time stamp, one check.
 * - The chat socket's person_required error is read against the promote count its turn went
 *   out under: a turn sent before the promote and refused after it holds nothing, and its line
 *   goes at once; a turn sent under the current state holds the tab, and its line waits.
 * - A notice shown through showNotice with the refusal carries that refusal's stamp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({ fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchChatModels: vi.fn(), fetchPersonalAgents: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus, fetchCodexStatus: apiMocks.fetchCodexStatus, fetchChatModels: apiMocks.fetchChatModels,
  fetchPersonalAgents: apiMocks.fetchPersonalAgents,
}));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
import { ChatPanel } from '../src/components/panels/ChatPanel';
import { notePersonPromoted, personPromotions, resetPersonSessionForTests } from '../src/lib/personSession';
import { showNotice } from '../src/lib/canvasNotice';
import { personRefusalSentAt } from '../src/lib/errorCopy';
import { useGraphStore } from '../src/store/graphStore';
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
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    Object.defineProperty(this, 'readyState', { value: WebSocket.CLOSED, writable: true, configurable: true });
    this.onclose?.call(this, new CloseEvent('close'));
  }
  receive(event: unknown) { this.onmessage?.call(this, new MessageEvent('message', { data: JSON.stringify(event) })); }
}
beforeEach(() => {
  vi.clearAllMocks(); ChatSocket.instances = []; vi.stubGlobal('WebSocket', ChatSocket);
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/'); resetCommonsSessionForTests();
  useUIStore.setState(initialUI, true);
  useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } } }));
  apiMocks.fetchClaudeStatus.mockResolvedValue({ installed: true, loggedIn: true });
  apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: false, agents: [] });
  apiMocks.fetchCodexStatus.mockResolvedValue({ installed: true, loggedIn: true, mode: 'chatgpt' });
  apiMocks.fetchChatModels.mockImplementation(async (agent: string) => ({
    agent, status: 'ready', auth: { mode: agent === 'claude' ? 'claudeai' : 'chatgpt' },
    catalog: { source: 'test-runtime', runtimeVersion: 'test', fetchedAt: '2026-10-09T12:00:00Z' },
    models: [{
      id: agent === 'claude' ? 'sonnet' : 'gpt-test', label: agent === 'claude' ? 'Sonnet' : 'GPT Test',
      isDefault: true, defaultEffort: 'medium',
      supportedEfforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }],
    }],
  }));
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

const LINE = "This change needs your OK, and this tab isn’t connected as you. Open the link Nebula printed when it started, then try again.";

describe('review 4 NIT-2: the chat socket\'s refusal is stamped with its turn', () => {
  beforeEach(() => resetPersonSessionForTests());
  it('a turn sent before the promote, refused after it: holds nothing, and its line goes at once', async () => {
    const seen = vi.fn(); window.addEventListener('nebula:person-required', seen);
    const socket = await connected();
    await sendText('Make a simple graph');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    act(() => notePersonPromoted());
    await act(async () => { socket.receive({ type: 'error', code: 'person_required', message: 'Only the person' }); socket.receive({ type: 'done' }); });
    expect(seen).not.toHaveBeenCalled();
    expect(screen.queryByText(LINE)).toBeNull();
    window.removeEventListener('nebula:person-required', seen);
  });
  it('a turn sent under the current state: holds the tab, and its line stays until the promote', async () => {
    const seen = vi.fn(); window.addEventListener('nebula:person-required', seen);
    const socket = await connected();
    await sendText('Make a simple graph');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => { socket.receive({ type: 'error', code: 'person_required', message: 'Only the person' }); socket.receive({ type: 'done' }); });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(LINE)).toBeInTheDocument();
    act(() => notePersonPromoted());
    await waitFor(() => expect(screen.queryByText(LINE)).toBeNull());
    window.removeEventListener('nebula:person-required', seen);
  });
});

describe('review 4 LOW-2: a notice shown with its refusal carries the refusal\'s stamp', () => {
  beforeEach(() => { resetPersonSessionForTests(); useGraphStore.setState({ undoNotice: null, messageNotice: null }); });
  const shown = () => [useGraphStore.getState().undoNotice?.text, useGraphStore.getState().messageNotice?.text].filter(Boolean);
  it('refused under the state before the promote, shown after it: the line goes at once', async () => {
    const refusal = personRefusalSentAt(personPromotions());
    notePersonPromoted();
    showNotice(LINE, 'error', refusal);
    await Promise.resolve();
    expect(shown()).toEqual([]);
  });
  it('refused under the current state: the line stays until the promote', async () => {
    showNotice(LINE, 'error', personRefusalSentAt(personPromotions()));
    await Promise.resolve();
    expect(shown()).toEqual([LINE]);
    notePersonPromoted();
    expect(shown()).toEqual([]);
  });
});
