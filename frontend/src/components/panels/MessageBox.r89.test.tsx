import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/apiRequest', () => ({ apiRequest }));

import { AgentLog } from './AgentLog';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { noteActivity, receiveRows, receiveSync, replyAnnouncement, usePersonThreadStore } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useGraphStore } from '../../store/graphStore';
import { noteBackendConnection } from '../../lib/backendConnection';
import { RequestFailedError } from '../../lib/errorCopy';
import { countsAsReply, type ChannelListener, type ThreadRow } from '../../lib/personThread';
import type { AgentPresenceEvent } from '../../lib/wsClient';
import {
  ANSWERED_ELSEWHERE_LINE,
  CLOSED_ELSEWHERE_LINE,
  GONE_ELSEWHERE_LINE,
  NEW_REPLY_PILL,
  NOT_CONNECTED_LINE,
  pillFor,
  withdrawnLine,
} from '../../lib/personThreadBox';

/** GM r89 on #225 review 2 (items 1, 3, 4, 5) and review 2's LOW-3 and LOW-4 (F4, F5, F13). */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const CLAUDE_CODE = { ...CLAUDE, name: 'Claude Code' };
const KEY = '0123456789ab';
const SESSION = { key: KEY, ordinal: 1 };
const TYPED = { id: 'x', text: 'Which palette for the hero?', options: [], multiple: false, allowText: true };
const MESSAGES = '/api/canvas/thread/messages';

function listener(over: Partial<ChannelListener> = {}): ChannelListener {
  return { listenerId: 'ch_1', sessionKey: KEY, agent: CLAUDE, state: 'listening', reason: null, projectId: 'p1',
    since: 100, seenAt: 100, session: SESSION, ...over };
}

function questionRow(id: string, at: number): ThreadRow {
  return { id: `row-${id}`, kind: 'question', at, questionId: id, agent: CLAUDE, session: SESSION, sessionKey: KEY,
    questions: [TYPED] as never };
}

function setView(id: string, over: Record<string, unknown> = {}) {
  return { id, status: 'open', agent: { ...CLAUDE } as never, note: null, projectId: 'p1', nodeIds: [], createdAt: 0,
    closedAt: null, answers: null, questions: [TYPED] as never, ...over } as never;
}

/** One row of each kind, new to the store, at `at`. */
function rowsOfEveryKind(at: number): ThreadRow[] {
  return [
    { id: 'k-message', kind: 'message', at, text: 'mine', clientId: 'other-tab' },
    { id: 'k-reply', kind: 'reply', at: at + 1, text: 'Done.', agent: CLAUDE, session: SESSION, sessionKey: KEY },
    { id: 'k-question', kind: 'question', at: at + 2, questionId: 'qx', agent: CLAUDE, questions: [TYPED] as never },
    { id: 'k-proposal', kind: 'proposal', at: at + 3, agent: CLAUDE, proposalId: 'p' },
    { id: 'k-note', kind: 'note', at: at + 4, agent: CLAUDE, noteId: 'n' },
    { id: 'k-pin', kind: 'pin', at: at + 5, text: 'warmer', pinId: 'pin_1' },
    { id: 'k-pinReply', kind: 'pinReply', at: at + 6, text: 'Warmed it.', pinId: 'pin_1', agent: CLAUDE, session: SESSION, sessionKey: KEY },
  ];
}

function field(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /^Message/ }) as HTMLTextAreaElement;
}

function describedText(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '').split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' | ');
}

/** The composer's polite live regions, as one string. */
function spoken(): string {
  return [...document.querySelectorAll('.message-box__composer [aria-live="polite"]')].map((el) => el.textContent ?? '').join(' | ');
}

function messagePosts(): unknown[][] {
  return apiRequest.mock.calls.filter((call) => call[1] === MESSAGES);
}

