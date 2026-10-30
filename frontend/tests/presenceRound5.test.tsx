import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * PR #204 round 5:
 * - GM r4: the header says "2 · all unread" when every Update is unread, "5 · 2 unread" when
 *   some are; the count is the server's.
 * - Review 3 LOW-1: a refusal of a request sent before the promote, landing after it, clears its
 *   line and runs its retry at once (the sweep it waited for has run); it doesn't hold the tab.
 * - GM r5 item 2, "held is a state, not a path": (a) a fresh tab is locked from page load until
 *   the socket's first answer, with the 150 ms rule (a fast load never greys, a slow one greys
 *   and lifts, a click in that window does nothing); (b) a demoted tab is held: the Updates
 *   buttons, the Agents rows, the arrival card and an open proposal's Accept lock with the same
 *   lines, and what it synced stays listed.
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
const { AssetProposalStrip } = await import('../src/components/proposals/AssetProposalStrip');
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const { useAgentQuestionsStore } = await import('../src/store/agentQuestionsStore');
const { useAgentPresenceStore } = await import('../src/store/agentPresenceStore');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useAgentRosterStore } = await import('../src/components/agent-notes/agentRosterStore');
const { useAssetProposalsStore } = await import('../src/store/assetProposalsStore');
const { coverProposal } = await import('../src/test/assetProposalFixtures');
const session = await import('../src/lib/personSession');
const { apiFetch } = await import('../src/lib/backend');
const { PERSON_REQUIRED_CODE, RequestFailedError, MARK_READ_REFUSED_COPY, requestError } = await import('../src/lib/errorCopy');
const { PROPOSAL_GATE_COPY } = await import('../src/lib/canvasProposals');
const { pendingPromoteClears, pendingPromoteRetries } = await import('../src/lib/clearsOnPromote');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');

const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };
const CODEX = { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true };
const CURSOR = { id: 'cursor', name: 'Cursor', color: '#E8825A', verified: true };
const T = Date.now() - 120_000;
const REVIEW_LOCK = 'You can review this when this tab is connected as you.';
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
/** The person's sync after the promote: the asks themselves. */
function promoteAsks() {
  act(() => { session.notePersonPromoted(); });
  emit({ type: 'questionsOpened', answerKey: 'k_q', set: { id: 'qs_2', status: 'open', agent: CLAUDE, note: null,
    projectId: 'p1', nodeIds: [], createdAt: T + 1_000, closedAt: null, answers: null, update: { id: 'u_q', projectId: 'p1' },
    questions: [{ id: 'q1', text: 'Which crop?', options: ['Square', 'Wide'], multiple: false, allowText: true }] } });
  emit({ type: 'proposalOpened', acceptKey: 'k_c', proposal: { id: 'p_canvas', status: 'open', agent: CURSOR, note: 'n',
    projectId: 'p1', createdAt: T + 2_000, expiresAt: Date.now() + 600_000, nodes: [], edges: [], params: [], run: [],
    references: [], cost: {} } });
  act(() => {
    useAssetProposalsStore.getState().sync([{ ...coverProposal({ id: 'pa_cover', agent: CODEX, createdAt: T,
      target: { kind: 'project', id: 'p1', name: 'Followups' }, update: { id: 'u_cover', projectId: 'p1' } } as never),
    acceptKey: 'k_a' }]);
  });
}
const openList = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
  return screen.getByRole('dialog', { name: 'Updates' });
};
const header = (list: HTMLElement) => list.querySelector('.agent-notes-panel__count')?.textContent;
const asks = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button[data-op="proposal.review"], button[data-op="question.answer"]')];
const look = (button: HTMLElement) => ({
  locked: button.getAttribute('aria-disabled'),
  pending: button.hasAttribute('data-held-pending'),
  title: button.getAttribute('title'),
});
const rows = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-group="needsYou"]')];

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

describe('GM r4: the header\'s count is the server\'s, and says when all of it is unread', () => {
  it('every Update unread: "3 · all unread"; some: "5 · 2 unread"', () => {
    notesApi.markAgentNotesRead.mockImplementation(() => new Promise(() => {})); // the read never answers here
    render(<AppAgentNotes />);
    sync();
    const list = openList();
    expect(header(list)).toBe('3 · all unread');
    // Five, two of them unread (the server's count; one read Update, two notes).
    const read = new Date(T + 90_000).toISOString();
    const five = [{ ...COVER, readAt: read }, QUESTION, { ...CANVAS, readAt: read },
      update('u_a', CODEX, 'note'), update('u_b', CLAUDE, 'note', { readAt: read })];
    emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes: five, unread: 2, at: 2 });
    expect(header(list)).toBe('5 · 2 unread');
  });
});

