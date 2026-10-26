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
    // Typing /clear is the person's confirmation, so it sends force (the
    // backend refuses to clear a project with nodes without it).
    expect(apiMocks.apiFetch).toHaveBeenCalledWith('/api/graph?force=true', { method: 'DELETE' });
  });
});

describe('A personal agent that offers models', () => {
  it('shows its choices for the conversation and sends the pick with the person token', async () => {
    const socket = await connected();
    await pickFake();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Chat model settings' }), { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: /for this conversation/ })).toBeNull();
    await sendText('Hello');
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => {
      socket.receive({ type: 'session', sessionId: 'host-1', source: 'personal', promptImages: true, options: [
        { id: 'model', name: 'Model', category: 'model', current: 'argon-medium',
          options: [{ value: 'argon-low', name: 'Argon (low)' }, { value: 'argon-medium', name: 'Argon (medium)' }] },
        { id: 'broken' }] });
      socket.receive({ type: 'done', source: 'personal' });
    });
    const select = screen.getByRole('combobox', { name: 'Model for this conversation' }) as HTMLSelectElement;
    expect(select.value).toBe('argon-medium');
    // Its own row under the status line, so the menus never split "· ready · id" across lines.
    expect(select.closest('.chat-panel__meta')).toBeNull();
    expect(select.closest('.chat-panel__personal-options')).not.toBeNull();
    expect(screen.getAllByRole('combobox', { name: /for this conversation/ })).toHaveLength(1);
    fireEvent.change(select, { target: { value: 'argon-low' } });
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toEqual({ type: 'personal_option', sessionId: 'host-1', configId: 'model', value: 'argon-low',
      personToken: TOKEN });
    await act(async () => {
      socket.receive({ type: 'personal_options', sessionId: 'host-1', source: 'personal', error: 'Fake Agent didn\'t switch: busy.',
        options: [{ id: 'model', name: 'Model', category: 'model', current: 'argon-medium',
          options: [{ value: 'argon-low', name: 'Argon (low)' }, { value: 'argon-medium', name: 'Argon (medium)' }] }] });
    });
    expect((screen.getByRole('combobox', { name: 'Model for this conversation' }) as HTMLSelectElement).value).toBe('argon-medium');
    expect(screen.getByText(/didn.t switch: busy/)).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom agent id' }), { target: { value: 'mine' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom agent command' }), { target: { value: '/usr/local/bin/mine' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom agent arguments' }), { target: { value: '--acp  --quiet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(apiMocks.createPersonalAgent).toHaveBeenCalledWith({
      id: 'mine', displayName: undefined, command: '/usr/local/bin/mine', args: ['--acp', '--quiet'] }));
  });
});


