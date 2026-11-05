import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/apiRequest', () => ({ apiRequest }));

import { AgentLog } from './AgentLog';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { receiveRows, receiveSync, usePersonThreadStore } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useGraphStore } from '../../store/graphStore';
import { noteBackendConnection } from '../../lib/backendConnection';
import { OFFLINE_LINE_ID } from '../BackendConnectionStatus';
import { RequestFailedError } from '../../lib/errorCopy';
import {
  PIN_SHOW_EVENT,
  UPDATES_OPEN_EVENT,
  type ChannelListener,
  type ThreadRow,
} from '../../lib/personThread';
import {
  COPY_COMMAND,
  HELD_LINE,
  LISTENER_DROPPED_LINE,
  NOT_CONNECTED_LINE,
  SERVER_FAILED_LINE,
  STOPPED_LISTENING_LINE,
} from '../../lib/personThreadBox';
import { expectEveryTryAgainLine } from '../../../tests/helpers/tryAgainLine';

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';
const KEY2 = 'bbbbbbbbbbbb';

function listener(over: Partial<ChannelListener> = {}): ChannelListener {
  return {
    listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: { key: KEY, ordinal: 1 }, ...over,
  };
}

function message(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'm1', kind: 'message', at: Date.now() - 1_000, text: 'Make the sky warmer', state: 'accepted',
    to: { listenerId: 'ch_1', agent: CLAUDE, session: { key: KEY, ordinal: 1 }, sessionKey: KEY }, ...over,
  };
}

function field(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /^Message/ }) as HTMLTextAreaElement;
}

function describedText(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '').split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? `#${id}`).join(' | ');
}

beforeEach(() => {
  window.localStorage.clear();
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false });
  useAgentLogStore.getState().clear();
  usePersonThreadStore.getState().reset();
  useAgentQuestionsStore.getState().reset();
  useGraphStore.setState({ nodes: [], edges: [] });
  apiRequest.mockReset();
  act(() => noteBackendConnection('online'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the composer’s locks (r50)', () => {
  it('no session listening: the line, Copy command, aria-disabled but focusable, the draft kept', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AgentLog />);
    const box = field();
    expect(box.getAttribute('aria-disabled')).toBe('true');
    // GM r89.4: not connected, the product as the lock line names it.
    expect(box.getAttribute('placeholder')).toBe('Message Claude Code');
    expect(box.getAttribute('aria-label')).toBe('Message Claude Code');
    expect(describedText(box)).toBe(NOT_CONNECTED_LINE);
    box.focus();
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Keep me' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // Send reads as off too, and does nothing.
    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sendButton);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(usePersonThreadStore.getState().draft).toBe('Keep me');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy command' })); });
    expect(writeText).toHaveBeenCalledWith(COPY_COMMAND);
    expect(screen.getByText('Copied the command')).toBeTruthy();
  });

  it('the listener stopped: its own line, no button', () => {
    usePersonThreadStore.setState({ listeners: [listener({ state: 'stopped' })] });
    render(<AgentLog />);
    expect(describedText(field())).toBe(STOPPED_LISTENING_LINE);
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull();
  });

  it('offline: the app’s offline row is the describedby, no line of its own', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    render(<AgentLog />);
    act(() => noteBackendConnection('offline'));
    expect(field().getAttribute('aria-disabled')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toBe(OFFLINE_LINE_ID);
  });

  it('ready: the placeholder names the recipient as its cursor does', () => {
    usePersonThreadStore.setState({ listeners: [listener({ session: { key: KEY, ordinal: 2 } })] });
    render(<AgentLog />);
    expect(field().hasAttribute('aria-disabled')).toBe(false);
    expect(field().getAttribute('placeholder')).toBe('Message Claude · 2');
    expect(screen.queryByRole('button', { name: /Choose who gets it/ })).toBeNull();
  });

  it('two listening: a recipient chip lists them, and the pick is the recipient', () => {
    usePersonThreadStore.setState({ listeners: [
      listener(),
      listener({ listenerId: 'ch_2', sessionKey: KEY2, session: { key: KEY2, ordinal: 2 } }),
    ] });
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'To Claude. Choose who gets it' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude · 2' }));
    expect(field().getAttribute('placeholder')).toBe('Message Claude · 2');
    expect(usePersonThreadStore.getState().chosen).toBe('ch_2');
  });
});