describe('review 3 LOW-1: a refusal that lands after the promote', () => {
  it('a mark-read sent while held and refused after the promote clears its line and retries at once', async () => {
    let answer: (error: unknown) => void = () => {};
    notesApi.markAgentNotesRead.mockImplementationOnce(() => new Promise((_resolve, reject) => { answer = reject; }));
    render(<AppAgentNotes />);
    act(() => { session.reportPersonRequired(); });
    sync();
    const list = openList();
    await waitFor(() => expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(1));
    act(() => { session.notePersonPromoted(); }); // the sweep runs: nothing waits yet
    notesApi.markAgentNotesRead.mockResolvedValueOnce({ ids: ['u_cover', 'u_q', 'u_canvas'], unread: 0, projectId: 'p1' });
    await act(async () => { answer(refused({ sentBeforePromote: true })); });
    await waitFor(() => expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(header(list)).toMatch(/all read$/));
    expect(useAgentNotesStore.getState().error).toBeNull();
    expect(list.textContent).not.toContain(MARK_READ_REFUSED_COPY);
    expect([pendingPromoteClears(), pendingPromoteRetries()]).toEqual([0, 0]);
    expect(session.personGateHeld()).toBe(false);
  });

  it('a refusal of a request sent after the promote is this tab\'s state now: its line waits for the next promote', async () => {
    notesApi.markAgentNotesRead.mockRejectedValueOnce(refused());
    render(<AppAgentNotes />);
    act(() => { session.reportPersonRequired(); });
    sync();
    const list = openList();
    await waitFor(() => expect(list.textContent).toContain(MARK_READ_REFUSED_COPY));
    await act(async () => { await Promise.resolve(); });
    expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(1);
    expect(pendingPromoteRetries()).toBe(1);
  });

  it('the retry checks it is still the project it read (keyFor): a read refused on p1 isn\'t sent once p2 is open', async () => {
    notesApi.markAgentNotesRead.mockRejectedValueOnce(refused());
    render(<AppAgentNotes />);
    act(() => { session.reportPersonRequired(); });
    sync();
    const list = openList();
    await waitFor(() => expect(list.textContent).toContain(MARK_READ_REFUSED_COPY));
    expect(pendingPromoteRetries()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ })); // closed: nothing reads on its own
    act(() => { useAgentNotesStore.setState({ canvasProjectId: 'p2' }); });
    act(() => { session.notePersonPromoted(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(1);
    expect(pendingPromoteRetries()).toBe(0);
  });

  it('the real request path: an answer to a request sent before the promote is marked, and holds nothing', async () => {
    let answer: (response: Response) => void = () => {};
    const respond = () => new Response(JSON.stringify({ detail: 'Only the person can do this.', code: PERSON_REQUIRED_CODE }),
      { status: 403, headers: { 'Content-Type': 'application/json' } });
    const fetchMock = vi.fn((url: unknown) => (String(url).includes('/api/canvas/agent-notes/read')
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))));
    vi.stubGlobal('fetch', fetchMock);
    act(() => { session.reportPersonRequired(); });
    const sent = apiFetch('/api/canvas/agent-notes/read', { method: 'POST', body: '{}' });
    // On its way (sent), then the promote, then its answer.
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/agent-notes/read'))).toBe(true));
    act(() => { session.notePersonPromoted(); });
    answer(respond());
    const response = await sent;
    expect(session.sentBeforePromote(response)).toBe(true);
    const error = await requestError("Couldn't mark the updates as read.", response);
    expect([error.code, error.sentBeforePromote]).toEqual([PERSON_REQUIRED_CODE, true]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(session.personGateHeld()).toBe(false); // the old state's answer doesn't demote

    // Sent after the promote, the same answer is the server's state now: it holds the tab.
    vi.stubGlobal('fetch', vi.fn(async () => respond()));
    const now = await apiFetch('/api/canvas/agent-notes/read', { method: 'POST', body: '{}' });
    expect(session.sentBeforePromote(now)).toBe(false);
    await waitFor(() => expect(session.personGateHeld()).toBe(true));
  });
});

