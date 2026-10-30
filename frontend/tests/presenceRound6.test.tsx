import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * PR #204 round 6 (GM r6, r7; review 4):
 * - GM r6 check a: a held tab that opens the list with unread Updates gets the mark-read line
 *   and its retry on the promote, whether it is held fresh or demoted after reading some.
 * - GM r7 item 1: an open question form in a demoted tab keeps its draft; Send and Dismiss
 *   lock in place with the answer lock; the store refuses too; the promote unlocks them.
 * - Review 4: the header's total is the server's; its changes are announced politely.
 */

const flow = vi.hoisted(() => ({
  state: {
    transform: [0, 0, 1] as [number, number, number], width: 1440, height: 900, minZoom: 0.1,
    nodes: [] as unknown[], userSelectionActive: false, nodeLookup: new Map<string, unknown>(),
  },
  setViewport: vi.fn(),
}));
const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const notesApi = vi.hoisted(() => ({ fetchAgentNotes: vi.fn(), markAgentNotesRead: vi.fn(), dismissAgentNote: vi.fn() }));
const rosterApi = vi.hoisted(() => ({ fetchAgentRoster: vi.fn() }));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  useReactFlow: () => ({ setViewport: flow.setViewport }),
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
vi.mock('../src/lib/agentRoster', () => rosterApi);

const { AppAgentNotes } = await import('../src/components/agent-notes/AgentNotesCorner');
const { AgentQuestionsForm } = await import('../src/components/agent-notes/AgentQuestionsForm');
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const { useAgentQuestionsStore } = await import('../src/store/agentQuestionsStore');
const { useAgentPresenceStore } = await import('../src/store/agentPresenceStore');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useAgentRosterStore } = await import('../src/components/agent-notes/agentRosterStore');
const { useAssetProposalsStore } = await import('../src/store/assetProposalsStore');
const session = await import('../src/lib/personSession');
const { PERSON_REQUIRED_CODE, RequestFailedError, MARK_READ_REFUSED_COPY } = await import('../src/lib/errorCopy');
const { pendingPromoteRetries } = await import('../src/lib/clearsOnPromote');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');

const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };
const CODEX = { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true };
const CURSOR = { id: 'cursor', name: 'Cursor', color: '#E8825A', verified: true };
const T = Date.now() - 120_000;
const ANSWER_LOCK = 'You can answer this when this tab is connected as you.';

function update(id: string, author: typeof CODEX, about: 'proposal' | 'question' | 'note', extra: Record<string, unknown> = {}) {
  return {
    id, author: { kind: 'agent', ...author }, source: 'nebula', about, at: new Date(T + 60_000).toISOString(),
    text: 'x', parts: [], refs: [], readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
    resolvedAt: null, outcome: null, ...extra,
  };
}
const COVER = update('u_cover', CODEX, 'proposal', {
  proposal: { id: 'pa_cover', kind: 'project', targetId: 'p1', cover: 'image', since: T },
  actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_cover', target: 'project', targetId: 'p1' } }] });
const QUESTION = update('u_q', CLAUDE, 'question', { questions: { id: 'qs_2', count: 1, since: T + 1_000 },
  actions: [{ label: 'Answer', op: { kind: 'question.answer', questionId: 'qs_2' } }] });
const CANVAS = update('u_canvas', CURSOR, 'proposal', { proposal: { id: 'p_canvas', kind: 'canvas', targetId: 'p1', since: T + 2_000 },
  actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'p_canvas', target: 'canvas', targetId: 'p1' } }] });
const UPDATES = [COVER, QUESTION, CANVAS];

const refused = (options: { sentBeforePromote?: boolean } = {}) => new RequestFailedError("Couldn't mark the updates as read.", 403,
  { code: PERSON_REQUIRED_CODE, detail: 'Only the person can do this.', ...options });

