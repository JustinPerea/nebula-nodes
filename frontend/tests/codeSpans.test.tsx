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
import { resetCommonsSessionForTests } from '../src/lib/commonsApi';
import { cascaded } from './helpers/cssCascade';
import { LineText } from '../src/components/LineText';
import { withCodeSpans } from '../src/lib/codeSpans';
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

// Design: a `…` span in a chat or error line is inline code: the mono face, no backticks.
const L1 = 'Codex agent is restricted to ChatGPT account login in Nebula. Current Codex auth is API-key billing mode. Use “Connect ChatGPT account” in Nebula, or run `codex logout` then `codex login` without `--with-api-key`.';

function html(text: string) {
  const { container } = render(<p>{withCodeSpans(text)}</p>);
  return container.firstElementChild as HTMLElement;
}
const codes = (el: ParentNode) => [...el.querySelectorAll('code')].map((c) => c.textContent);

describe('withCodeSpans', () => {
  it('turns a pair of backticks into a code element without the backticks', () => {
    const el = html('run `codex logout` now');
    expect(codes(el)).toEqual(['codex logout']);
    expect(el.textContent).toBe('run codex logout now');
    expect(el.querySelector('code')!.className).toBe('code-span');
  });
  it('handles a span at the start and at the end', () => {
    expect(codes(html('`a` b'))).toEqual(['a']);
    expect(html('`a` b').textContent).toBe('a b');
    expect(codes(html('b `a`'))).toEqual(['a']);
    expect(html('b `a`').textContent).toBe('b a');
  });
  it('handles several spans', () => {
    const el = html('`one` and `two` and `three`');
    expect(codes(el)).toEqual(['one', 'two', 'three']);
    expect(el.textContent).toBe('one and two and three');
  });
  it('leaves an unmatched backtick as typed', () => {
    const el = html('a ` b');
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe('a ` b');
    const odd = html('`a` and ` b');
    expect(codes(odd)).toEqual(['a']);
    expect(odd.textContent).toBe('a and ` b');
  });
  it('leaves an empty pair as typed', () => {
    const el = html('a `` b');
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe('a `` b');
  });
  it('leaves triple backticks as they are', () => {
    const el = html('```js\nx\n```');
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe('```js\nx\n```');
  });
  it('does not pair across a line break', () => {
    expect(codes(html('a `b\nc` d'))).toEqual([]);
  });
  it('renders HTML-looking inner text as text', () => {
    const el = html('see `<b>x</b>` and `<img src=x onerror=alert(1)>`');
    expect(codes(el)).toEqual(['<b>x</b>', '<img src=x onerror=alert(1)>']);
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
  });
  it('returns text with no backticks unchanged', () => {
    expect(withCodeSpans('plain words')).toBe('plain words');
    expect(withCodeSpans('a ` b')).toBe('a ` b');
  });
});

describe('quoted names and quote styles', () => {
  it('leaves a dropped file named a`b`.png literal on a code line', () => {
    const el = html('Nebula couldn’t add “a`b`.png” because it is too big.');
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe('Nebula couldn’t add “a`b`.png” because it is too big.');
  });
  it('leaves two names that each hold one backtick literal', () => {
    const text = 'Nebula couldn’t add “a`b.png” or “c`d.png”.';
    const el = html(text);
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe(text);
  });
  it('still pairs a span outside the quotes', () => {
    const el = html('“a`b.png” failed: run `codex login`');
    expect(codes(el)).toEqual(['codex login']);
  });
  it('does not pair GNU-style quotes', () => {
    const text = "cp: cannot stat `a': No such file, see `b'";
    const el = html(text);
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe(text);
  });
  it('leaves a backslash-escaped backtick literal and still pairs a real span after it', () => {
    const el = html('x \\`a\\` y `b` z');
    expect(codes(el)).toEqual(['b']);
    expect(el.textContent).toBe('x \\`a\\` y b z');
    expect(codes(html('only \\`a` here'))).toEqual([]);
  });
  it('a GNU quote around a name with a space or a non-ASCII letter stays literal', () => {
    const mv = "mv: cannot move `my a.png' to `my b.png'";
    const el = html(mv);
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe(mv);
    expect(codes(html("see `café.png' now"))).toEqual([]);
  });
  it('an apostrophe inside a span still pairs', () => {
    expect(codes(html("it `don't` and `echo 'x'`"))).toEqual(["don't", "echo 'x'"]);
  });
  it('an unclosed opening quote protects the rest of a cut line', () => {
    const text = 'Couldn’t add “a`b`.png (cut';
    const el = html(text);
    expect(codes(el)).toEqual([]);
    expect(el.textContent).toBe(text);
  });
});

describe('LineText code spans', () => {
  afterEach(cleanup);
  it('is off by default: backticks stay as typed', () => {
    const { container } = render(<p><LineText text={L1} /></p>);
    expect(codes(container)).toEqual([]);
    expect(container.textContent).toBe(L1);
  });
  it('draws the refusal with three code elements and no backticks', () => {
    const { container } = render(<p><LineText text={L1} code /></p>);
    expect(codes(container)).toEqual(['codex logout', 'codex login', '--with-api-key']);
    expect(container.textContent).not.toContain('`');
    expect(container.textContent).toBe(L1.replaceAll('`', ''));
  });
  it('inside a className span too', () => {
    const { container } = render(<LineText text="run `x`" className="w" code />);
    expect(container.querySelector('span.w code')!.textContent).toBe('x');
  });
  it('leaves children as the surface laid them out', () => {
    const { container } = render(<LineText text="run `x`" className="w">{'run `x`'}</LineText>);
    expect(container.querySelector('code')).toBeNull();
  });
});

describe('chat error line code spans', () => {
  it('draws the refusal in the chat with three code elements and no backticks in its text', async () => {
    render(<ChatPanel />);
    await waitFor(() => expect(ChatSocket.instances).toHaveLength(1));
    const socket = ChatSocket.instances[0];
    await act(async () => socket.open());
    const input = screen.getByPlaceholderText('Message…');
    fireEvent.change(input, { target: { value: 'Make a simple graph' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    await act(async () => { socket.receive({ type: 'error', message: L1 }); socket.receive({ type: 'done' }); });
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.chat__system--error') ?? document.querySelector<HTMLElement>('.chat__system');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(codes(line)).toEqual(['codex logout', 'codex login', '--with-api-key']);
    expect(line.textContent).not.toContain('`');
  });
});

describe('code span styles', () => {
  it('in the Connected apps error line the span keeps the code-span rule: its face, no ligatures, no colour of its own', () => {
    document.body.className = 'app-slava-restraint';
    const { container } = render(<section className="settings-apps"><p className="settings-row__error"><LineText text="Couldn’t update: run `codex login --x`" code /></p></section>);
    const span = container.querySelector('code')!;
    const won = cascaded(span);
    expect(won.get('|font-variant-ligatures')?.value).toBe('none');
    expect(won.get('|font-family')?.selector).toMatch(/code-span/);
    expect(won.get('|color')).toBeUndefined();
    expect(won.get('|font')).toBeUndefined();
    // The neighbouring rule still styles a plain code element in that panel.
    const plain = render(<section className="settings-apps"><code>x</code></section>).container.querySelector('code')!;
    expect(cascaded(plain).get('|font')?.selector).toMatch(/settings-apps code/);
  });
});