function presence(over: Partial<AgentPresenceEvent>): AgentPresenceEvent {
  return { type: 'agentPresence', agent: { id: 'a1', name: 'Claude', color: '#E8825A' } as never, action: 'move',
    say: '', at: Date.now(), session: SESSION as never, ...over } as AgentPresenceEvent;
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

describe('r89.1: the pill, the badge and the announcement agree on what counts as a reply', () => {
  it('panel closed: a reply and a pin answer count and are spoken; the person’s echo, a pin, a question, a proposal, a note don’t (F5)', () => {
    useUIStore.setState({ agentLogOpen: false });
    receiveSync('p1', [{ id: 'm0', kind: 'message', at: 1, text: 'hi' }]);
    const store = usePersonThreadStore.getState;
    for (const row of rowsOfEveryKind(1_000)) {
      const before = store().unread;
      const spokenBefore = store().announcement;
      receiveRows('p1', [row]);
      const counted = store().unread - before;
      const announced = store().announcement !== spokenBefore;
      expect(counted, row.kind).toBe(countsAsReply(row) ? 1 : 0);
      expect(announced, row.kind).toBe(countsAsReply(row));
      expect(pillFor(row) === NEW_REPLY_PILL, row.kind).toBe(countsAsReply(row));
    }
    expect(store().unread).toBe(2);
    expect(store().announcement?.text).toBe('Claude replied. Warmed it.');
    expect(replyAnnouncement(rowsOfEveryKind(0)[6])).toBe('Claude replied. Warmed it.');
  });

  it('a socket drop: a missed pin answer counts too, a missed pin or question doesn’t', () => {
    useUIStore.setState({ agentLogOpen: false });
    receiveSync('p1', [{ id: 'm0', kind: 'message', at: 1, text: 'hi' }]);
    receiveSync('p1', [{ id: 'm0', kind: 'message', at: 1, text: 'hi' }, ...rowsOfEveryKind(1_000)]);
    expect(usePersonThreadStore.getState().unread).toBe(2);
  });

  it('F4: replies a sync brings while the panel is open are read, never unread', () => {
    useUIStore.setState({ agentLogOpen: true });
    receiveSync('p1', [{ id: 'm0', kind: 'message', at: 1, text: 'hi' }]);
    receiveSync('p1', [{ id: 'm0', kind: 'message', at: 1, text: 'hi' }, ...rowsOfEveryKind(1_000)]);
    expect(usePersonThreadStore.getState().unread).toBe(0);
  });

  it('the thread’s pill reads "New reply" for a pin answer', () => {
    const at = Date.now() - 50_000;
    receiveSync('p1', [{ id: 'm0', kind: 'message', at, text: 'hi', state: 'accepted' }]);
    render(<AgentLog />);
    const thread = document.querySelector<HTMLElement>('.message-box__thread')!;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 200 });
    thread.scrollTop = 100;
    act(() => { fireEvent.scroll(thread); });
    act(() => receiveRows('p1', [rowsOfEveryKind(at + 1_000)[6]]));
    expect(screen.getByRole('button', { name: 'New reply' })).toBeTruthy();
  });
});

describe('review 2, LOW-3: a reply’s own say never becomes the working line, double spaces too', () => {
  it('"Made  it warmer. Next." and its say "Made it warmer."', () => {
    receiveSync('p1', [{ id: 'r1', kind: 'reply', at: 1_000, text: 'Made  it warmer. Next.', nodeId: 'n1', agent: CLAUDE,
      session: SESSION, sessionKey: KEY }]);
    noteActivity(presence({ say: 'Made it warmer.', did: { verb: 'Replied on', nodeId: 'n1', label: 'Hero' }, at: 1_040 }));
    expect(usePersonThreadStore.getState().activity[KEY]).toBeUndefined();
    // Another say is still the working line.
    noteActivity(presence({ say: 'Cooler sky', at: 1_100 }));
    expect(usePersonThreadStore.getState().activity[KEY]?.line).toBe('Cooler sky');
  });
});