function emit(event: unknown) {
  act(() => {
    for (const handler of [...ws.handlers]) handler(event);
  });
}
function sync(notes: unknown[] = UPDATES, unread = notes.length) {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes, unread, at: 1 });
}
const openList = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
  return screen.getByRole('dialog', { name: 'Updates' });
};
const header = (list: HTMLElement) => list.querySelector('.agent-notes-panel__count')?.textContent;
const look = (button: HTMLElement) => ({
  locked: button.getAttribute('aria-disabled'),
  pending: button.hasAttribute('data-held-pending'),
  title: button.getAttribute('title'),
});

beforeEach(() => {
  session.resetPersonSessionForTests();
  useAgentNotesStore.getState().reset();
  useAgentQuestionsStore.getState().reset();
  useAgentPresenceStore.getState().clear();
  useCanvasProposalsStore.getState().clear();
  useAssetProposalsStore.getState().clear();
  useAgentRosterStore.getState().reset();
  useGraphStore.setState({ nodes: [] } as never);
  useProjectStore.setState({ screen: 'workspace' });
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false, viewMode: 'canvas' });
  notesApi.fetchAgentNotes.mockReset().mockResolvedValue({ projectId: 'p1', notes: [], unread: 0 });
  notesApi.markAgentNotesRead.mockReset().mockResolvedValue({ ids: [], unread: 0, projectId: 'p1' });
  notesApi.dismissAgentNote.mockReset().mockResolvedValue({ unread: 0 });
  rosterApi.fetchAgentRoster.mockReset().mockResolvedValue({ projectId: 'p1', agents: [], rev: 0 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  session.notePersonPromoted();
  session.resetPersonSessionForTests();
});

describe('GM r6 check a: the mark-read line, held fresh or demoted', () => {
  it('fresh held: opening the list with unread Updates gives the line and one retry on the promote', async () => {
    notesApi.markAgentNotesRead.mockRejectedValueOnce(refused());
    render(<AppAgentNotes />);
    act(() => { session.reportPersonRequired(); });
    sync();
    const list = openList();
    await waitFor(() => expect(list.textContent).toContain(MARK_READ_REFUSED_COPY));
    expect(pendingPromoteRetries()).toBe(1);
  });

  it('demoted after reading three: two more arrive, opening the list gives the same line and the same retry', async () => {
    render(<AppAgentNotes />);
    sync();
    let list = openList();
    await waitFor(() => expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ })); // close
    act(() => { session.reportPersonRequired(); }); // demoted
    notesApi.markAgentNotesRead.mockRejectedValueOnce(refused());
    const read = new Date(T + 90_000).toISOString();
    const five = [update('u_new2', CODEX, 'note'), update('u_new1', CLAUDE, 'note'), ...UPDATES.map((n) => ({ ...n, readAt: read }))];
    notesApi.fetchAgentNotes.mockResolvedValue({ projectId: 'p1', notes: five, unread: 2 }); // the server's list, read again
    emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', at: 2, unread: 2, notes: five });
    list = openList();
    await waitFor(() => expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(list.textContent).toContain(MARK_READ_REFUSED_COPY));
    expect(header(list)).toBe('5 · 2 unread');
    expect(pendingPromoteRetries()).toBe(1);
    notesApi.markAgentNotesRead.mockResolvedValueOnce({ ids: ['u_new2', 'u_new1'], unread: 0, projectId: 'p1' });
    act(() => { session.notePersonPromoted(); });
    await waitFor(() => expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(list.textContent).not.toContain(MARK_READ_REFUSED_COPY));
  });
});

const SET = { id: 'qs_2', status: 'open', agent: CLAUDE, note: null, projectId: 'p1', nodeIds: [], createdAt: T + 1_000,
  closedAt: null, answers: null, update: { id: 'u_q', projectId: 'p1' },
  questions: [{ id: 'q1', text: 'Which crop?', options: ['Square', 'Wide'], multiple: false, allowText: true }] };
const buttons = () => ({ send: screen.getByRole('button', { name: 'Send' }), dismiss: screen.getByRole('button', { name: 'Dismiss' }) });

