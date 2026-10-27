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
// Round 12: the clear's answer is bounded; short here so the test waits 60 ms, not 15 s.
vi.mock('../src/lib/chatClear', async (original) => ({
  ...await original<typeof import('../src/lib/chatClear')>(), CHAT_CLEAR_ANSWER_MS: 60,
}));
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: apiMocks.apiFetch,
  backendWebSocketUrl: vi.fn().mockResolvedValue('ws://127.0.0.1/test-chat'),
}));
import { ChatPanel } from '../src/components/panels/ChatPanel';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';
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
  await waitFor(() => expect(apiMocks.apiFetch).toHaveBeenCalledWith('/api/graph?force=true',
    expect.objectContaining({ method: 'DELETE', signal: expect.any(AbortSignal) })));
}

const CONFIRMED = 'Session cleared. Next message starts a fresh conversation with an empty canvas.';
const REFUSED = "Session cleared. Next message starts a fresh conversation. The canvas wasn't cleared.";
const UNCONFIRMED = "Session cleared. Next message starts a fresh conversation. Nebula didn't confirm the canvas was cleared.";
const chatText = () => document.body.textContent || '';

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

// Round 12 of PR #114 (review 11, item 2; GM's lines): the chat clears at
// once, as before; the line comes when the backend answers and is appended,
// never replacing what was said meanwhile; the answer is bounded. Before
// round 12 the DELETE had no bound (no answer: no line ever), and a slow
// answer replaced the list, wiping a message sent while it was out.
describe('/clear while the canvas clear is out (round 12)', () => {
  it('no answer at all: GM\'s "didn\'t confirm" line once the bound passes', async () => {
    clearAnswer = () => new Promise<Response>(() => {});
    await typeClear();
    expect(await screen.findByText(UNCONFIRMED, undefined, { timeout: 2000 })).toBeTruthy();
    expect(chatText()).not.toContain(CONFIRMED);
    expect(document.querySelector('[data-chat-notice]')).toBeNull();
  });

  it('the connection drops: the same line', async () => {
    clearAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
    await typeClear();
    expect(await screen.findByText(UNCONFIRMED)).toBeTruthy();
  });

  it('the backend fails (5xx): it may have cleared, so the same line, not "wasn\'t cleared"', async () => {
    clearAnswer = async () => new Response(JSON.stringify({ detail: 'boom' }), { status: 500 });
    await typeClear();
    expect(await screen.findByText(UNCONFIRMED)).toBeTruthy();
    expect(chatText()).not.toContain(REFUSED);
  });

  it('a message sent while the clear is out stays, and the line comes after it', async () => {
    let release!: (r: Response) => void;
    clearAnswer = () => new Promise<Response>((res) => { release = res; });
    await typeClear();
    const input = screen.getByPlaceholderText('Message…');
    fireEvent.change(input, { target: { value: 'HELLO AFTER CLEAR' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: false }); });
    await waitFor(() => expect(chatText()).toContain('HELLO AFTER CLEAR'), { timeout: 5000 });
    await act(async () => { release(new Response('{}')); });
    await waitFor(() => expect(chatText()).toContain(CONFIRMED), { timeout: 5000 });
    const text = chatText();
    expect(text).toContain('HELLO AFTER CLEAR');
    expect(text.indexOf('HELLO AFTER CLEAR')).toBeLessThan(text.indexOf(CONFIRMED));
  });
});

// Round 13 of PR #114 (review 12, item 4): with no answer or a 5xx the clear
// may have happened, so its undo step stays. Undo is harmless either way:
// it puts back a canvas the clear emptied, and when the clear didn't happen
// it changes nothing and duplicates nothing.
describe('/clear with no answer or a 5xx keeps its undo step (round 13)', () => {
  const n1 = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'kept' }, state: 'idle', outputs: {} } };
  const restores = () => apiMocks.apiFetch.mock.calls.filter(([path]) => String(path).includes('/api/graph/restore'));
  beforeEach(() => {
    useGraphStore.setState({ nodes: [structuredClone(n1)], edges: [], undoStack: [], redoStack: [] } as never);
  });

  for (const [what, answer] of [
    ['a 5xx', async () => new Response(JSON.stringify({ detail: 'boom' }), { status: 500 })],
    ['no answer', () => new Promise<Response>(() => {})],
  ] as const) {
    it(`${what}, and the clear did happen: Undo brings the canvas back`, async () => {
      clearAnswer = answer;
      await typeClear();
      expect(await screen.findByText(UNCONFIRMED, undefined, { timeout: 2000 })).toBeTruthy();
      expect(useGraphStore.getState().undoStack).toHaveLength(1);
      // The clear's sync emptied the canvas (it happened after all).
      act(() => useGraphStore.setState({ nodes: [], edges: [] }));
      act(() => useGraphStore.getState().undo());
      expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
      await waitFor(() => expect(restores()).toHaveLength(1));
    });

    it(`${what}, and the clear didn't happen: Undo is harmless, nothing doubles`, async () => {
      clearAnswer = answer;
      await typeClear();
      expect(await screen.findByText(UNCONFIRMED, undefined, { timeout: 2000 })).toBeTruthy();
      expect(useGraphStore.getState().undoStack).toHaveLength(1);
      act(() => useGraphStore.getState().undo());
      expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
      expect(useGraphStore.getState().nodes[0].data.params.value).toBe('kept');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(restores()).toHaveLength(0);
    });
  }

  it('a refusal (4xx) still takes the step back: the clear surely didn\'t happen', async () => {
    clearAnswer = async () => new Response(JSON.stringify({ detail: 'A run is still going.' }),
      { status: 409, headers: { 'content-type': 'application/json' } });
    await typeClear();
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
  });
});
