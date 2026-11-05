import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/apiRequest', () => ({ apiRequest }));

import { AgentLog } from './AgentLog';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { activityLine, noteActivity, receiveRows, receiveSync, usePersonThreadStore } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useGraphStore } from '../../store/graphStore';
import { noteBackendConnection } from '../../lib/backendConnection';
import { RequestFailedError } from '../../lib/errorCopy';
import type { AgentPresenceEvent } from '../../lib/wsClient';
import type { ChannelListener, ThreadRow } from '../../lib/personThread';
import { QUESTION_CLOSED_LINE, foldActions, withdrawnLine } from '../../lib/personThreadBox';

/** GM r79 on #225 (items 1-6) and review 1's frontend LOWs. */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';
const SESSION = { key: KEY, ordinal: 1 };
const PICK = { id: 'x', text: 'Use the same palette on the other three shots?', options: ['All three', 'Only this one'], multiple: false, allowText: false };
const TYPED = { id: 'x', text: 'Which palette for the hero?', options: [], multiple: false, allowText: true };
const TERSE = /\b(?:changed|moved) \d/;

function listener(over: Partial<ChannelListener> = {}): ChannelListener {
  return { listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: SESSION, ...over };
}

function message(over: Partial<ThreadRow> = {}): ThreadRow {
  return { id: 'm1', kind: 'message', at: Date.now() - 5_000, text: 'Make the sky warmer', state: 'accepted',
    to: { listenerId: 'ch_1', agent: CLAUDE, session: SESSION, sessionKey: KEY }, ...over };
}

function reply(at: number, over: Partial<ThreadRow> = {}): ThreadRow {
  return { id: `r${at}`, kind: 'reply', at, text: 'Warmer now. I moved the sun too.', nodeId: 'n1', agent: CLAUDE,
    session: SESSION, sessionKey: KEY, ...over };
}

function questionRow(id: string, at: number, questions: unknown[], over: Partial<ThreadRow> = {}): ThreadRow {
  return { id: `row-${id}`, kind: 'question', at, questionId: id, agent: CLAUDE, session: SESSION, sessionKey: KEY,
    questions: questions as never, ...over };
}

function setView(id: string, questions: unknown[], over: Record<string, unknown> = {}) {
  return { id, status: 'open', agent: { ...CLAUDE } as never, note: null, projectId: 'p1', nodeIds: [], createdAt: 0,
    closedAt: null, answers: null, questions: questions as never, ...over } as never;
}

function action(ts: number, line: string) {
  useAgentLogStore.getState().add({ ts, source: 'agent', agent: { id: 'a1', name: 'Claude', color: '#E8825A' }, message: line });
}

function threadItems(): string[] {
  const list = screen.getByRole('list', { name: 'Messages with Claude' });
  return [...list.children].map((item) => (item.textContent ?? '').trim());
}

function field(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /^Message/ }) as HTMLTextAreaElement;
}

function describedText(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '').split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' | ');
}

function presence(over: Partial<AgentPresenceEvent>): AgentPresenceEvent {
  return { type: 'agentPresence', agent: { id: 'a1', name: 'Claude', color: '#E8825A' } as never, action: 'move',
    say: '', at: Date.now(), session: SESSION as never, ...over } as AgentPresenceEvent;
}

/** The thread scrolled up, as the person reads further back. */
function scrollUp() {
  const thread = document.querySelector<HTMLElement>('.message-box__thread')!;
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 200 });
  thread.scrollTop = 100;
  fireEvent.scroll(thread);
}