describe('Settings > Personal agents: Gemini and Antigravity', () => {
  const GEMINI = { ...OFF, enabled: true, status: 'needs_setup', version: '0.25.2', args: ['--experimental-acp'],
    note: 'Gemini CLI 0.25.2, started with `--experimental-acp`. It signs in with a Google account. Since 2026-06-18 ...',
    keyOption: { enabled: false, keySaved: true, billing: 'Google bills that key for every turn this agent runs.', blocked: null } };
  const ANTIGRAVITY = { ...FAKE, id: 'antigravity', kind: 'preset', displayName: 'Antigravity (your setup)', enabled: false,
    status: 'not_installed', command: 'agy_acp_server.par', note: 'Download first.',
    termsNote: 'Google\'s FAQ says using Antigravity through third-party apps "is not supported under consumer plans". Your Google account carries that risk.',
    install: { state: 'missing', version: '1.4.1', sizeBytes: 112737434, message: 'Download first.',
      source: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip' },
    signIn: { state: 'signed_out' } };

  it('offers the Gemini key off by default, says who bills it, and saves the choice', async () => {
    apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [GEMINI] });
    apiMocks.updatePersonalAgent.mockResolvedValue({ agent: GEMINI });
    render(<PersonalAgentsSection />);
    const option = await screen.findByTestId('personal-agent-key-option');
    const toggle = within(option).getByRole('switch', { name: 'Use my Gemini API key from Nebula' });
    expect(toggle).not.toBeChecked();
    expect(within(option).getByText(/Google bills that key/)).toBeInTheDocument();
    expect(screen.getByText(/2026-06-18/)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(apiMocks.updatePersonalAgent).toHaveBeenCalledWith('gemini', { useNebulaKey: true }));
  });

  it('can not turn the Gemini key on before a key is saved', async () => {
    apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [
      { ...GEMINI, keyOption: { ...GEMINI.keyOption, keySaved: false } }] });
    render(<PersonalAgentsSection />);
    const option = await screen.findByTestId('personal-agent-key-option');
    expect(within(option).getByRole('switch', { name: 'Use my Gemini API key from Nebula' })).toBeDisabled();
    expect(within(option).getByText(/Save a Gemini API key/)).toBeInTheDocument();
  });

  it('shows the terms note and walks download, sign-in and sign-out through the backend', async () => {
    apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [ANTIGRAVITY] });
    apiMocks.antigravityAction.mockResolvedValue({ agent: ANTIGRAVITY });
    render(<PersonalAgentsSection />);
    const panel = await screen.findByTestId('personal-agent-download');
    expect(screen.getByRole('note')).toHaveTextContent('not supported under consumer plans');
    expect(within(panel).getByText(/dl.google.com, pinned to 1.4.1 and checked by SHA-256/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Download 1.4.1 (113 MB)' }));
    await waitFor(() => expect(apiMocks.antigravityAction).toHaveBeenCalledWith('install'));

    cleanup();
    apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [{ ...ANTIGRAVITY,
      status: 'needs_setup', install: { ...ANTIGRAVITY.install, state: 'installed' },
      signIn: { state: 'waiting', job: { state: 'running', message: 'Finish signing in with Google in your browser.',
        signInUrl: 'https://accounts.google.com/o/oauth2/auth?x=1' } } }] });
    render(<PersonalAgentsSection />);
    const waiting = await screen.findByTestId('personal-agent-download');
    expect(within(waiting).getByRole('link', { name: /Open Google.s sign-in page/ }))
      .toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/auth?x=1');
    fireEvent.click(within(waiting).getByRole('button', { name: 'Cancel sign-in' }));
    await waitFor(() => expect(apiMocks.antigravityAction).toHaveBeenCalledWith('cancel-sign-in'));

    cleanup();
    apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [{ ...ANTIGRAVITY,
      status: 'disabled', install: { ...ANTIGRAVITY.install, state: 'installed' }, signIn: { state: 'signed_in' } }] });
    render(<PersonalAgentsSection />);
    const signedIn = await screen.findByTestId('personal-agent-download');
    fireEvent.click(within(signedIn).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(apiMocks.antigravityAction).toHaveBeenCalledWith('sign-out'));
    expect(within(signedIn).getByRole('button', { name: 'Remove download' })).toBeInTheDocument();
  });

  it('follows a download while it runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [{ ...ANTIGRAVITY,
        install: { ...ANTIGRAVITY.install, state: 'downloading',
          job: { state: 'running', message: 'Downloading from dl.google.com…', receivedBytes: 40_000_000, totalBytes: 112737434 } } }] });
      render(<PersonalAgentsSection />);
      expect(await screen.findByText(/40 MB of 113 MB/)).toBeInTheDocument();
      const calls = apiMocks.fetchPersonalAgents.mock.calls.length;
      // The poll starts in an effect after the list renders. Let React run it
      // before the clock moves: run alone, this test moved the clock first and
      // no poll was set yet (0 timers), so it failed every time.
      await act(async () => {});
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await act(async () => { vi.advanceTimersByTime(2100); });
      expect(apiMocks.fetchPersonalAgents.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Review 13, L-7, with GM - Design's round-14 lines (item 2, verbatim): the
// chat's system line after /clear says what happened to the canvas, and stays
// after the notice is gone.
describe('Chat /clear: the system line says what happened to the canvas', () => {
  const systemLine = (text: string) => screen.findByText(text);
  it('the clear went through: the usual line', async () => {
    await connected();
    apiMocks.apiFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await sendText('/clear');
    expect(await systemLine('Session cleared. Next message starts a fresh conversation with an empty canvas.')).toBeInTheDocument();
  });

  it('refused (a 4xx: nothing was removed)', async () => {
    await connected();
    apiMocks.apiFetch.mockResolvedValue(new Response('{"detail":"A run is going."}', { status: 409 }));
    await sendText('/clear');
    expect(await systemLine("Session cleared. Next message starts a fresh conversation. The canvas wasn't cleared.")).toBeInTheDocument();
    expect(screen.queryByText(/with an empty canvas/)).toBeNull();
  });

  it('a server error: it may be partly cleared', async () => {
    await connected();
    apiMocks.apiFetch.mockResolvedValue(new Response('{}', { status: 500 }));
    await sendText('/clear');
    expect(await systemLine('Session cleared. Next message starts a fresh conversation. The canvas may not be fully cleared.')).toBeInTheDocument();
  });

  it('no answer: the same', async () => {
    await connected();
    apiMocks.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await sendText('/clear');
    expect(await systemLine('Session cleared. Next message starts a fresh conversation. The canvas may not be fully cleared.')).toBeInTheDocument();
  });
});
