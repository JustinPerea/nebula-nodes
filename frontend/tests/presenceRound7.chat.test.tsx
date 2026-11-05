/**
 * PR #204 round 7, the chat socket:
 * - Review 5 NIT-1: each message carries its own ref, and its refusal is read against the promote
 *   count that message went out under (not the last one sent).
 * - Gates-security NIT-1 (mutant FM9): a message sent after the promote and refused holds the
 *   tab again.
 * - Review 5 MEDIUM-2, GM r9 (1): a personal agent's permission card locks Allow once and Deny in
 *   place from the one held state, with "You can answer this when this tab is connected as
 *   you."; a refused answer puts the card back to waiting.
 * Harness from ChatPanel.personal.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchChatModels: vi.fn(), fetchPersonalAgents: vi.fn(),
  acknowledgePersonalAgentWarning: vi.fn(), updatePersonalAgent: vi.fn(), createPersonalAgent: vi.fn(),
  deletePersonalAgent: vi.fn(), apiFetch: vi.fn(), antigravityAction: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus, fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchChatModels: apiMocks.fetchChatModels, fetchPersonalAgents: apiMocks.fetchPersonalAgents,
  acknowledgePersonalAgentWarning: apiMocks.acknowledgePersonalAgentWarning,
  updatePersonalAgent: apiMocks.updatePersonalAgent, createPersonalAgent: apiMocks.createPersonalAgent,
  deletePersonalAgent: apiMocks.deletePersonalAgent, antigravityAction: apiMocks.antigravityAction,
}));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
import { ChatPanel } from '../src/components/panels/ChatPanel';
import { notePersonPromoted, personGateHeld, reportPersonRequired, resetPersonSessionForTests } from '../src/lib/personSession';
import { useUIStore } from '../src/store/uiStore';
const initialUI = useUIStore.getState();
const TOKEN = 'person-token-for-tests';

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

const FAKE = {
  id: 'fake', kind: 'custom', displayName: 'Fake Agent', color: '#123456', enabled: true, command: '/bin/fake',
  args: [], status: 'ready', resolvedPath: '/bin/fake', note: '', startable: true,
};
const OFF = { ...FAKE, id: 'gemini', kind: 'preset', displayName: 'Gemini (your setup)', enabled: false, status: 'disabled' };

beforeEach(() => {
  vi.clearAllMocks(); ChatSocket.instances = []; vi.stubGlobal('WebSocket', ChatSocket);
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/');
  sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://127.0.0.1' }));
  useUIStore.setState(initialUI, true);
  useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } } }));
  apiMocks.fetchClaudeStatus.mockResolvedValue({ installed: true, loggedIn: true });
  apiMocks.fetchCodexStatus.mockResolvedValue({ installed: true, loggedIn: true, mode: 'chatgpt' });
  apiMocks.fetchChatModels.mockImplementation(async (agent: string) => ({
    agent, status: 'ready', auth: { mode: 'claudeai' },
    catalog: { source: 'test', runtimeVersion: 'test', fetchedAt: '2026-10-13T12:00:00Z' },
    models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true, defaultEffort: 'medium',
      supportedEfforts: [{ id: 'medium', label: 'Medium' }] }],
  }));
  apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [FAKE, OFF] });
  apiMocks.apiFetch.mockResolvedValue(new Response('{}'));
  apiMocks.acknowledgePersonalAgentWarning.mockResolvedValue({ warningAcknowledgedAt: '2026-10-13T12:00:00Z' });
});
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); vi.unstubAllGlobals(); });

async function connected() {
  render(<ChatPanel />);
  await waitFor(() => expect(ChatSocket.instances).toHaveLength(1));
  const socket = ChatSocket.instances[0];
  await act(async () => socket.open());
  await waitFor(() => expect(apiMocks.fetchPersonalAgents).toHaveBeenCalled());
  return socket;
}

async function pickFake() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' }));
  const dialog = await screen.findByRole('dialog', { name: 'Chat model settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /Fake Agent/ }));
  return dialog;
}

async function sendText(text: string) {
  const input = screen.getByPlaceholderText('Message…');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
}


const HELD_LINE = 'You can answer this when this tab is connected as you.';
async function personalTurn(socket: ChatSocket) {
  await pickFake();
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
  await sendText('Run it');
  await waitFor(() => expect(socket.sent).toHaveLength(1));
  await act(async () => {
    socket.receive({ type: 'permission_request', requestId: 'r-1', title: 'Run ls', kind: 'execute',
      input: { command: 'ls' }, canAllow: true, timeoutSeconds: 120, source: 'personal' });
  });
  return screen.getByRole('group', { name: 'Fake Agent asks permission' });
}

describe('review 5 NIT-1 and FM9: each message\'s refusal is read by its own ref', () => {
  beforeEach(() => resetPersonSessionForTests());
  afterEach(() => notePersonPromoted());

  it('every message the panel sends carries a ref of its own', async () => {
    const socket = await connected();
    await sendText('One');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => { socket.receive({ type: 'done' }); });
    await sendText('Two');
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    const refs = socket.sent.map((message) => message.ref);
    expect(refs.every((ref) => typeof ref === 'string' && ref.length > 0)).toBe(true);
    expect(new Set(refs).size).toBe(2);
  });

  it('a message sent after the promote, refused: the tab is held again (FM9)', async () => {
    const seen = vi.fn(); window.addEventListener('nebula:person-required', seen);
    const socket = await connected();
    notePersonPromoted();
    await sendText('After the promote');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => { socket.receive({ type: 'error', code: 'person_required', message: 'Only the person', ref: socket.sent[0].ref }); });
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('nebula:person-required', seen);
  });

  it('an earlier message\'s refusal, answered after a later send under the promote, holds nothing', async () => {
    const seen = vi.fn(); window.addEventListener('nebula:person-required', seen);
    const socket = await connected();
    await sendText('Before');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => { socket.receive({ type: 'done' }); });
    notePersonPromoted();
    await sendText('After');
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    // The first message's refusal arrives now: it went out before the promote.
    await act(async () => { socket.receive({ type: 'error', code: 'person_required', message: 'Only the person', ref: socket.sent[0].ref }); });
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener('nebula:person-required', seen);
  });

  it('gates NIT-1: /clear\'s close_session carries its own ref, stamped when it went out', async () => {
    const seen = vi.fn(); window.addEventListener('nebula:person-required', seen);
    const socket = await connected();
    await pickFake();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
    await sendText('First');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => {
      socket.receive({ type: 'session', sessionId: 'host-1', source: 'personal' });
      socket.receive({ type: 'done', source: 'personal' });
    });
    await sendText('/clear');
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    const close = socket.sent[1];
    expect(close).toMatchObject({ type: 'close_session', sessionId: 'host-1' });
    expect(typeof close.ref).toBe('string');
    expect(close.ref).not.toBe(socket.sent[0].ref);
    // Its refusal lands after a promote: it went out before it, so it holds nothing.
    notePersonPromoted();
    await act(async () => { socket.receive({ type: 'error', code: 'person_required', message: 'Only the person', ref: close.ref, source: 'system' }); });
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener('nebula:person-required', seen);
  });
});

describe('review 5 MEDIUM-2, GM r9 (1): the permission card and the held state', () => {
  beforeEach(() => resetPersonSessionForTests());
  afterEach(() => notePersonPromoted());

  it('held: Allow once and Deny stay in place, locked, with GM\'s line, and send nothing', async () => {
    const socket = await connected();
    const card = await personalTurn(socket);
    act(() => reportPersonRequired());
    const allow = within(card).getByRole('button', { name: 'Allow once' });
    const deny = within(card).getByRole('button', { name: 'Deny' });
    // GM r10 (1), round 8: the line is on the card under the buttons; they point at it.
    const line = within(card).getByText(HELD_LINE);
    for (const button of [allow, deny]) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toHaveAttribute('title');
      expect(button).toHaveAttribute('aria-describedby', line.id);
    }
    fireEvent.click(allow);
    fireEvent.click(deny);
    await act(async () => { await Promise.resolve(); });
    expect(socket.sent).toHaveLength(1);
    // Promoted: the same buttons answer.
    act(() => notePersonPromoted());
    expect(within(card).getByRole('button', { name: 'Allow once' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('an answer the gate refused puts the card back to waiting, to answer after the promote', async () => {
    const socket = await connected();
    const card = await personalTurn(socket);
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toMatchObject({ type: 'permission', requestId: 'r-1', decision: 'allow' });
    await act(async () => { socket.receive({ type: 'error', code: 'person_required', message: 'Only the person', ref: socket.sent[1].ref, source: 'personal' }); });
    expect(personGateHeld()).toBe(true);
    act(() => notePersonPromoted());
    const allow = within(card).getByRole('button', { name: 'Allow once' });
    expect(allow).not.toBeDisabled();
    fireEvent.click(allow);
    await waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(socket.sent[2]).toMatchObject({ type: 'permission', requestId: 'r-1', decision: 'allow' });
  });

  it('an answer that never went out (the socket closed first) puts the card back to waiting', async () => {
    const socket = await connected();
    const card = await personalTurn(socket);
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    // The socket closes before the answer is written (it waits for the person token).
    Object.defineProperty(socket, 'readyState', { value: WebSocket.CLOSED, writable: true, configurable: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(socket.sent).toHaveLength(1);
    expect(within(card).queryByText('Sending…')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Allow once' })).not.toBeDisabled();
  });
});