describe('sending (r50)', () => {
  it('Enter sends to the recipient with the selected nodes, Shift+Enter doesn’t, and the panel stays closed', async () => {
    apiRequest.mockResolvedValue({ json: async () => ({ row: { id: 'm1', kind: 'message', at: 1, text: 'Warmer', state: 'sent' } }) });
    useGraphStore.setState({ nodes: [{ id: 'n1', position: { x: 0, y: 0 }, selected: true, data: { label: 'Hero shot' } }] as never });
    usePersonThreadStore.setState({ listeners: [listener()] });
    render(<AgentLog />);
    fireEvent.change(field(), { target: { value: 'Warmer' } });
    expect(screen.getByText('About “Hero shot”')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove “Hero shot”' })).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(apiRequest).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    const body = JSON.parse(apiRequest.mock.calls[0][2].body);
    expect(body).toMatchObject({ text: 'Warmer', to: 'ch_1', nodeIds: ['n1'] });
    expect(useUIStore.getState().agentLogOpen).toBe(false);
    expect(field().value).toBe('');
  });

  it('a server that didn’t answer: the because line with a real Try again (the shared ratchet)', async () => {
    apiRequest.mockRejectedValueOnce(new RequestFailedError("Couldn't send your message.", 503));
    usePersonThreadStore.setState({ listeners: [listener()] });
    const { container } = render(<AgentLog />);
    fireEvent.change(field(), { target: { value: 'Warmer' } });
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(field().value).toBe('Warmer');
    expect(describedText(field())).toContain(SERVER_FAILED_LINE);
    const lines = expectEveryTryAgainLine(container, (button) => button.parentElement?.querySelector('span')?.textContent);
    expect(lines).toEqual([SERVER_FAILED_LINE]);
    apiRequest.mockResolvedValueOnce({ json: async () => ({ row: { id: 'm1', kind: 'message', at: 1, text: 'Warmer', state: 'sent' } }) });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(SERVER_FAILED_LINE)).toBeNull();
  });

  it('the listener dropped at send: its line, no button', async () => {
    apiRequest.mockRejectedValueOnce(new RequestFailedError("Couldn't send your message.", 409, { code: 'listener_stopped' }));
    usePersonThreadStore.setState({ listeners: [listener()] });
    render(<AgentLog />);
    fireEvent.change(field(), { target: { value: 'Warmer' } });
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(describedText(field())).toContain(LISTENER_DROPPED_LINE);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('the keys', () => {
  it('"/" focuses the composer from the canvas, not from a text field; Escape blurs it and keeps the draft', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    render(
      <>
        <div className="canvas-wrapper" tabIndex={-1} data-testid="canvas"><button type="button">node</button></div>
        <input aria-label="other" />
        <AgentLog />
      </>,
    );
    const nodeButton = screen.getByRole('button', { name: 'node' });
    nodeButton.focus();
    fireEvent.keyDown(nodeButton, { key: '/' });
    expect(document.activeElement).toBe(field());
    fireEvent.change(field(), { target: { value: 'draft' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(document.activeElement).toBe(nodeButton);
    expect(usePersonThreadStore.getState().draft).toBe('draft');
    const other = screen.getByRole('textbox', { name: 'other' });
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(document.activeElement).toBe(other);
  });
});

describe('the collapsed bar', () => {
  it('previews the latest row with an unread badge, and announces the reply once', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message()]);
    const { container } = render(<AgentLog />);
    act(() => receiveRows('p1', [{ id: 'r1', kind: 'reply', at: Date.now(), text: 'Done. I moved the warm palette.',
      agent: CLAUDE, session: { key: KEY, ordinal: 1 }, sessionKey: KEY }]));
    const preview = container.querySelector('.message-box__preview') as HTMLElement;
    expect(preview.textContent).toContain('Claude');
    expect(preview.textContent).toContain('Done. I moved the warm palette.');
    expect(screen.getByRole('img', { name: '1 unread reply' })).toBeTruthy();
    const live = [...container.querySelectorAll('[aria-live="polite"]')].map((el) => el.textContent);
    expect(live).toContain('Claude replied. Done. I moved the warm palette.');
    // Opening the panel clears the badge.
    fireEvent.click(screen.getByRole('button', { name: 'Agent log', expanded: false }));
    expect(screen.queryByRole('img', { name: /unread/ })).toBeNull();
  });
});

describe('the collapsed bar, GM r94', () => {
  it('an answer on a pin reads "Claude Code replied to your note"', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message()]);
    const { container } = render(<AgentLog />);
    act(() => receiveRows('p1', [{ id: 'pr1', kind: 'pinReply', at: Date.now(), pinId: 'pin1', text: 'Warmed it.',
      agent: { ...CLAUDE, name: 'Claude Code' }, session: { key: KEY, ordinal: 1 }, sessionKey: KEY }]));
    const preview = container.querySelector('.message-box__preview') as HTMLElement;
    expect(preview.querySelector('.message-box__preview-name')!.textContent).toBe('Claude Code');
    expect(preview.querySelector('.message-box__preview-text')!.textContent).toBe('replied to your note');
    expect(preview.textContent).not.toContain('on the canvas');
  });
});

