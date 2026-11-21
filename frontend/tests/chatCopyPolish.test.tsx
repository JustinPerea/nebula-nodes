import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The chat copy and polish PR: the status labels under Choose model (and their UI-face class), the Connect
// section's words and buttons, the Stop words, the picker's auth_api_key line, and the shell-aware fallback.

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
import { WHOLE_LINE_CODES, chatErrorLine } from '../src/lib/chatErrorLine';
import { ConnectionLostError, besideButton, isRefusedFallback, refusedFallbackCopy, copyForStatus } from '../src/lib/errorCopy';
import { chatCancellationNotice } from '../src/lib/chatCancellation';
import { uploadFailureCopy } from '../src/lib/commonsApi';

const initialUI = useUIStore.getState();
const STYLES = join(__dirname, '..', 'src', 'styles');
const css = (name: string) => readFileSync(join(STYLES, name), 'utf8');

const catalog = (agent: 'claude' | 'codex', claudeMode = 'claudeai') => ({
  agent, status: 'ready', auth: { mode: agent === 'claude' ? claudeMode : 'chatgpt' },
  catalog: { source: 'test', runtimeVersion: 'test', fetchedAt: '2026-10-22T12:00:00Z' },
  models: [{ id: `${agent}-m`, label: `${agent} model`, isDefault: true, defaultEffort: 'medium', supportedEfforts: [{ id: 'medium', label: 'Medium' }] }],
});

class ChatTestSocket extends WebSocket {
  static instances: ChatTestSocket[] = [];
  constructor(url: string | URL) { super(url); ChatTestSocket.instances.push(this); }
  sent: Record<string, unknown>[] = [];
  open() {
    Object.defineProperty(this, 'readyState', { value: WebSocket.OPEN, writable: true, configurable: true });
    this.onopen?.call(this, new Event('open'));
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(event: unknown) { this.onmessage?.call(this, new MessageEvent('message', { data: JSON.stringify(event) })); }
}

beforeEach(() => {
  vi.clearAllMocks();
  ChatTestSocket.instances = [];
  vi.stubGlobal('WebSocket', ChatTestSocket);
  window.localStorage.clear();
  useUIStore.setState(initialUI, true);
  useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: true } } }));
  apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: false, agents: [] });
  apiMocks.fetchChatModels.mockImplementation(async (agent: 'claude' | 'codex') => catalog(agent));
});

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).nebulaDesktop;
});

const claude = (over: object = {}) => ({ installed: true, loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: null, message: 'ok', ...over });
const codex = (over: object = {}) => ({ installed: true, loggedIn: true, mode: 'chatgpt', message: 'ok', ...over });
const meta = () => document.querySelector('.chat-panel__meta') as HTMLElement;
const connect = () => document.querySelector('.chat-panel__connect') as HTMLElement;

async function pickCodex() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' })); });
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Codex' })); });
}

describe('the status under Choose model says Claude Code, in the UI face', () => {
  it.each([
    ['still checking', () => apiMocks.fetchClaudeStatus.mockReturnValue(new Promise(() => {})), 'Checking Claude Code…'],
    ['not installed', () => apiMocks.fetchClaudeStatus.mockResolvedValue(claude({ installed: false })), 'Claude Code isn’t installed'],
    ['signed out', () => apiMocks.fetchClaudeStatus.mockResolvedValue(claude({ loggedIn: false })), 'Claude Code needs a sign-in'],
    ['a plan', () => apiMocks.fetchClaudeStatus.mockResolvedValue(claude()), 'Claude Code · Max plan'],
    ['an auth method', () => apiMocks.fetchClaudeStatus.mockResolvedValue(claude({ subscriptionType: null, authMethod: 'token' })), 'Claude Code · token'],
    ['signed in, nothing more', () => apiMocks.fetchClaudeStatus.mockResolvedValue(claude({ subscriptionType: null, authMethod: null })), 'Claude Code · signed in'],
    ['the check failing', () => apiMocks.fetchClaudeStatus.mockRejectedValue(new Error('boom')), 'Nebula couldn’t check Claude Code'],
  ])('%s', async (_name, arrange, label) => {
    arrange();
    render(<ChatPanel />);
    await waitFor(() => expect(meta().textContent).toBe(label));
    // The words are a sentence in the UI face, not mono: their span carries the class the font rule is on.
    expect(meta().querySelector('.chat-panel__status')).not.toBeNull();
  });

  it('the status tooltip names Claude Code', async () => {
    apiMocks.fetchClaudeStatus.mockRejectedValue(new Error('boom'));
    render(<ChatPanel />);
    const [label] = await screen.findAllByText('Nebula couldn’t check Claude Code');
    expect(label.getAttribute('title')).toMatch(/^Nebula couldn’t check Claude Code’s status because /);
  });

  it('Codex’s status is in the same class', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    apiMocks.fetchCodexStatus.mockResolvedValue(codex());
    render(<ChatPanel />);
    await pickCodex();
    await waitFor(() => expect(meta().textContent).toBe('Codex · your ChatGPT plan'));
    expect(meta().querySelector('.chat-panel__status')?.textContent).toBe('Codex · your ChatGPT plan');
  });

  it('the status class is set in the UI face and the session id stays mono', () => {
    const sheet = css('slava-restraint.css');
    const status = /body\.app-slava-restraint \.chat-panel__meta \.chat-panel__status \{([^}]*)\}/.exec(sheet);
    expect(status?.[1]).toMatch(/font-family:\s*var\(--sr-ui\)/);
    const mono = /body\.app-slava-restraint \.chat-panel__meta,\s*body\.app-slava-restraint \.chat-panel__session \{([^}]*)\}/.exec(sheet);
    expect(mono?.[1]).toMatch(/font-family:\s*var\(--sr-mono\)/);
  });
});