beforeEach(() => {
  window.localStorage.clear();
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true });
  useAgentLogStore.getState().clear();
  usePersonThreadStore.getState().reset();
  useAgentQuestionsStore.getState().reset();
  useGraphStore.setState({ nodes: [], edges: [] });
  apiRequest.mockReset();
  act(() => noteBackendConnection('online'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('r79.1: a reply’s own cursor say is never an action', () => {
  it('foldActions leaves the echo out; another say from the session still folds', () => {
    const at = 10_000;
    const rows = [message({ at: 1_000 }), reply(at)];
    const echo = { id: 'e1', ts: at + 40, message: 'Warmer now.', agent: { id: 'a1', name: 'Claude' } };
    const real = { id: 'e2', ts: at + 50, message: 'Changed “Prompt”', agent: { id: 'a1', name: 'Claude' } };
    expect(foldActions(rows, [echo]).map((item) => item.kind)).toEqual(['row', 'row']);
    expect(foldActions(rows, [echo, real]).map((item) => item.kind)).toEqual(['row', 'row', 'actions']);
    // Another agent's say, or one too late, is an action.
    expect(foldActions(rows, [{ ...echo, agent: { id: 'a2', name: 'Codex' } }]).map((item) => item.kind)).toEqual(['row', 'row', 'actions']);
    expect(foldActions(rows, [{ ...echo, ts: at + 60_000 }]).map((item) => item.kind)).toEqual(['row', 'row', 'actions']);
  });

  it('a node-anchored reply leaves no trailing fold, and never becomes the working line; the Agent log keeps it', () => {
    const at = Date.now() - 5_000;
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message({ at })]);
    action(at + 500, 'Cooler sky');
    receiveRows('p1', [reply(at + 2_000)]);
    noteActivity(presence({ say: 'Warmer now.', did: { verb: 'Replied on', nodeId: 'n1', label: 'Hero' }, at: at + 2_040 }));
    action(at + 2_040, 'Warmer now.');
    render(<AgentLog />);
    const items = threadItems();
    expect(items[items.length - 1]).toContain('Warmer now. I moved the sun too.');
    expect(items.filter((text) => /action/.test(text))).toEqual(['1 action']);
    expect(usePersonThreadStore.getState().activity[KEY]).toBeUndefined();
    expect(useAgentLogStore.getState().entries.map((entry) => entry.message)).toContain('Warmer now.');
  });
});

describe('r79.2: the working line is the say, else the did line, never a terse form', () => {
  it('activityLine', () => {
    expect(activityLine(presence({ say: 'Cooler sky' }))).toBe('Cooler sky');
    expect(activityLine(presence({ say: 'changed 1', log: 'Changed “Prompt” on “Hero shot”' }))).toBe('Changed “Prompt” on “Hero shot”');
    expect(activityLine(presence({ say: 'moved 2', did: { verb: 'Moved', nodeId: 'n1', label: 'Hero shot' } }))).toBe('Moved “Hero shot”');
    expect(activityLine(presence({ say: 'added 1, connected 2', did: { verb: 'Added', nodeId: null, label: null } }))).toBe('Added');
    expect(activityLine(presence({ say: '' }))).toBeNull();
  });

  it('ratchet: "changed N" / "moved N" never render in a thread row', () => {
    const at = Date.now() - 5_000;
    usePersonThreadStore.setState({ listeners: [listener()] });
    receiveSync('p1', [message({ at })]);
    noteActivity(presence({ say: 'changed 1', did: { verb: 'Changed', nodeId: 'n1', label: 'Hero shot' }, at: Date.now() - 200 }));
    action(at + 500, 'Changed “Hero shot”');
    render(<AgentLog />);
    const list = screen.getByRole('list', { name: 'Messages with Claude' });
    expect(list.textContent).toContain('Claude is working · Changed “Hero shot”');
    expect(list.textContent).not.toMatch(TERSE);
  });
});

describe('r79.3: every deliberate wake gets the working fold under it', () => {
  it('a pin note row', () => {
    const at = Date.now() - 5_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 300, line: 'Cooler sky' } } });
    receiveSync('p1', [{ id: 'pin1', kind: 'pin', at, text: 'warmer', pinId: 'pin_1', nodeId: null }]);
    action(at + 800, 'Changed “Prompt”');
    render(<AgentLog />);
    const items = threadItems();
    expect(items[0]).toContain('You left a note');
    expect(items[1]).toBe('Claude is working · Cooler sky');
    expect(document.querySelector('.message-box__fold')?.textContent).toContain('Claude is working');
  });

  it('the question card of an option pick', () => {
    const at = Date.now() - 8_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 300, line: 'Warming all three' } } });
    receiveSync('p1', [questionRow('q1', at, [PICK], { outcome: { status: 'answered', closedAt: at + 1_000,
      answers: [{ questionId: 'x', choices: ['All three'], text: null }] } })]);
    action(at + 2_000, 'Changed “Prompt”');
    render(<AgentLog />);
    const items = threadItems();
    expect(items[0]).toContain('You chose “All three”.');
    expect(items[1]).toBe('Claude is working · Warming all three');
  });

  it('a typed answer’s You row', () => {
    const at = Date.now() - 8_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 300, line: 'Keeping it warm' } } });
    receiveSync('p1', [questionRow('q2', at, [TYPED], { outcome: { status: 'answered', closedAt: at + 1_000,
      answers: [{ questionId: 'x', choices: [], text: 'The warm one' }] } })]);
    render(<AgentLog />);
    const items = threadItems();
    expect(items[1]).toContain('The warm one');  // the You row, from the kept outcome
    expect(items[2]).toBe('Claude is working · Keeping it warm');
  });

  it('a passive wake (an edit) folds as plain "N actions", no working header', () => {
    const at = Date.now() - 8_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 300, line: 'x' } } });
    receiveSync('p1', [message({ at }), reply(at + 1_000, { nodeId: null })]);
    action(at + 3_000, 'Changed “Prompt”');
    render(<AgentLog />);
    expect(threadItems().slice(-1)).toEqual(['1 action']);
  });
});