describe('r89.3: the question went while the person typed its answer', () => {
  function startAnswering(words = 'the warm one') {
    usePersonThreadStore.setState({ listeners: [listener()] });
    useAgentQuestionsStore.setState({ sets: { q1: { answerKey: 'k', view: setView('q1') } } });
    receiveSync('p1', [questionRow('q1', Date.now() - 5_000)]);
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    fireEvent.change(field(), { target: { value: words } });
    apiRequest.mockResolvedValue({ json: async () => ({ row: { id: 'm1', kind: 'message', at: 1, text: words, state: 'sent' } }) });
  }

  it.each([
    ['answered in another tab', 'answered', ANSWERED_ELSEWHERE_LINE],
    ['closed in another tab', 'dismissed', CLOSED_ELSEWHERE_LINE],
    ['withdrawn', 'withdrawn', withdrawnLine()],
  ] as const)('%s: the chip goes, the draft stays, the line names why; Enter once says it, Enter again posts', async (_, status, line) => {
    startAnswering();
    act(() => useAgentQuestionsStore.getState().closed('q1', status, null));
    expect(screen.queryByRole('button', { name: 'Stop answering' })).toBeNull();
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).toContain(line);
    // The first Enter posts nothing: the line stays and is spoken.
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(0);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).toContain(line);
    expect(spoken()).toContain(line);
    // The next posts the words as a message.
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(1);
    expect(JSON.parse((messagePosts()[0][2] as { body: string }).body)).toMatchObject({ text: 'the warm one', to: 'ch_1' });
    expect(describedText(field())).not.toContain(line);
  });

  it('the Send button holds the same way', async () => {
    startAnswering();
    act(() => useAgentQuestionsStore.getState().closed('q1', 'answered', null));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(messagePosts()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(messagePosts()).toHaveLength(1);
  });

  it('an answer racing another tab’s is refused: its line shows, and the next Enter posts', async () => {
    startAnswering();
    apiRequest.mockRejectedValueOnce(new RequestFailedError('Couldn’t send the answers.', 409,
      { detail: 'These questions are already answered' }));
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).toContain(ANSWERED_ELSEWHERE_LINE);
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(1);
  });

  it('answered here, from the composer: no line, the draft cleared, the next message posts at once', async () => {
    startAnswering();
    apiRequest.mockResolvedValueOnce({ json: async () => ({ ok: true }) });
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(String(apiRequest.mock.calls[0][1])).toMatch(/\/questions\/q1\/answer$/);
    expect(field().value).toBe('');
    expect(usePersonThreadStore.getState().answerGone).toBeNull();
    // The questions socket's own echo, after: still no line.
    act(() => useAgentQuestionsStore.getState().closed('q1', 'answered', null));
    fireEvent.change(field(), { target: { value: 'Now the sky' } });
    expect(describedText(field())).not.toContain(ANSWERED_ELSEWHERE_LINE);
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(1);
  });

  it('answered in this tab’s Agents panel: not "in another tab"', async () => {
    startAnswering();
    apiRequest.mockResolvedValueOnce({ json: async () => ({ ok: true }) });
    await act(async () => {
      useAgentQuestionsStore.getState().setText('q1', 'x', 'from the panel');
      await useAgentQuestionsStore.getState().send('q1');
    });
    expect(screen.queryByRole('button', { name: 'Stop answering' })).toBeNull();
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).not.toContain('another tab');
    expect(usePersonThreadStore.getState().answerGone).toBeNull();
  });

  it('F13 (GM r94.1): a set that dropped out of the store holds the first Enter with a line that claims no cause', async () => {
    startAnswering();
    act(() => useAgentQuestionsStore.getState().synced([]));
    expect(screen.queryByRole('button', { name: 'Stop answering' })).toBeNull();
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).toContain(GONE_ELSEWHERE_LINE);
    expect(describedText(field())).not.toMatch(/another tab|withdrew/);
    // The first Enter posts nothing: the typed answer never goes out on one silent Enter.
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(0);
    expect(spoken()).toContain(GONE_ELSEWHERE_LINE);
    // The second posts it as a message every agent can read.
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(1);
    expect(describedText(field())).not.toContain(GONE_ELSEWHERE_LINE);
  });

  it('F13: an answer whose set went from the store as it was sent holds the same way', async () => {
    startAnswering();
    apiRequest.mockImplementationOnce(async () => {
      useAgentQuestionsStore.getState().synced([]);
      throw new RequestFailedError('Couldn’t send the answers.', 404, { detail: 'No such question' });
    });
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(field().value).toBe('the warm one');
    expect(describedText(field())).toContain(GONE_ELSEWHERE_LINE);
    expect(messagePosts()).toHaveLength(0);
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(1);
  });

  it('a cleared draft is a fresh start: no line, and the next message isn’t held', async () => {
    startAnswering();
    act(() => useAgentQuestionsStore.getState().closed('q1', 'dismissed', null));
    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.change(field(), { target: { value: 'Something else' } });
    expect(describedText(field())).not.toContain(CLOSED_ELSEWHERE_LINE);
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    expect(messagePosts()).toHaveLength(1);
  });
});