describe('the Connect section’s words', () => {
  it('Claude Code: title, and the provider-billing line with its command in a code span', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude({ loggedIn: false }));
    render(<ChatPanel />);
    await waitFor(() => expect(connect().textContent).toContain('Connect Claude Code'));
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    cleanup();
    apiMocks.fetchChatModels.mockImplementation(async (agent: 'claude' | 'codex') => catalog(agent, 'apiKey'));
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude({ loggedIn: false }));
    render(<ChatPanel />);
    await waitFor(() => expect(connect().textContent).toContain('Claude Code is billed to your API key or cloud account, not your Claude plan.'));
    const body = connect().querySelector('.chat-panel__connect-body') as HTMLElement;
    expect(body.firstElementChild?.textContent).toBe('Claude Code is billed to your API key or cloud account, not your Claude plan. Sign in with claude auth login --claudeai to use your plan.');
    expect(body.firstElementChild?.querySelector('code')?.textContent).toBe('claude auth login --claudeai');
    expect(body.textContent).not.toContain('`');
  });

  it('Claude Code connected, with the terminal label above the commands', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    render(<ChatPanel />);
    await waitFor(() => expect(connect().textContent).toContain('Claude Code connected'));
    expect(connect().textContent).not.toMatch(/Connect Claude\b(?! Code)|Claude connected/);
    expect(connect().querySelector('.chat-panel__connect-commands-label')?.textContent).toBe('Run one in a terminal:');
    expect([...connect().querySelectorAll('.chat-panel__connect-commands code')].map((c) => c.textContent))
      .toEqual(['claude auth login --claudeai', 'claude auth login --console', 'claude auth status']);
  });

  it('the backend offline: the port, and the command below, with no terminal label', async () => {
    apiMocks.fetchClaudeStatus.mockRejectedValue(new ConnectionLostError(new TypeError('Failed to fetch')));
    render(<ChatPanel />);
    await waitFor(() => expect(connect().textContent).toMatch(/Nebula’s backend isn’t answering on port \d+\. Start it with the command below\./));
    expect(connect().textContent).not.toMatch(/FastAPI|may already be logged in/);
    expect(connect().querySelector('.chat-panel__connect-commands-label')).toBeNull();
  });

  it('Codex: the detail, the two buttons by their classes, and Use a device code', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    apiMocks.fetchCodexStatus.mockResolvedValue(codex({ loggedIn: false }));
    render(<ChatPanel />);
    await pickCodex();
    await waitFor(() => expect(connect().textContent).toContain('Connect ChatGPT account'));
    expect(connect().textContent).toContain('Nebula opens ChatGPT in your browser so you can sign in, then checks that Codex is connected.');
    const primary = screen.getByRole('button', { name: /Connect ChatGPT account/ });
    const secondary = screen.getByRole('button', { name: 'Use a device code' });
    expect(primary.className).toContain('chat-panel__connect-btn--primary');
    expect(secondary.className).toContain('chat-panel__connect-btn');
    expect(secondary.className).not.toContain('--primary');
    expect(screen.queryByRole('button', { name: 'Device code' })).toBeNull();
    expect(connect().querySelector('.chat-panel__connect-commands-label')?.textContent).toBe('Or run one in a terminal:');
  });

  it('Codex on an API key says it is billed to the key and to use Connect ChatGPT account', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    apiMocks.fetchCodexStatus.mockResolvedValue(codex({ mode: 'api' }));
    render(<ChatPanel />);
    await pickCodex();
    await waitFor(() => expect(connect().textContent).toContain('Codex is billed to your API key, not your ChatGPT plan. Use Connect ChatGPT account to use your plan.'));
  });

  it('the buttons are the proposal bar’s through shared --sr-button-* tokens, with its hover, focus and disabled states', () => {
    const sheet = css('slava-restraint.css');
    const proposals = css('canvasProposals.css');
    const rule = (text: string, selector: string) => {
      const found = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(text);
      expect(found, selector).not.toBeNull();
      return found![1];
    };
    const secondary = rule(sheet, 'body.app-slava-restraint .chat-panel__connect-btn');
    const primary = rule(sheet, 'body.app-slava-restraint .chat-panel__connect-btn--primary');
    // Every visual value is a shared token, none a copied value.
    for (const text of [secondary, primary]) expect(text).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    for (const token of ['--sr-button-height', '--sr-button-pad-x', '--sr-button-edge', '--sr-button-radius', '--sr-button-fill', '--sr-button-ink']) {
      expect(secondary, token).toContain(`var(${token})`);
      expect(rule(proposals, '.proposal-bar__button'), token).toContain(`var(${token},`);
    }
    for (const token of ['--sr-button-primary-fill', '--sr-button-primary-ink']) {
      expect(primary, token).toContain(`var(${token})`);
      expect(rule(proposals, '.proposal-bar__button--primary'), token).toContain(`var(${token},`);
    }
    expect(rule(sheet, 'body.app-slava-restraint .chat-panel__connect-btn:hover:not(:disabled)')).toContain('var(--sr-button-fill-hover)');
    expect(rule(sheet, 'body.app-slava-restraint .chat-panel__connect-btn--primary:hover:not(:disabled)')).toContain('var(--sr-button-primary-fill-hover)');
    expect(rule(sheet, 'body.app-slava-restraint .chat-panel__connect-btn:focus-visible')).toContain('var(--sr-focus-outline)');
    // The disabled look is the app's one grey (styles/disabled-buttons.css): no rule of the button's own, no opacity.
    expect(sheet).not.toMatch(/\.chat-panel__connect-btn(?:--primary)?:disabled/);
    expect(css('panels.css')).not.toMatch(/\.chat-panel__connect-btn[^{]*\{[^}]*(?:opacity|border:|padding:)/);
    const shared = css('disabled-buttons.css');
    // Filled list (Connect, like the proposal bar's Accept) and ghost list (Use a device code, like Show).
    const lists = [...shared.matchAll(/:is\(([^)]*)\):is\(:disabled/g)].map((m) => m[1]);
    expect(lists.filter((l) => /\.chat-panel__connect-btn--primary\b/.test(l)).every((l) => /\.proposal-bar__button--primary\b/.test(l))).toBe(true);
    expect(lists.filter((l) => /\.chat-panel__connect-btn--primary\b/.test(l))).toHaveLength(2);
    expect(lists.filter((l) => /\.chat-panel__connect-btn(?![\w-])/.test(l))).toHaveLength(2);
    // The tokens themselves are defined once, in the palette block.
    expect(sheet.match(/--sr-button-fill: /g)).toHaveLength(1);
    expect(proposals).not.toMatch(/--sr-button-fill: /);
  });
});