describe('the thread', () => {
  it('folds the actions between messages and opens them in place', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    const at = Date.now() - 5_000;
    receiveSync('p1', [message({ at }), { id: 'r1', kind: 'reply', at: at + 3_000, text: 'Done.', agent: CLAUDE }]);
    for (const [i, line] of ['Added “Sky”', 'Changed “Prompt”', 'Running “Hero shot”'].entries()) {
      useAgentLogStore.getState().add({ ts: at + 1_000 + i, source: 'agent', agent: { id: 'a1', name: 'Claude', color: '#E8825A' }, message: line });
    }
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    const fold = screen.getByRole('button', { name: '3 actions' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(screen.getByText('Changed “Prompt”')).toBeTruthy();
  });

  it('shows a held message’s neutral line, with no button', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message({ state: 'held' })]);
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.getByText(HELD_LINE)).toBeTruthy();
    expect(screen.getByText(HELD_LINE).closest('.message-box__status')?.querySelector('button')).toBeNull();
  });

  it('a lapsed row says it will get the message if it reconnects, and never offers a resend; the dropped one does', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message({ state: 'sent', lapsed: true })]);
    useUIStore.setState({ agentLogOpen: true });
    const { container } = render(<AgentLog />);
    const line = 'Claude stopped listening. It’ll get this message if it reconnects from the same terminal.';
    const box = screen.getByText(line).closest('.message-box__status');
    expect(box?.querySelector('button')).toBeNull();
    expect(container.querySelector('.message-box__status--lapsed')).not.toBeNull();
    expect(container.textContent ?? '').not.toMatch(/send it again|try again|resend/i);
    expect(screen.queryByRole('button', { name: /again|resend/i })).toBeNull();
    act(() => receiveRows('p1', [message({ state: 'dropped', rev: 5 })]));
    expect(container.textContent).not.toContain('Claude stopped listening. It’ll');
    expect(screen.getByText(LISTENER_DROPPED_LINE.replace('Claude Code', 'Claude'))).toBeTruthy();
  });

  it('says what the session is doing after the message, and "Waiting for Claude" before', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message()]);
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.getByText('Waiting for Claude')).toBeTruthy();
    act(() => usePersonThreadStore.setState({ activity: { [KEY]: { at: Date.now(), line: 'Changing “Prompt” on “Hero shot”' } } }));
    expect(screen.getByText('Claude is working · Changing “Prompt” on “Hero shot”')).toBeTruthy();
  });

  it('a question answers in one click and is never a spend approval', async () => {
    const send = vi.fn().mockResolvedValue(true);
    useAgentQuestionsStore.setState({
      sets: { q1: { answerKey: 'k', view: { id: 'q1', status: 'open', agent: { ...CLAUDE } as never, note: null, projectId: 'p1',
        nodeIds: [], createdAt: 0, closedAt: null, answers: null,
        questions: [{ id: 'x', text: 'Use the same palette on the other three shots?', options: ['All three', 'Only this one'], multiple: false, allowText: true }] as never } } },
      send,
    });
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [{ id: 'q', kind: 'question', at: Date.now(), questionId: 'q1', agent: CLAUDE,
      questions: [{ id: 'x', text: 'Use the same palette on the other three shots?', options: ['All three', 'Only this one'], multiple: false, allowText: false }] }]);
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.getByText('Claude asks')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Only this one' })); });
    expect(send).toHaveBeenCalledWith('q1');
    expect(useAgentQuestionsStore.getState().drafts.q1?.x?.choices).toEqual(['Only this one']);
    expect(screen.queryByRole('button', { name: /accept|approve/i })).toBeNull();
  });

  it('a proposal, an Update and pins point elsewhere with Show; Accept stays on the card', () => {
    const focus = vi.fn();
    useCanvasProposalsStore.setState({ proposals: { pr1: {} as never }, focus });
    useGraphStore.setState({ nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: { label: 'FLUX.2' } }] as never });
    usePersonThreadStore.setState({ listeners: [listener()] });
    const at = Date.now();
    receiveSync('p1', [
      { id: 'a', kind: 'proposal', at, proposalId: 'pr1', agent: CLAUDE },
      { id: 'b', kind: 'note', at: at + 1, noteId: 'u1', agent: CLAUDE },
      { id: 'c', kind: 'pin', at: at + 2, pinId: 'pin1', nodeId: 'n1', text: 'Warmer here' },
      { id: 'd', kind: 'pinReply', at: at + 3, pinId: 'pin1', nodeId: 'n1', text: 'Done.', agent: CLAUDE },
    ]);
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.getByText('Claude proposed a change')).toBeTruthy();
    expect(screen.getByText('Claude left a note in Updates')).toBeTruthy();
    expect(screen.getByText('You left a note on “FLUX.2”')).toBeTruthy();
    expect(screen.getByText('Claude replied to your note on “FLUX.2”')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(accept|reject)$/i })).toBeNull();
    const shows = screen.getAllByRole('button', { name: 'Show' });
    expect(shows).toHaveLength(4);
    fireEvent.click(shows[0]);
    expect(focus).toHaveBeenCalledWith('pr1');
    const opened = vi.fn();
    const pinned = vi.fn();
    window.addEventListener(UPDATES_OPEN_EVENT, opened);
    window.addEventListener(PIN_SHOW_EVENT, pinned);
    fireEvent.click(shows[1]);
    fireEvent.click(shows[2]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((pinned.mock.calls[0][0] as CustomEvent).detail).toEqual({ pinId: 'pin1' });
    window.removeEventListener(UPDATES_OPEN_EVENT, opened);
    window.removeEventListener(PIN_SHOW_EVENT, pinned);
  });
});
