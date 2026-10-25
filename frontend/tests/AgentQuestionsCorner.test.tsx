import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentNote } from '../src/lib/agentNotes';

/**
 * The Update's Answer (Q125 item 1): it opens the answer form as a popover
 * from the Updates corner, at the list's width (not on the canvas); Escape
 * closes only the popover and gives focus back to Answer; the closed
 * Update says how it ended and, answered, shows each answer.
 */

const flow = vi.hoisted(() => ({
  state: {
    transform: [0, 0, 1] as [number, number, number], width: 1440, height: 900, minZoom: 0.1,
    nodes: [] as unknown[], userSelectionActive: false, nodeLookup: new Map<string, unknown>(),
  },
}));
const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const notesApi = vi.hoisted(() => ({ fetchAgentNotes: vi.fn(), markAgentNotesRead: vi.fn(), dismissAgentNote: vi.fn() }));
const questionsApi = vi.hoisted(() => ({ answerQuestions: vi.fn(), dismissQuestions: vi.fn() }));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  useReactFlow: () => ({ setViewport: vi.fn() }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; },
    subscribeFirst: () => () => {},
    connect: () => {},
    send: () => {},
  },
}));
vi.mock('../src/lib/agentNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentNotes')>()),
  ...notesApi,
}));
vi.mock('../src/lib/agentQuestions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentQuestions')>()),
  ...questionsApi,
}));

const { AppAgentNotes } = await import('../src/components/agent-notes/AgentNotesCorner');
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const { useAgentQuestionsStore } = await import('../src/store/agentQuestionsStore');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');

const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };

const SET = {
  id: 'qs_1', status: 'open', agent: CLAUDE, note: null, projectId: 'p1', nodeIds: [],
  createdAt: 1, closedAt: null, answers: null, update: { id: 'u_q', projectId: 'p1' },
  questions: [
    { id: 'q1', text: 'Which crop?', options: ['Square', 'Wide'], multiple: false, allowText: true },
    { id: 'q2', text: 'Anything to avoid?', options: [], multiple: false, allowText: true },
  ],
};

function update(overrides: Partial<AgentNote> = {}): AgentNote {
  return {
    id: 'u_q', author: { kind: 'agent', id: CLAUDE.id, name: CLAUDE.name, color: CLAUDE.color },
    source: 'nebula', about: 'question' as AgentNote['about'], at: '2026-10-24T12:14:00.000Z',
    text: 'Claude Code has 2 questions.', parts: [{ text: 'Claude Code has 2 questions.' }], refs: [],
    actions: [{ label: 'Answer', op: { kind: 'question.answer', questionId: 'qs_1' } }],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null, ...overrides,
  };
}

function emit(event: unknown) {
  act(() => {
    for (const handler of ws.handlers) handler(event);
  });
}

function sync(notes: AgentNote[]) {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes,
    unread: notes.filter((n) => !n.readAt).length, at: 1 });
}

function openList() {
  fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
  return screen.getByRole('dialog', { name: 'Updates' });
}

beforeEach(() => {
  useAgentNotesStore.getState().reset();
  useAgentQuestionsStore.getState().reset();
  useProjectStore.setState({ screen: 'workspace' });
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false, viewMode: 'canvas' });
  notesApi.fetchAgentNotes.mockReset().mockResolvedValue({ projectId: 'p1', notes: [], unread: 0 });
  notesApi.markAgentNotesRead.mockReset().mockResolvedValue({ ids: [], unread: 0, projectId: 'p1' });
  notesApi.dismissAgentNote.mockReset().mockResolvedValue({ unread: 0 });
  questionsApi.answerQuestions.mockReset().mockResolvedValue(undefined);
  questionsApi.dismissQuestions.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(cleanup);