describe('GM r7 (1): a question form open when the tab is demoted', () => {
  function openForm() {
    act(() => { session.notePersonPromoted(); });
    act(() => { useAgentQuestionsStore.getState().opened(SET as never, 'k_q'); });
    const onClose = vi.fn();
    render(<AgentQuestionsForm setId="qs_2" onClose={onClose} />);
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'Wide, please' } });
    field.focus();
    (field as HTMLTextAreaElement).setSelectionRange(4, 4);
    return { field: field as HTMLTextAreaElement, onClose };
  }

  it('stays open with its draft and caret; Send and Dismiss lock in place with the answer lock', async () => {
    const { field, onClose } = openForm();
    expect(look(buttons().send).locked).toBeNull();
    act(() => { session.reportPersonRequired(); }); // demoted
    expect(screen.getByRole('textbox')).toBe(field);
    expect(field.value).toBe('Wide, please');
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(4);
    for (const button of Object.values(buttons())) {
      expect(look(button)).toEqual({ locked: 'true', pending: false, title: ANSWER_LOCK });
      expect(button).toBeEnabled(); // still focusable, where it was
    }
    fireEvent.click(buttons().send);
    fireEvent.click(buttons().dismiss);
    await act(async () => { await Promise.resolve(); });
    expect(onClose).not.toHaveBeenCalled();
    // Typing stays live.
    fireEvent.change(field, { target: { value: 'Wide, please, cropped' } });
    expect(field.value).toBe('Wide, please, cropped');
  });

  it('the store refuses Send and Dismiss while the tab is not confirmed, and sends nothing', async () => {
    openForm();
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    act(() => { session.reportPersonRequired(); });
    expect(await useAgentQuestionsStore.getState().send('qs_2')).toBe(false);
    expect(await useAgentQuestionsStore.getState().dismiss('qs_2')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('on the promote the buttons unlock in place; nothing closes or moves', async () => {
    const { field, onClose } = openForm();
    act(() => { session.reportPersonRequired(); });
    const before = buttons();
    act(() => { session.notePersonPromoted(); });
    const after = buttons();
    expect(after.send).toBe(before.send);
    expect(after.dismiss).toBe(before.dismiss);
    for (const button of Object.values(after)) expect(look(button)).toEqual({ locked: null, pending: false, title: null });
    expect(field.value).toBe('Wide, please');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a fresh page not answered yet: the lock keeps the buttons\' look for the first 150 ms (no grey, no reason)', () => {
    vi.useFakeTimers();
    act(() => { session.resetPersonSessionForTests({ unanswered: true }); });
    act(() => { useAgentQuestionsStore.getState().opened(SET as never, 'k_q'); });
    render(<AgentQuestionsForm setId="qs_2" onClose={() => {}} />);
    expect(look(buttons().dismiss)).toEqual({ locked: 'true', pending: true, title: null });
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS + 10); });
    expect(look(buttons().dismiss)).toEqual({ locked: 'true', pending: false, title: ANSWER_LOCK });
  });
});

describe('review 4 NIT-3: the header\'s changes are read out politely', () => {
  it('the count is a polite, atomic status, and the promote changes it once', async () => {
    notesApi.markAgentNotesRead.mockRejectedValueOnce(refused());
    notesApi.fetchAgentNotes.mockResolvedValue({ projectId: 'p1', notes: UPDATES, unread: 3 }); // read again on the refusal
    render(<AppAgentNotes />);
    act(() => { session.reportPersonRequired(); });
    sync();
    const list = openList();
    const count = list.querySelector('.agent-notes-panel__count')!;
    expect([count.getAttribute('role'), count.getAttribute('aria-live'), count.getAttribute('aria-atomic')]).toEqual(['status', 'polite', 'true']);
    await waitFor(() => expect(count.textContent).toBe('3 · all unread'));
    notesApi.markAgentNotesRead.mockResolvedValueOnce({ ids: ['u_cover', 'u_q', 'u_canvas'], unread: 0, projectId: 'p1' });
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(count.textContent ?? ''));
    watch.observe(count, { childList: true, characterData: true, subtree: true });
    act(() => { session.notePersonPromoted(); });
    await waitFor(() => expect(count.textContent).toBe('3 · all read'));
    watch.disconnect();
    expect([...new Set(seen)]).toEqual(['3 · all read']);
  });
});
