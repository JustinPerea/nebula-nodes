import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/apiRequest', () => ({ apiRequest }));

import { AgentLog } from './AgentLog';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { receiveSync, usePersonThreadStore } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useGraphStore } from '../../store/graphStore';
import { noteBackendConnection } from '../../lib/backendConnection';
import type { ChannelListener, ThreadRow } from '../../lib/personThread';
import { answeredLine, answeredQuote } from '../../lib/personThreadBox';

/** GM - Design r70 on #225 (round 2b): 1 (the fold is the same chip working
 * and settled: the same element, the same class, only words and the dot
 * change), the strings ("You answered “…”." cut inside its quotes; the
 * answering chip's × is "Stop answering" and its removal sends a plain
 * message). The CSS and the handle are tests/messageBoxLog.r70.test.tsx. */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const KEY = '0123456789ab';

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

function action(ts: number, line: string) {
  useAgentLogStore.getState().add({ ts, source: 'agent', agent: { id: 'a1', name: 'Claude', color: '#E8825A' }, message: line });
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

describe('r70 1: the working fold is the settled chip', () => {
  it('settling keeps the same element and class; only the words and the breathing dot change', () => {
    const at = Date.now() - 5_000;
    usePersonThreadStore.setState({ listeners: [listener()], activity: { [KEY]: { at: Date.now() - 500, line: 'Cooler sky' } } });
    receiveSync('p1', [message({ at })]);
    action(at + 1_000, 'Changed “Prompt”');
    action(at + 2_000, 'Cooler sky');
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    const working = screen.getByRole('button', { name: 'Claude is working · Cooler sky' });
    const className = working.className;
    expect(className).toBe('message-box__fold');
    expect(working.querySelector('.message-box__breath')).not.toBeNull();
    const item = working.closest('li')!;
    act(() => receiveSync('p1', [message({ at }), { id: 'r1', kind: 'reply', at: at + 3_000, text: 'Done.', agent: CLAUDE }]));
    const settled = screen.getByRole('button', { name: '2 actions' });
    expect(settled).toBe(working);
    expect(settled.className).toBe(className);
    expect(settled.closest('li')).toBe(item);
    expect(settled.querySelector('.message-box__breath')).toBeNull();
    // The row above it is unchanged: nothing is added between them.
    expect(item.previousElementSibling?.textContent).toBe('YouMake the sky warmer');
  });
});

function openSet(questions: { id: string; text: string; options: string[]; multiple: boolean; allowText: boolean }[], over: Record<string, unknown> = {}) {
  useAgentQuestionsStore.setState({
    sets: { q1: { answerKey: 'k', view: { id: 'q1', status: 'open', agent: { ...CLAUDE } as never, note: null, projectId: 'p1',
      nodeIds: [], createdAt: 0, closedAt: null, answers: null, questions: questions as never, ...over } as never } },
  });
  receiveSync('p1', [{ id: 'q', kind: 'question', at: Date.now(), questionId: 'q1', agent: CLAUDE, questions }]);
}

describe('r70 strings', () => {
  it('"You answered “…”." keeps the closing quote and full stop outside the cut words', () => {
    const long = 'Keep the warm one for the hero, and use the cooler palette on the other three shots, all of them';
    const parts = answeredQuote([{ choices: [], text: `  ${long}\n` }])!;
    expect(parts).toEqual({ before: 'You answered “', words: long, after: '”.' });
    expect(parts.before + parts.words + parts.after).toBe(answeredLine([{ choices: [], text: long }]));
    expect(answeredQuote([{ choices: [], text: 'A' }, { choices: [], text: 'B' }])!.words).toBe('A” and “B');
    expect(answeredQuote([{ choices: ['Only this one'], text: null }])).toBeNull();
    expect(answeredQuote([{ choices: [], text: ' ' }])).toBeNull();
  });

  it('the typed answer’s row: the words in their own cut span, the quotes outside it', () => {
    openSet([{ id: 'x', text: 'Which crop?', options: [], multiple: false, allowText: true }],
      { status: 'answered', answers: [{ questionId: 'x', answered: true, choices: [], text: 'Square, please' }] });
    useUIStore.setState({ agentLogOpen: true });
    render(<AgentLog />);
    const line = screen.getByText((_, el) => el?.classList.contains('message-box__answered') === true && el.textContent === 'You answered “Square, please”.');
    expect(line.classList.contains('message-box__answered--typed')).toBe(true);
    expect(line.querySelector('.message-box__answered-words')!.textContent).toBe('Square, please');
  });

  it('the × is "Stop answering"; with the chip gone, the words go as a plain message', async () => {
    openSet([{ id: 'x', text: 'Which crop?', options: [], multiple: false, allowText: true }]);
    usePersonThreadStore.setState({ listeners: [listener()] });
    useUIStore.setState({ agentLogOpen: true });
    apiRequest.mockResolvedValue({ json: async () => ({ row: { id: 'm9', kind: 'message', at: Date.now(), text: 'Square', state: 'sent' } }) });
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    fireEvent.change(field(), { target: { value: 'Square' } });
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop answering' }));
    expect(screen.queryByText(/^Answering/)).toBeNull();
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(String(apiRequest.mock.calls[0][1])).toBe('/api/canvas/thread/messages');
    expect(JSON.parse(apiRequest.mock.calls[0][2].body)).toMatchObject({ text: 'Square', to: 'ch_1' });
    expect(useAgentQuestionsStore.getState().sets.q1.view.status).toBe('open');
  });
});
