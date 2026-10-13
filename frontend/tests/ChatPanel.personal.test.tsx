import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchChatModels: vi.fn(), fetchPersonalAgents: vi.fn(),
  acknowledgePersonalAgentWarning: vi.fn(), updatePersonalAgent: vi.fn(), createPersonalAgent: vi.fn(),
  deletePersonalAgent: vi.fn(), apiFetch: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus, fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchChatModels: apiMocks.fetchChatModels, fetchPersonalAgents: apiMocks.fetchPersonalAgents,
  acknowledgePersonalAgentWarning: apiMocks.acknowledgePersonalAgentWarning,
  updatePersonalAgent: apiMocks.updatePersonalAgent, createPersonalAgent: apiMocks.createPersonalAgent,
  deletePersonalAgent: apiMocks.deletePersonalAgent,
}));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
import { ChatPanel } from '../src/components/panels/ChatPanel';
import { PersonalAgentsSection } from '../src/components/panels/settings/PersonalAgentsSection';
import { normalizeAgentEventSource } from '../src/lib/agentEvents';
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

describe('Personal agents in the chat panel', () => {
  it('keeps the personal source', () => {
    expect(normalizeAgentEventSource('personal')).toBe('personal');
    expect(normalizeAgentEventSource('personal:claude')).toBe('system');
  });

  it('lists only ready personal agents and hides the model controls for them', async () => {
    await connected();
    fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' }));
    const dialog = await screen.findByRole('dialog', { name: 'Chat model settings' });
    expect(within(dialog).queryByRole('button', { name: /Gemini/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Fake Agent/ }));
    await waitFor(() => expect(within(dialog).queryByRole('radio', { name: 'Sonnet' })).toBeNull());
    expect(within(dialog).getByText(/doesn.t choose its model/)).toBeInTheDocument();
    expect(screen.getByText(/Fake Agent · your agent/)).toBeInTheDocument();
  });

  it('sends a personal turn without model or effort, then reuses the session', async () => {
    const socket = await connected();
    await pickFake();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
    await sendText('Add a text node');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({ type: 'send', agent: 'personal:fake', sessionId: null, personToken: TOKEN });
    expect(socket.sent[0]).not.toHaveProperty('model');
    expect(socket.sent[0]).not.toHaveProperty('effort');
    await act(async () => {
      socket.receive({ type: 'session', sessionId: 'host-1', agentName: 'Fake Agent', source: 'personal' });
      socket.receive({ type: 'thought', text: 'Looking at the canvas', source: 'personal' });
      socket.receive({ type: 'plan', entries: [{ content: 'Find a node', priority: 'high', status: 'in_progress' }], source: 'personal' });
      socket.receive({ type: 'plan', entries: [{ content: 'Find a node', priority: 'high', status: 'completed' },
        { content: 'Add it', priority: 'medium', status: 'in_progress' }], source: 'personal' });
      socket.receive({ type: 'text', text: 'Done.', source: 'personal' });
      socket.receive({ type: 'result', text: '', stopReason: 'end_turn', source: 'personal' });
      socket.receive({ type: 'done', source: 'personal' });
    });
    expect(screen.getByText('Looking at the canvas')).toBeInTheDocument();
    const plans = screen.getAllByRole('list', { name: 'Plan' });
    expect(plans).toHaveLength(1);
    expect(within(plans[0]).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Find a node', 'Add it']);
    await sendText('And another');
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toMatchObject({ agent: 'personal:fake', sessionId: 'host-1' });
  });

  it('asks before the first personal agent ever starts', async () => {
    apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: false, agents: [FAKE] });
    const socket = await connected();
    await pickFake();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
    await sendText('Hello');
    const warning = await screen.findByRole('dialog', { name: /Before you start Fake Agent/ });
    expect(within(warning).getByText(/own shell, network and file access/)).toBeInTheDocument();
    expect(socket.sent).toHaveLength(0);
    fireEvent.click(within(warning).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog', { name: /Before you start/ })).toBeNull();
    expect(socket.sent).toHaveLength(0);
    await sendText('Hello');
    fireEvent.click(await screen.findByRole('button', { name: 'I understand, start it' }));
    await waitFor(() => expect(apiMocks.acknowledgePersonalAgentWarning).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({ agent: 'personal:fake', message: 'Hello' });
  });

  it('shows a permission card with only Allow once and Deny, and answers with the person token', async () => {
    const socket = await connected();
    await pickFake();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
    await sendText('Run it');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => {
      socket.receive({ type: 'permission_request', requestId: 'r-1', title: 'Run ls', kind: 'execute',
        input: { command: 'ls' }, canAllow: true, timeoutSeconds: 120, source: 'personal' });
    });
    const card = screen.getByRole('group', { name: 'Fake Agent asks permission' });
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['Allow once', 'Deny']);
    expect(within(card).getByText(/No answer in \d+s denies it/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toEqual({ type: 'permission', requestId: 'r-1', decision: 'allow', personToken: TOKEN });
    await act(async () => {
      socket.receive({ type: 'permission_resolved', requestId: 'r-1', outcome: 'allowed', source: 'personal' });
    });
    expect(within(card).getByRole('status')).toHaveTextContent('Allowed once');
    await act(async () => {
      socket.receive({ type: 'permission_request', requestId: 'r-2', title: 'Write a file', kind: 'edit',
        input: {}, canAllow: false, timeoutSeconds: 120, source: 'personal' });
    });
    const second = screen.getAllByRole('group', { name: 'Fake Agent asks permission' })[1];
    expect(within(second).getAllByRole('button').map((b) => b.textContent)).toEqual(['Deny']);
    expect(within(second).getByText(/only offers .always allow./)).toBeInTheDocument();
  });

  it('clears the session when the agent has ended, and /clear closes the live one', async () => {
    const socket = await connected();
    await pickFake();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
    await sendText('First');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => {
      socket.receive({ type: 'session', sessionId: 'host-1', source: 'personal' });
      socket.receive({ type: 'error', code: 'personal_session_ended', message: 'Fake Agent exited (code 3).', source: 'personal' });
      socket.receive({ type: 'done', source: 'personal' });
    });
    await sendText('Second');
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toMatchObject({ sessionId: null });
    await act(async () => {
      socket.receive({ type: 'session', sessionId: 'host-2', source: 'personal' });
      socket.receive({ type: 'done', source: 'personal' });
    });
    await sendText('/clear');
    await waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(socket.sent[2]).toEqual({ type: 'close_session', sessionId: 'host-2', personToken: TOKEN });
  });
});

describe('Settings > Personal agents', () => {
  it('lists agents, switches one on and adds a custom one', async () => {
    apiMocks.updatePersonalAgent.mockResolvedValue({ agent: { ...OFF, enabled: true } });
    apiMocks.createPersonalAgent.mockResolvedValue({ agent: FAKE });
    render(<PersonalAgentsSection />);
    const rows = await screen.findAllByTestId('personal-agent-row');
    expect(rows.map((row) => row.getAttribute('data-agent-id'))).toEqual(['fake', 'gemini']);
    fireEvent.click(screen.getByRole('switch', { name: 'Use Gemini (your setup) in chat' }));
    await waitFor(() => expect(apiMocks.updatePersonalAgent).toHaveBeenCalledWith('gemini', { enabled: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent id' }), { target: { value: 'mine' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent command' }), { target: { value: '/usr/local/bin/mine' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent arguments' }), { target: { value: '--acp  --quiet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(apiMocks.createPersonalAgent).toHaveBeenCalledWith({
      id: 'mine', displayName: undefined, command: '/usr/local/bin/mine', args: ['--acp', '--quiet'] }));
  });
});
