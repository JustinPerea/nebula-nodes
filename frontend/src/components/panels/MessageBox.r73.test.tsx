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
import type { ThreadRow } from '../../lib/personThread';

/** GM - Design r73 on #225: the typed answer's You row (item 2: derived in
 * the person's tab, never sent or stored as a thread row) and the shared
 * word-boundary cut on the "Answering “…”" chip and "You answered “…”." (item 3). */

const CLAUDE = { id: 'a1', name: 'Claude', color: '#E8825A', verified: true };
const R73 = 'Use the same palette on the other three shots, or keep the warm one only for the hero?';
const TYPED = { id: 'x', text: R73, options: [], multiple: false, allowText: true };
const PICK = { id: 'x', text: 'Use the same palette on the other three shots?', options: ['All three', 'Only this one'], multiple: false, allowText: false };

type Q = typeof TYPED | typeof PICK;

function setView(id: string, questions: Q[], over: Record<string, unknown> = {}) {
  return { id, status: 'open', agent: { ...CLAUDE } as never, note: null, projectId: 'p1', nodeIds: [], createdAt: 0,
    closedAt: null, answers: null, questions: questions as never, ...over } as never;
}

function questionRow(id: string, at: number, questions: Q[]): ThreadRow {
  return { id: `row-${id}`, kind: 'question', at, questionId: id, agent: CLAUDE, questions };
}

function field(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /^Message/ }) as HTMLTextAreaElement;
}

/** The thread's items, in order: what each says. */
function threadItems(): string[] {
  const list = screen.getByRole('list', { name: 'Messages with Claude' });
  return [...list.children].map((item) => (item.textContent ?? '').trim());
}

function youAnswerRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-answer]')];
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