describe('GM r5 2a: a fresh tab is locked from load until the socket\'s first answer', () => {
  it('a slow answer: locked at once in its own look (no grey, no reason), greys after 150 ms, lifts on the answer', () => {
    vi.useFakeTimers();
    session.resetPersonSessionForTests({ unanswered: true });
    expect(session.personUnconfirmed()).toBe(true);
    render(<AppAgentNotes />);
    sync();
    const list = openList();
    const [review] = asks(list);
    expect(look(review)).toEqual({ locked: 'true', pending: true, title: null });
    fireEvent.click(review);
    expect(useProjectStore.getState().screen).toBe('workspace'); // a cover Review would go to Projects
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS + 10); });
    expect(look(review)).toEqual({ locked: 'true', pending: false, title: REVIEW_LOCK });
    promoteAsks();
    expect(look(asks(list)[0])).toEqual({ locked: null, pending: false, title: null });
  });

  it('a fast answer never greys: the lock lifts inside the 150 ms', () => {
    vi.useFakeTimers();
    session.resetPersonSessionForTests({ unanswered: true });
    render(<AppAgentNotes />);
    sync();
    const list = openList();
    expect(asks(list).map(look).every((seen) => seen.pending && seen.title === null)).toBe(true);
    act(() => { vi.advanceTimersByTime(100); });
    promoteAsks();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS); });
    expect(asks(list).map(look)).toEqual(asks(list).map(() => ({ locked: null, pending: false, title: null })));
  });

  it('an answer that refuses (the socket\'s personRequired) locks with the grey and the reason at once', () => {
    vi.useFakeTimers();
    session.resetPersonSessionForTests({ unanswered: true });
    render(<AppAgentNotes />);
    sync();
    const list = openList();
    act(() => { session.reportPersonRequired(); });
    expect(asks(list).map(look)).toEqual([
      { locked: 'true', pending: false, title: REVIEW_LOCK },
      { locked: 'true', pending: false, title: ANSWER_LOCK },
      { locked: 'true', pending: false, title: REVIEW_LOCK },
    ]);
  });

  it('an open proposal\'s Accept: no grey and no click before the first answer, then the held look', () => {
    vi.useFakeTimers();
    session.resetPersonSessionForTests({ unanswered: true });
    act(() => {
      useAssetProposalsStore.getState().sync([{ ...coverProposal({ id: 'pa_cover', agent: CODEX, createdAt: Date.now(),
        target: { kind: 'project', id: 'p1', name: 'Followups' } } as never), acceptKey: 'k_a' }]);
    });
    const accept = vi.spyOn(useAssetProposalsStore.getState(), 'accept');
    render(<AssetProposalStrip kind="project" targetId="p1" />);
    const button = document.querySelector<HTMLButtonElement>('.asset-proposal__button--accept')!;
    expect([button.disabled, button.getAttribute('aria-disabled'), button.hasAttribute('data-held-pending'), button.title])
      .toEqual([false, 'true', true, '']);
    fireEvent.click(button);
    expect(accept).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(HELD_LOOK_DELAY_MS + 10); });
    expect([button.disabled, button.hasAttribute('data-held-pending'), button.title]).toEqual([true, false, PROPOSAL_GATE_COPY.accept]);
  });
});

describe('GM r5 2b: a demoted tab is held, everywhere, by the one state', () => {
  it('the Updates buttons, the Agents rows and an open proposal\'s Accept lock with their lines; what it synced stays', async () => {
    render(<><AppAgentNotes /><AssetProposalStrip kind="project" targetId="p1" /></>);
    sync();
    promoteAsks();
    const list = openList();
    fireEvent.click(await within(list).findByRole('button', { name: /^Agents/ }));
    const accept = () => document.querySelector<HTMLButtonElement>('.asset-proposal__button--accept')!;
    expect(asks(list).map((button) => button.getAttribute('aria-disabled'))).toEqual([null, null, null]);
    expect(rows(list).map((row) => row.getAttribute('aria-disabled'))).toEqual([null, null, null]);
    expect(accept().disabled).toBe(false);

    act(() => { session.reportPersonRequired(); }); // the server's demote
    expect(asks(list).map((button) => [button.getAttribute('aria-disabled'), button.getAttribute('title')]))
      .toEqual([['true', REVIEW_LOCK], ['true', ANSWER_LOCK], ['true', REVIEW_LOCK]]);
    expect(rows(list).map((row) => [row.getAttribute('aria-disabled'), row.getAttribute('title')]))
      .toEqual([['true', REVIEW_LOCK], ['true', ANSWER_LOCK], ['true', REVIEW_LOCK]]);
    expect([accept().disabled, accept().title]).toEqual([true, PROPOSAL_GATE_COPY.accept]);
    // What it synced stays listed: the asks are still there, only locked.
    expect(Object.keys(useCanvasProposalsStore.getState().proposals)).toEqual(['p_canvas']);
    expect(useAgentQuestionsStore.getState().sets.qs_2).toBeDefined();
    expect(rows(list)).toHaveLength(3);
    for (const row of rows(list)) fireEvent.click(row);
    await act(async () => { await Promise.resolve(); });
    expect(useCanvasProposalsStore.getState().focusedId).toBeNull();
    expect(screen.queryByRole('dialog', { name: /A question from/ })).toBeNull();

    promoteAsks();
    expect(asks(list).map((button) => button.getAttribute('aria-disabled'))).toEqual([null, null, null]);
    expect(accept().disabled).toBe(false);
  });

  it('the arrival card of a demoted tab locks too', async () => {
    render(<AppAgentNotes />);
    sync([], 0);
    promoteAsks();
    act(() => { session.reportPersonRequired(); });
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: QUESTION, unread: 1, at: 2 });
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.agent-note-card');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(asks(card).map((button) => [button.getAttribute('aria-disabled'), button.getAttribute('title')]))
      .toEqual([['true', ANSWER_LOCK]]);
    fireEvent.click(asks(card)[0]);
    await act(async () => { await Promise.resolve(); });
    expect(useAgentQuestionsStore.getState().formId).toBeNull();
  });
});