describe('r79.4: the new-row pill', () => {
  it('names the newest unseen agent row and jumps to it; never for the person’s own rows', () => {
    const at = Date.now() - 50_000;
    receiveSync('p1', [message({ at, state: 'accepted' })]);
    render(<AgentLog />);
    act(() => scrollUp());
    act(() => receiveRows('p1', [message({ id: 'm2', at: at + 1_000, clientId: 'other-tab' })]));
    act(() => receiveRows('p1', [{ id: 'pin9', kind: 'pin', at: at + 2_000, text: 'n', pinId: 'p9' }]));
    expect(document.querySelector('.message-box__pill')).toBeNull();
    act(() => receiveRows('p1', [reply(at + 3_000, { nodeId: null })]));
    expect(screen.getByRole('button', { name: 'New reply' })).toBeTruthy();
    act(() => receiveRows('p1', [questionRow('q9', at + 4_000, [PICK])]));
    const pill = screen.getByRole('button', { name: 'New question' });
    const target = document.querySelector<HTMLElement>('[data-row-id="row-q9"]')!;
    target.scrollIntoView = vi.fn();
    fireEvent.click(pill);
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(document.querySelector('.message-box__pill')).toBeNull();
    act(() => receiveRows('p1', [{ id: 'pr1', kind: 'proposal', at: at + 5_000, agent: CLAUDE, proposalId: 'p' },
      { id: 'n1', kind: 'note', at: at + 6_000, agent: CLAUDE, noteId: 'n' }]));
    expect(screen.getByRole('button', { name: 'New note' })).toBeTruthy();
  });

  it('a narrowing window keeps a bottom-read thread at the bottom (live-ux L2)', () => {
    receiveSync('p1', [message()]);
    render(<AgentLog />);
    const thread = document.querySelector<HTMLElement>('.message-box__thread')!;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 400 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 200 });
    thread.scrollTop = 200;
    fireEvent.scroll(thread);  // at the bottom
    // The rows rewrap: taller content, the browser's scroll lands short of the bottom.
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 438 });
    thread.scrollTop = 200;
    fireEvent.scroll(thread);
    expect(thread.scrollTop).toBe(438);
  });
});

describe('r79.5: the answer is kept with the question', () => {
  it('after a reload with no set in the store, the row reads its outcome; unknown reads closed, no buttons', () => {
    receiveSync('p1', [
      questionRow('q1', 1_000, [PICK], { outcome: { status: 'answered', closedAt: 2_000, answers: [{ questionId: 'x', choices: ['Only this one'], text: null }] } }),
      questionRow('q2', 3_000, [PICK]),
      questionRow('q3', 4_000, [PICK], { outcome: { status: 'withdrawn', closedAt: 5_000, answers: null } }),
    ]);
    render(<AgentLog />);
    expect(screen.getByText('You chose “Only this one”.')).toBeTruthy();
    expect(screen.getAllByText(QUESTION_CLOSED_LINE)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'All three' })).toBeNull();
  });
});