describe('Stop says Stopping and Stopped', () => {
  it('the notices', () => {
    expect(chatCancellationNotice('requested')).toEqual({ text: 'Stopping…' });
    expect(chatCancellationNotice('confirmed')).toEqual({ text: 'Stopped.' });
  });

  it('the Stop button’s label and tooltip while the stop is waiting', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    render(<ChatPanel />);
    await waitFor(() => expect(ChatTestSocket.instances).toHaveLength(1));
    const socket = ChatTestSocket.instances[0];
    await act(async () => socket.open());
    const input = screen.getByPlaceholderText('Message…');
    fireEvent.change(input, { target: { value: 'Hello' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: false }); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Stop response' })); });
    const stopping = await screen.findByRole('button', { name: 'Stopping' });
    expect(stopping).toHaveAttribute('title', 'Waiting for the reply to stop');
    expect(screen.queryByRole('button', { name: /Cancellation requested/ })).toBeNull();
  });

  it('a tool still running when Stop is confirmed reads "stopped", not "canceled"', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    render(<ChatPanel />);
    await waitFor(() => expect(ChatTestSocket.instances).toHaveLength(1));
    const socket = ChatTestSocket.instances[0];
    await act(async () => socket.open());
    const input = screen.getByPlaceholderText('Message…');
    fireEvent.change(input, { target: { value: 'Hello' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: false }); });
    await act(async () => socket.receive({ type: 'tool_use', toolUseId: 't1', tool: 'Bash', input: { command: 'ls' } }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Stop response' })); });
    await act(async () => socket.receive({ type: 'cancellation', status: 'confirmed' }));
    await act(async () => { fireEvent.click(await screen.findByText('Bash')); });
    expect(document.querySelector('.chat__tool-output')?.textContent).toBe('(stopped before this tool returned)');
  });

  it('the terminal label says "Or" only beside a button: Claude Code has none, Codex has two', async () => {
    apiMocks.fetchClaudeStatus.mockResolvedValue(claude());
    apiMocks.fetchCodexStatus.mockResolvedValue(codex({ loggedIn: false }));
    render(<ChatPanel />);
    await waitFor(() => expect(connect().querySelector('.chat-panel__connect-commands-label')?.textContent).toBe('Run one in a terminal:'));
    expect(connect().querySelector('button.chat-panel__connect-btn')).toBeNull();
    await pickCodex();
    await waitFor(() => expect(connect().querySelector('.chat-panel__connect-commands-label')?.textContent).toBe('Or run one in a terminal:'));
    expect(connect().querySelectorAll('button.chat-panel__connect-btn')).toHaveLength(2);
  });

  it('the status words are weight 500 in the UI face (thin 10px text), and the session id stays mono', () => {
    const sheet = css('slava-restraint.css');
    const status = /body\.app-slava-restraint \.chat-panel__meta \.chat-panel__status \{([^}]*)\}/.exec(sheet);
    expect(status?.[1]).toMatch(/font-weight:\s*500/);
    const mono = /body\.app-slava-restraint \.chat-panel__meta,\s*body\.app-slava-restraint \.chat-panel__session \{([^}]*)\}/.exec(sheet);
    expect(mono?.[1]).toMatch(/font-family:\s*var\(--sr-mono\)/);
    expect(mono?.[1]).not.toMatch(/font-weight/);
  });
});

