import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/apiRequest', () => ({ apiRequest }));

import { AgentLog } from './AgentLog';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { receiveSync, usePersonThreadStore } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useGraphStore } from '../../store/graphStore';
import { noteBackendConnection } from '../../lib/backendConnection';
import { RequestFailedError } from '../../lib/errorCopy';
import type { ChannelListener, ThreadRow } from '../../lib/personThread';
import { NOT_CONNECTED_LINE } from '../../lib/personThreadBox';

/** GM - Design r61 on #225: A (the run's fold), B (the locked look's
 * attributes; its CSS is tests/messageBoxLog.r61.test.tsx), 3 (session
 * names) and 4 (answered questions, answering from the composer). */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';
const KEY2 = 'bbbbbbbbbbbb';
const TWO = { key: KEY2, ordinal: 2 };

function listener(over: Partial<ChannelListener> = {}): ChannelListener {
  return {
    listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: { key: KEY, ordinal: 1 }, ...over,
  };
}

function message(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'm1', kind: 'message', at: Date.now() - 5_000, text: 'Make the sky warmer', state: 'accepted',
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

function action(ts: number, line: string) {
  useAgentLogStore.getState().add({ ts, source: 'agent', agent: { id: 'a1', name: 'Claude', color: '#E8825A' }, message: line });
}

/** The thread's items, in order: what each says. */
function threadItems(): string[] {
  const list = screen.getByRole('list', { name: 'Messages with Claude' });
  return [...list.children].map((item) => (item.textContent ?? '').trim());
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

describe('r61 A: the working status row is the run’s fold header', () => {
  it('while working, "› Claude is working · …" is the last row and opens to that run’s actions', () => {
    const at = Date.now() - 5_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 500, line: 'Cooler sky' } } });
    receiveSync('p1', [message({ at })]);
    action(at + 1_000, 'Changed “Prompt”');
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    const header = screen.getByRole('button', { name: 'Claude is working · Cooler sky' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    // No separate "1 action" fold, no status line under the message.
    expect(screen.queryByRole('button', { name: '1 action' })).toBeNull();
    expect(threadItems()).toEqual(['YouMake the sky warmer', 'Claude is working · Cooler sky']);
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(within(header.parentElement!).getByText('Changed “Prompt”')).toBeTruthy();
  });

  it('when the reply lands it settles to "› 1 action" above the reply, still open', () => {
    const at = Date.now() - 5_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 500, line: 'Cooler sky' } } });
    receiveSync('p1', [message({ at })]);
    action(at + 1_000, 'Changed “Prompt”');
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Claude is working · Cooler sky' }));
    act(() => receiveSync('p1', [message({ at }), { id: 'r1', kind: 'reply', at: at + 3_000, text: 'Done.', agent: CLAUDE }]));
    const fold = screen.getByRole('button', { name: '1 action' });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText(/is working/)).toBeNull();
    const items = threadItems();
    expect(items).toHaveLength(3);
    expect(items[0]).toBe('YouMake the sky warmer');
    expect(items[1]).toMatch(/^1 action.*Changed “Prompt”$/);
    expect(items[2]).toBe('ClaudeDone.');
  });

  it('working with nothing folded yet: the status row stands alone as the last row', () => {
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 500, line: 'Cooler sky' } } });
    receiveSync('p1', [message()]);
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.queryByRole('button', { name: /is working/ })).toBeNull();
    expect(threadItems()[threadItems().length - 1]).toBe('Claude is working · Cooler sky');
  });

  it('"Sent" and the held line stay under the message; the run’s actions fold as "N actions"', () => {
    const at = Date.now() - 120_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: at + 1_000, line: 'Cooler sky' } } });
    receiveSync('p1', [message({ at })]);
    action(at + 1_000, 'Changed “Prompt”');
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(threadItems()).toEqual(['YouMake the sky warmerSent', '1 action']);
  });
});

describe('r61 B: the locked composer', () => {
  it('locked: the row is marked locked; the field stays focusable, aria-disabled, described by the line', () => {
    render(<AgentLog />);
    const box = field();
    expect(box.closest('.message-box__field-row')?.hasAttribute('data-locked')).toBe(true);
    expect(box.getAttribute('aria-disabled')).toBe('true');
    expect(describedText(box)).toBe(NOT_CONNECTED_LINE);
    box.focus();
    expect(document.activeElement).toBe(box);
    // The line is outside the dimmed row: it keeps its full strength.
    expect(document.getElementById(box.getAttribute('aria-describedby')!)?.closest('.message-box__field-row')).toBeNull();
  });

  it('ready: not marked locked', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    render(<AgentLog />);
    expect(field().closest('.message-box__field-row')?.hasAttribute('data-locked')).toBe(false);
  });
});