describe('r73 item 2: a typed answer shows as a You row', () => {
  it('sending one answer posts the answer once, no message; the You row follows the question, the card keeps its line', async () => {
    useAgentQuestionsStore.setState({ sets: { q1: { answerKey: 'k', view: setView('q1', [TYPED]) } } });
    receiveSync('p1', [questionRow('q1', Date.now() - 10_000, [TYPED])]);
    apiRequest.mockResolvedValue({ json: async () => ({ ok: true }) });
    render(<AgentLog />);
    expect(youAnswerRows()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    fireEvent.change(field(), { target: { value: 'Keep the warm one\nonly for the hero' } });
    await act(async () => { fireEvent.keyDown(field(), { key: 'Enter' }); });
    // One call, to the question; nothing to the thread (no message.posted, no wake).
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(String(apiRequest.mock.calls[0][1])).toMatch(/\/questions\/q1\/answer$/);
    expect(apiRequest.mock.calls.some((call) => String(call[1]).includes('/thread'))).toBe(false);
    // Not a thread row either: the store's rows are only the question.
    expect(usePersonThreadStore.getState().rows.map((row) => row.kind)).toEqual(['question']);
    const rows = youAnswerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.message-box__who')?.textContent).toBe('You');
    expect(rows[0].querySelector('.message-box__text')?.textContent).toBe('Keep the warm one\nonly for the hero');
    const items = threadItems();
    expect(items[items.length - 1]).toBe('YouKeep the warm one\nonly for the hero');
    expect(screen.getByText((_, el) => el?.classList.contains('message-box__answered') === true
      && el.textContent === 'You answered “Keep the warm one only for the hero”.')).toBeTruthy();
  });

  it('an option pick gets no You row', () => {
    useAgentQuestionsStore.setState({ sets: { q1: { view: setView('q1', [PICK], {
      status: 'answered', closedAt: Date.now(), answers: [{ questionId: 'x', answered: true, choices: ['Only this one'], text: null }],
    }) } } });
    receiveSync('p1', [questionRow('q1', Date.now() - 10_000, [PICK])]);
    render(<AgentLog />);
    expect(screen.getByText('You chose “Only this one”.')).toBeTruthy();
    expect(youAnswerRows()).toHaveLength(0);
  });

  it('after a reload it comes back from the questions sync, in time order among the rows', () => {
    const now = Date.now();
    // What questionsSync and the thread's hello sync bring a fresh tab.
    useAgentQuestionsStore.getState().synced([{ view: setView('q1', [TYPED], {
      status: 'answered', closedAt: now - 20_000, answers: [{ questionId: 'x', answered: true, choices: [], text: 'Keep it' }],
    }) }]);
    receiveSync('p1', [
      questionRow('q1', now - 30_000, [TYPED]),
      { id: 'r1', kind: 'reply', at: now - 10_000, text: 'Kept the warm one', agent: CLAUDE },
    ]);
    render(<AgentLog />);
    const items = threadItems();
    const at = (prefix: string) => items.findIndex((item) => item.startsWith(prefix));
    expect(at('YouKeep it')).toBeGreaterThan(at('Claude asks'));
    expect(at('YouKeep it')).toBeLessThan(at('ClaudeKept the warm one'));
    expect(youAnswerRows()).toHaveLength(1);
  });
});

describe('r73 item 3: one word-boundary cut for the chip and "You answered"', () => {
  const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');

  /** 6 px a character; the cut elements' line has 276 px: “…three shots…” (46 characters) just fits. */
  function layout() {
    const cut = (el: Element) => el.classList.contains('message-box__context-quote') || el.classList.contains('message-box__answered-words');
    const rect = (width: number) => ({ width, height: 14, top: 0, left: 0, right: width, bottom: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!cut(this)) return rect(0);
      // A shown ellipsis after the element takes its 6 px of the line.
      const room = 276 - (this.nextSibling?.nodeValue === '…' ? 6 : 0);
      return rect(Math.min((this.textContent ?? '').length * 6, room));
    });
    // jsdom has no Range.getBoundingClientRect: here a range measures its text.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) { return rect(this.toString().length * 6); },
    });
  }

  afterEach(() => {
    if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect);
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  it('the chip reads “Use the same palette on the other three shots…”', () => {
    layout();
    useAgentQuestionsStore.setState({ sets: { q1: { answerKey: 'k', view: setView('q1', [TYPED]) } } });
    receiveSync('p1', [questionRow('q1', Date.now() - 10_000, [TYPED])]);
    render(<AgentLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    const chip = field().closest('.message-box__composer')!.querySelector('.message-box__context--answering .message-box__context-label')!;
    expect(chip.textContent).toBe('Answering “Use the same palette on the other three shots…”');
    // The ellipsis sits after the clipped words, not in them (Chrome lays "s…" out narrower than it paints).
    expect(chip.querySelector('.message-box__context-quote')?.textContent).toBe('Use the same palette on the other three shots');
  });

  it('measuring again (the observer’s first call, a resize) keeps the cut: the shown ellipsis’s space counts', () => {
    layout();
    const observed: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observed.push(callback); }
      observe() {}
      disconnect() {}
    });
    try {
      useAgentQuestionsStore.setState({ sets: { q1: { answerKey: 'k', view: setView('q1', [TYPED]) } } });
      receiveSync('p1', [questionRow('q1', Date.now() - 10_000, [TYPED])]);
      render(<AgentLog />);
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
      const label = () => field().closest('.message-box__composer')!.querySelector('.message-box__context--answering .message-box__context-label')!;
      expect(label().textContent).toBe('Answering “Use the same palette on the other three shots…”');
      expect(observed.length).toBeGreaterThan(0);
      act(() => { for (const call of observed) call(); });
      act(() => { for (const call of observed) call(); });
      expect(label().textContent).toBe('Answering “Use the same palette on the other three shots…”');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('"You answered" uses the same cut', () => {
    layout();
    useAgentQuestionsStore.setState({ sets: { q1: { view: setView('q1', [TYPED], {
      status: 'answered', closedAt: Date.now(), answers: [{ questionId: 'x', answered: true, choices: [], text: R73 }],
    }) } } });
    receiveSync('p1', [questionRow('q1', Date.now() - 10_000, [TYPED])]);
    render(<AgentLog />);
    const line = document.querySelector('.message-box__answered--typed')!;
    expect(line.textContent).toBe('You answered “Use the same palette on the other three shots…”.');
    expect(line.querySelector('.message-box__answered-words')?.textContent).toBe('Use the same palette on the other three shots');
    // The You row keeps every word.
    expect(youAnswerRows()[0].querySelector('.message-box__text')?.textContent).toBe(R73);
  });
});