describe('Codex on an API key, end to end in the frontend', () => {
  it('auth_api_key is a whole line, shown as sent', () => {
    expect(WHOLE_LINE_CODES.has('auth_api_key')).toBe(true);
    const line = 'Codex is billed to your API key, so Nebula can’t list its ChatGPT models. Use Connect ChatGPT account above the message box, then send again.';
    expect(chatErrorLine({ message: line, code: 'auth_api_key', agentName: 'Codex' }))
      .toEqual({ text: line, tone: 'error' });
  });

  it('the picker’s line ends "try again", so it already sits right beside the Try again button', () => {
    const line = 'Codex is billed to your API key, so Nebula can’t list its ChatGPT models. Use Connect ChatGPT account above the message box, then try again.';
    expect(besideButton(line)).toBe(line);
    const timeout = 'Claude Code took too long to list its models. Try again in a moment.';
    expect(besideButton(timeout)).toBe(timeout);
  });
});

describe('the refusal fallback follows the shell', () => {
  const BROWSER = 'Try again, or reload the page if it keeps happening.';
  const APP = 'Try again, or choose View > Reload if it keeps happening.';

  it('says reload the page in a browser', () => {
    expect(refusedFallbackCopy()).toBe(BROWSER);
    expect(copyForStatus(400, undefined)).toBe(BROWSER);
  });

  it('says View > Reload in a stubbed desktop shell, through every reader', async () => {
    Object.defineProperty(window, 'nebulaDesktop', { value: { apiBaseUrl: 'http://127.0.0.1' }, configurable: true, writable: true });
    expect(refusedFallbackCopy()).toBe(APP);
    expect(copyForStatus(400, undefined)).toBe(APP);
    expect(chatCancellationNotice('failed').text).toBe(`Nebula couldn’t stop the reply because the server didn’t accept it. ${APP}`);
    expect(isRefusedFallback(BROWSER) && isRefusedFallback(APP)).toBe(true);
    expect(isRefusedFallback('Something else.')).toBe(false);
  });

  it('a Commons refusal the backend left the person line out of reads the shell’s line', () => {
    // An upload result with no `person` (the backend leaves out the fallback), and a 422 with an empty detail.
    const result = { filename: 'a.png', ok: false, reason: 'unreadable' };
    expect(uploadFailureCopy(result).reason).toBe(BROWSER);
    expect(copyForStatus(422, '')).toBe(BROWSER);
    Object.defineProperty(window, 'nebulaDesktop', { value: { apiBaseUrl: 'http://127.0.0.1' }, configurable: true, writable: true });
    expect(uploadFailureCopy(result).reason).toBe(APP);
    expect(copyForStatus(422, '')).toBe(APP);
    // A line the backend did send is still shown as it is.
    expect(uploadFailureCopy({ ...result, person: 'That’s too large to save.' }).reason).toBe('That’s too large to save.');
  });

  it('the exact-string match in the status rows recognises both lines', () => {
    const accepted = 'the server didn’t accept it.';
    expect(besideButton(`Nebula couldn’t save it because ${accepted} ${BROWSER}`)).toBe(`Nebula couldn’t save it because ${accepted} Try again.`);
    expect(besideButton(`Nebula couldn’t save it because ${accepted} ${APP}`)).toBe(`Nebula couldn’t save it because ${accepted} Try again.`);
  });
});