describe('r61 answer 3: a session by its cursor label', () => {
  it('"Waiting for Claude · 2", then "Claude · 2 is working · …"', () => {
    usePersonThreadStore.setState({ listeners: [listener({ listenerId: 'ch_2', sessionKey: KEY2, session: TWO })] });
    receiveSync('p1', [message({ to: { listenerId: 'ch_2', agent: CLAUDE, session: TWO, sessionKey: KEY2 } })]);
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.getByText('Waiting for Claude · 2')).toBeTruthy();
    act(() => usePersonThreadStore.setState({ activity: { [KEY2]: { at: Date.now(), line: 'Cooler sky' } } }));
    expect(screen.getByText('Claude · 2 is working · Cooler sky')).toBeTruthy();
  });

  it('the stopped line names the session; one session is "Claude"; Connect Claude Code stays literal', () => {
    usePersonThreadStore.setState({ listeners: [listener({ state: 'stopped', listenerId: 'ch_2', sessionKey: KEY2, session: TWO })] });
    const { unmount } = render(<AgentLog />);
    expect(describedText(field())).toBe('Claude · 2 stopped listening. Reconnect nebula-listen with /mcp in its terminal to message it here.');
    unmount();
    usePersonThreadStore.setState({ listeners: [listener({ state: 'stopped' })] });
    const second = render(<AgentLog />);
    expect(describedText(field())).toBe('Claude stopped listening. Reconnect nebula-listen with /mcp in its terminal to message it here.');
    second.unmount();
    usePersonThreadStore.setState({ listeners: [] });
    render(<AgentLog />);
    expect(describedText(field())).toBe('Connect Claude Code with the Nebula channel to message it here.');
  });

  it('a send the listener dropped names the session it was for', async () => {
    apiRequest.mockRejectedValueOnce(new RequestFailedError("Couldn't send your message.", 409, { code: 'listener_stopped' }));
    usePersonThreadStore.setState({ listeners: [listener({ listenerId: 'ch_2', sessionKey: KEY2, session: TWO })] });
    render(<AgentLog />);
    fireEvent.change(field(), { target: { value: 'Warmer' } });
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(describedText(field())).toBe('Nebula couldn’t send your message because Claude · 2 stopped listening. Reconnect it in the terminal, then send it again.');
  });
});

function openSet(questions: { id: string; text: string; options: string[]; multiple: boolean; allowText: boolean }[], over: Record<string, unknown> = {}) {
  useAgentQuestionsStore.setState({
    sets: { q1: { answerKey: 'k', view: { id: 'q1', status: 'open', agent: { ...CLAUDE } as never, note: null, projectId: 'p1',
      nodeIds: [], createdAt: 0, closedAt: null, answers: null, questions: questions as never, ...over } as never } },
  });
  receiveSync('p1', [{ id: 'q', kind: 'question', at: Date.now(), questionId: 'q1', agent: CLAUDE, questions }]);
}

describe('r61 answer 4: questions', () => {
  const PALETTE = { id: 'x', text: 'Use the same palette on the other three shots?', options: ['All three', 'Only this one'], multiple: false, allowText: false };

  it('answered: the buttons go, a quiet "You chose “Only this one”." stays', () => {
    openSet([PALETTE], { status: 'answered', answers: [{ questionId: 'x', answered: true, choices: ['Only this one'], text: null }] });
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.queryByRole('button', { name: 'Only this one' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'All three' })).toBeNull();
    expect(screen.getByText('You chose “Only this one”.')).toBeTruthy();
  });

  it('several answers are joined: "You chose “All three” and “Keep 1:1”."', () => {
    openSet([PALETTE, { id: 'y', text: 'Crop?', options: ['Keep 1:1', '16:9'], multiple: false, allowText: false }], {
      status: 'answered',
      answers: [
        { questionId: 'x', answered: true, choices: ['All three'], text: null },
        { questionId: 'y', answered: true, choices: ['Keep 1:1'], text: null },
      ],
    });
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    expect(screen.getByText('You chose “All three” and “Keep 1:1”.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep 1:1' })).toBeNull();
  });

  it('no options: Answer puts the question on the composer; sending answers it, not a message', async () => {
    const question = { id: 'x', text: 'Use the same palette on the other three shots, or keep the warm one for the hero?', options: [], multiple: false, allowText: true };
    openSet([question]);
    // No listener needed: the answer goes to the question.
    useUIStore.setState({ agentLogOpen: true });
    apiRequest.mockResolvedValue({ json: async () => ({ ok: true }) });
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    const box = field();
    expect(document.activeElement).toBe(box);
    const chip = box.closest('.message-box__composer')!.querySelector('.message-box__context--answering')!;
    expect(chip.textContent).toBe(`Answering “${question.text}”`);
    expect(within(chip as HTMLElement).getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(box.getAttribute('aria-disabled')).toBeNull();
    fireEvent.change(box, { target: { value: 'Keep the warm one' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(String(apiRequest.mock.calls[0][1])).toContain('/questions');
    expect(String(apiRequest.mock.calls[0][1])).not.toContain('/thread/messages');
    expect(JSON.parse(apiRequest.mock.calls[0][2].body)).toMatchObject({ answers: [{ questionId: 'x', text: 'Keep the warm one' }] });
    expect(usePersonThreadStore.getState()).toMatchObject({ draft: '', answering: null });
    expect(screen.getByText('You answered “Keep the warm one”.')).toBeTruthy();
  });

  it('Remove drops the chip and keeps the draft; the composer messages Claude again', () => {
    openSet([{ id: 'x', text: 'Which crop?', options: [], multiple: false, allowText: true }]);
    usePersonThreadStore.setState({ listeners: [listener()] });
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    fireEvent.change(field(), { target: { value: 'Square' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText(/^Answering/)).toBeNull();
    expect(usePersonThreadStore.getState()).toMatchObject({ draft: 'Square', answering: null });
  });
});