describe('r79.6: withdrawn mid-typing', () => {
  it('the chip goes, the draft stays, the line says what the next send does', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    useAgentQuestionsStore.setState({ sets: { q1: { answerKey: 'k', view: setView('q1', [TYPED]) } } });
    receiveSync('p1', [questionRow('q1', Date.now() - 5_000, [TYPED])]);
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    fireEvent.change(field(), { target: { value: 'the warm one' } });
    act(() => useAgentQuestionsStore.getState().closed('q1', 'withdrawn', null));
    expect(screen.queryByRole('button', { name: 'Stop answering' })).toBeNull();
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).toContain(withdrawnLine());
    expect(withdrawnLine()).toBe('Claude withdrew the question. Send again to post your answer as a message every agent can read.');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('an answer racing the withdrawal is refused: nothing else goes out, the same line', async () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    useAgentQuestionsStore.setState({ sets: { q1: { answerKey: 'k', view: setView('q1', [TYPED]) } } });
    receiveSync('p1', [questionRow('q1', Date.now() - 5_000, [TYPED])]);
    apiRequest.mockRejectedValue(new RequestFailedError('Couldn’t send the answers.', 409,
      { detail: 'These questions are already withdrawn' }));
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    fireEvent.change(field(), { target: { value: 'the warm one' } });
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(String(apiRequest.mock.calls[0][1])).toMatch(/\/questions\/q1\/answer$/);
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).toContain(withdrawnLine());
    expect(useAgentQuestionsStore.getState().errors.q1).toBeUndefined();
    expect(screen.getByText(QUESTION_CLOSED_LINE)).toBeTruthy();
  });
});

describe('review 1 LOWs', () => {
  it('LOW-3: a reply that landed while the socket was down counts as unread', () => {
    useUIStore.setState({ agentLogOpen: false });
    receiveSync('p1', [message()]);
    receiveSync('p1', [message(), reply(Date.now())]);
    expect(usePersonThreadStore.getState().unread).toBe(1);
    expect(usePersonThreadStore.getState().announcement).toBeNull();
    receiveSync('p2', [reply(Date.now(), { id: 'other' })]);
    expect(usePersonThreadStore.getState().unread).toBe(0);
  });

  it('F10/F11: "Answer" from the composer only for one question with no options', () => {
    usePersonThreadStore.setState({ listeners: [listener()] });
    useAgentQuestionsStore.setState({ sets: {
      a: { answerKey: 'k', view: setView('a', [PICK]) },
      b: { answerKey: 'k', view: setView('b', [TYPED, { ...TYPED, id: 'y' }]) },
    } });
    receiveSync('p1', [questionRow('a', 1_000, [PICK]), questionRow('b', 2_000, [TYPED, { ...TYPED, id: 'y' }])]);
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));  // b's: the Agents panel form
    expect(usePersonThreadStore.getState().answering).toBeNull();
    expect(useAgentQuestionsStore.getState().formId).toBe('b');
  });

  it('F12/F6: the You row never raises the pill, and a set shows one You row', () => {
    const at = Date.now() - 50_000;
    const answered = { answerKey: undefined, view: setView('q1', [TYPED], { status: 'answered', closedAt: at + 5_000,
      answers: [{ questionId: 'x', answered: true, choices: [], text: 'warm' }] }) };
    receiveSync('p1', [questionRow('q1', at, [TYPED]), { ...questionRow('q1', at + 1, [TYPED]), id: 'dup' }]);
    render(<AgentLog />);
    act(() => scrollUp());
    act(() => useAgentQuestionsStore.setState({ sets: { q1: answered as never } }));
    expect(document.querySelectorAll('[data-answer]')).toHaveLength(1);
    expect(document.querySelector('.message-box__pill')).toBeNull();
  });

  it('NIT-4: a reply clears only the message it followed and those before it', async () => {
    const { repliedAfter } = await import('../../lib/personThreadBox');
    const first = message({ id: 'a', at: 1_000 });
    const second = message({ id: 'b', at: 2_000 });
    const answer = reply(3_000, { replyTo: 'a' });
    expect(repliedAfter(first, [first, second, answer])).toBe(true);
    expect(repliedAfter(second, [first, second, answer])).toBe(false);
    expect(repliedAfter(second, [first, second, reply(3_000, { replyTo: 'b' })])).toBe(true);
    expect(repliedAfter(first, [first, reply(3_000, { replyTo: null })])).toBe(false);
    expect(repliedAfter(first, [first, reply(3_000)])).toBe(true);  // a row from before round 3
  });

  it('NIT-2: the cut keeps a closing bracket whose opener it keeps', async () => {
    const { cutAtWord } = await import('../../lib/personThreadBox');
    expect(cutAtWord('Use (see n4) for the base, please', (c) => c.length <= 14)).toBe('Use (see n4)…');
    expect(cutAtWord('Hello, world and more', (c) => c.length <= 7)).toBe('Hello…');
  });
});