describe("an Update's Answer", () => {
  it('opens the form over the list, in the corner, and Escape gives focus back to Answer', async () => {
    render(<AppAgentNotes />);
    sync([update()]);
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    const list = openList();
    expect(within(list).getByText('Claude Code has 2 questions.')).toBeTruthy();
    const answer = within(list).getByRole('button', { name: 'Answer' });
    fireEvent.click(answer);

    const form = await screen.findByRole('dialog', { name: 'Questions from Claude Code' });
    // A popover of the corner (the list's panel), not anchored on the canvas.
    expect(form.classList.contains('agent-notes-panel')).toBe(true);
    expect(form.closest('.react-flow')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();

    fireEvent.change(within(form).getByPlaceholderText('Type your answer.'), { target: { value: 'No orange' } });
    fireEvent.keyDown(form, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Questions from Claude Code' })).toBeNull();
    // Only the popover closed: the list stays, nothing was dismissed, the draft stays.
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
    expect(questionsApi.dismissQuestions).not.toHaveBeenCalled();
    expect(useAgentQuestionsStore.getState().drafts.qs_1.q2.text).toBe('No orange');
    await waitFor(() => expect(document.activeElement).toBe(
      within(screen.getByRole('dialog', { name: 'Updates' })).getByRole('button', { name: 'Answer' })));
  });

  it('sends and closes, then the Update shows the outcome and each answer', async () => {
    render(<AppAgentNotes />);
    sync([update()]);
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    fireEvent.click(within(openList()).getByRole('button', { name: 'Answer' }));
    const form = await screen.findByRole('dialog', { name: 'Questions from Claude Code' });
    fireEvent.click(within(form).getByRole('button', { name: 'Wide' }));
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Send' })); });
    expect(questionsApi.answerQuestions).toHaveBeenCalledWith('qs_1', 'k1', [{ questionId: 'q1', choices: ['Wide'] }]);
    expect(screen.queryByRole('dialog', { name: 'Questions from Claude Code' })).toBeNull();

    // The backend settles the Update and sends the set as it closed.
    emit({ type: 'questionsClosed', questionId: 'qs_1', status: 'answered', agentId: CLAUDE.id, set: {
      ...SET, status: 'answered', answers: [
        { questionId: 'q1', answered: true, choices: ['Wide'], text: null },
        { questionId: 'q2', answered: false, choices: [], text: null },
      ] } });
    sync([update({ resolvedAt: '2026-10-24T12:15:00.000Z', outcome: 'Answered.', readAt: '2026-10-24T12:14:30.000Z' })]);
    const list = screen.getByRole('dialog', { name: 'Updates' });
    expect(within(list).getByText('Answered.')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Answer' })).toBeNull();
    const rows = within(list).getAllByRole('listitem').filter((row) => row.classList.contains('agent-questions-answers__row'));
    expect(rows.map((row) => row.textContent)).toEqual(['Which crop?Wide', 'Anything to avoid?No answer.']);
  });

  it('from a dropped card, opens the list with the form over it', async () => {
    render(<AppAgentNotes />);
    sync([]);
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: update(), unread: 1, at: 2, removed: [] });
    const card = await screen.findByRole('status', { name: 'Update from Claude Code' }, { timeout: 3000 });
    fireEvent.click(within(card).getByRole('button', { name: 'Answer' }));
    expect(await screen.findByRole('dialog', { name: 'Questions from Claude Code' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
  });

  it("keeps Answer after the dropped card's x, so an open set can still be answered", async () => {
    // The card's x is a soft dismiss ("it stays in Updates"). A question
    // Update is the only way into its set (no expiry, no canvas bar), so the
    // x must not grey it out to "Not now" while the set is open.
    render(<AppAgentNotes />);
    sync([]);
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: update(), unread: 1, at: 2, removed: [] });
    const card = await screen.findByRole('status', { name: 'Update from Claude Code' }, { timeout: 3000 });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Dismiss this update' })); });
    expect(notesApi.dismissAgentNote).toHaveBeenCalledWith({ kind: 'canvas' }, 'u_q');
    // The server echoes the dismiss; the Update now carries dismissedAt.
    emit({ type: 'agentNotes', surface: 'canvas', op: 'dismissed', projectId: 'p1', ids: ['u_q'], unread: 0,
      at: '2026-10-24T12:14:10.000Z' });
    sync([update({ dismissedAt: '2026-10-24T12:14:10.000Z' })]);

    const list = openList();
    expect(within(list).queryByText('Not now')).toBeNull();
    const row = list.querySelector('[data-note-id="u_q"]') as HTMLElement;
    expect(row.dataset.state).toBeUndefined();
    fireEvent.click(within(list).getByRole('button', { name: 'Answer' }));
    expect(await screen.findByRole('dialog', { name: 'Questions from Claude Code' })).toBeTruthy();
    expect(questionsApi.dismissQuestions).not.toHaveBeenCalled();
  });

  it('says so when this tab has no key to answer with', async () => {
    render(<AppAgentNotes />);
    sync([update()]);
    const list = openList();
    fireEvent.click(within(list).getByRole('button', { name: 'Answer' }));
    // The backend's own words for a tab without the key (main.py _answerable_questions).
    expect((await within(list).findByRole('alert')).textContent).toBe(
      'These questions can only be answered from the Nebula canvas.');
    expect(screen.queryByRole('dialog', { name: /question/ })).toBeNull();
  });
});