describe('r89.4: the field names the agent as its rows and lock line do', () => {
  it('ready, stopped, not connected, offline', () => {
    usePersonThreadStore.setState({ listeners: [listener({ agent: CLAUDE_CODE })] });
    const { unmount } = render(<AgentLog />);
    expect(field().getAttribute('placeholder')).toBe('Message Claude Code');
    expect(field().getAttribute('aria-label')).toBe('Message Claude Code');
    // Stopped: the same label in the field and its line.
    act(() => usePersonThreadStore.setState({ listeners: [listener({ agent: CLAUDE_CODE, state: 'stopped' })] }));
    expect(field().getAttribute('placeholder')).toBe('Message Claude Code');
    expect(describedText(field())).toMatch(/^Claude Code stopped listening\./);
    // Offline: the listener active most recently.
    act(() => noteBackendConnection('offline'));
    expect(field().getAttribute('placeholder')).toBe('Message Claude Code');
    unmount();
    // Not connected: the product, as the lock line names it.
    act(() => noteBackendConnection('online'));
    usePersonThreadStore.setState({ listeners: [] });
    render(<AgentLog />);
    expect(field().getAttribute('placeholder')).toBe('Message Claude Code');
    expect(describedText(field())).toBe(NOT_CONNECTED_LINE);
  });

  it('a session’s number rides along: "Message Claude Code · 2", offline too', () => {
    usePersonThreadStore.setState({ listeners: [listener({ agent: CLAUDE_CODE, session: { key: KEY, ordinal: 2 } })] });
    render(<AgentLog />);
    expect(field().getAttribute('placeholder')).toBe('Message Claude Code · 2');
    act(() => noteBackendConnection('offline'));
    expect(field().getAttribute('placeholder')).toBe('Message Claude Code · 2');
  });
});

describe('r89.5: the working fold cuts at a word and keeps its closing quote', () => {
  const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');

  /** 6 px a character; the fold's words have `room` px with whatever tail shows after them. */
  function layout(room: number) {
    const rect = (width: number) => ({ width, height: 14, top: 0, left: 0, right: width, bottom: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('message-box__fold-words')) return rect(0);
      const tail = this.nextSibling?.nodeValue ?? '';
      const left = room - (tail.startsWith('…') ? tail.length * 6 : 0);
      return rect(Math.min((this.textContent ?? '').length * 6, left));
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) { return rect(this.toString().length * 6); },
    });
  }

  afterEach(() => {
    if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect);
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  function working(line: string) {
    const at = Date.now() - 5_000;
    usePersonThreadStore.setState({ listeners: [listener({ agent: CLAUDE_CODE })],
      activity: { [KEY]: { at: Date.now() - 300, line } } });
    receiveSync('p1', [{ id: 'm1', kind: 'message', at, text: 'Warmer', state: 'accepted',
      to: { listenerId: 'ch_1', agent: CLAUDE_CODE, session: SESSION, sessionKey: KEY } }]);
    useAgentLogStore.getState().add({ ts: at + 500, source: 'agent', agent: { id: 'a1', name: 'Claude Code', color: '#E8825A' }, message: 'Changed “Seed”' });
    render(<AgentLog />);
    return document.querySelector<HTMLElement>('.message-box__fold-text')!;
  }

  it('“Changed “Prompt” on “Hero…””: whole words, the ellipsis and the closer after them', () => {
    layout(52 * 6);
    const chip = working('Changed “Prompt” on “Hero shot”');
    expect(chip.textContent).toBe('Claude Code is working · Changed “Prompt” on “Hero…”');
    expect(chip.querySelector('.message-box__fold-words')?.textContent).toBe('Claude Code is working · Changed “Prompt” on “Hero');
  });

  it('measuring again (a resize) keeps the cut: the shown “…”” tail’s space counts', () => {
    layout(52 * 6);
    const observed: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observed.push(callback); }
      observe() {}
      disconnect() {}
    });
    try {
      const chip = working('Changed “Prompt” on “Hero shot”');
      expect(observed.length).toBeGreaterThan(0);
      // Each measure keeps it (a tail left out of the room would swing it to "on…" and back).
      for (let i = 0; i < 3; i += 1) {
        act(() => { for (const call of observed) call(); });
        expect(chip.textContent).toBe('Claude Code is working · Changed “Prompt” on “Hero…”');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('room for it all: the line whole, nothing after the words', () => {
    layout(400);
    const chip = working('Changed “Prompt” on “Hero shot”');
    expect(chip.textContent).toBe('Claude Code is working · Changed “Prompt” on “Hero shot”');
    expect(chip.querySelector('.message-box__fold-words')?.nextSibling).toBeNull();
  });
});
