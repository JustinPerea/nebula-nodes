import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

/**
 * PR #204 round 4 (GM's r3 rulings; review 2):
 * - item 1: the Updates header says "all read" only once the server read them; a read the
 *   gate refused for this tab is retried once, silently, on the promote.
 * - item 2: a held tab's Review and Answer stay where they are, locked, on every surface that
 *   offers them (the opened list and the arrival card), through the Agents panel's own rule.
 * - item 3: the stale line's wording.
 * - review 2 MEDIUM: the Krea row's line clears on the promote; a line with another reason stays.
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
const krea = vi.hoisted(() => ({ connectKrea: vi.fn(), checkKreaConnection: vi.fn(), disconnectKrea: vi.fn(), getKreaConnection: vi.fn() }));

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
vi.mock('../src/lib/kreaConnection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/kreaConnection')>()), ...krea,
}));

const { AppAgentNotes } = await import('../src/components/agent-notes/AgentNotesCorner');
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
const { notePersonPromoted, reportPersonRequired } = await import('../src/lib/personSession');
const { PERSON_REQUIRED_CODE, RequestFailedError, MARK_READ_REFUSED_COPY } = await import('../src/lib/errorCopy');
const { pendingPromoteRetries } = await import('../src/lib/clearsOnPromote');
const { sanitizeNotes } = await import('../src/lib/agentNotes');
const { heldLockFor } = await import('../src/components/agent-notes/heldLock');
const { useKreaConnection } = await import('../src/components/panels/settings/useKreaConnection');

const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };
const CODEX = { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true };
const T = Date.now() - 120_000;
const REVIEW_LOCK = 'You can review this when this tab is connected as you.';
const ANSWER_LOCK = 'You can answer this when this tab is connected as you.';
const GREY = 'var(--disabled-label, rgba(255, 255, 255, 0.55))';

const refused = () => new RequestFailedError("Couldn't mark the updates as read.", 403,
  { code: PERSON_REQUIRED_CODE, detail: 'Only the person can do this.' });

function update(id: string, author: typeof CODEX, about: 'proposal' | 'question', extra: Record<string, unknown>) {
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
const UPDATES = [COVER, QUESTION];

function emit(event: unknown) {
  act(() => {
    for (const handler of [...ws.handlers]) handler(event);
  });
}
function sync(notes: unknown[] = UPDATES, unread = notes.length) {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes, unread, at: 1 });
}
function held() {
  act(() => { reportPersonRequired(); useAssetProposalsStore.setState({ awaitingSync: true }); });
}
/** The person's sync after the promote: the asks themselves. */
function promoteAsks() {
  act(() => { notePersonPromoted(); });
  emit({ type: 'questionsOpened', answerKey: 'k_q', set: { id: 'qs_2', status: 'open', agent: CLAUDE, note: null,
    projectId: 'p1', nodeIds: [], createdAt: T + 1_000, closedAt: null, answers: null, update: { id: 'u_q', projectId: 'p1' },
    questions: [{ id: 'q1', text: 'Which crop?', options: ['Square', 'Wide'], multiple: false, allowText: true }] } });
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
const look = (root: ParentNode) => asks(root).map((button) => [
  button.closest('[data-note-id]')?.getAttribute('data-note-id') ?? 'card', button.textContent,
  button.getAttribute('aria-disabled'), button.getAttribute('title')]);

beforeEach(() => {
  notePersonPromoted(); // nothing left waiting from another test
  useAgentNotesStore.getState().reset();
  useAgentQuestionsStore.getState().reset();
  useAgentPresenceStore.getState().clear();
  useCanvasProposalsStore.getState().clear();
  useAssetProposalsStore.getState().clear();
  useAgentRosterStore.getState().reset();
  useGraphStore.setState({ nodes: [] } as never);
  useProjectStore.setState({ screen: 'workspace' });
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false, viewMode: 'canvas' });
  notesApi.fetchAgentNotes.mockReset().mockResolvedValue({ projectId: 'p1', notes: UPDATES, unread: 2 });
  notesApi.markAgentNotesRead.mockReset().mockResolvedValue({ ids: [], unread: 0, projectId: 'p1' });
  notesApi.dismissAgentNote.mockReset().mockResolvedValue({ unread: 0 });
  rosterApi.fetchAgentRoster.mockReset().mockResolvedValue({ projectId: 'p1', agents: [], rev: 0 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  notePersonPromoted();
});

describe('GM r3 item 2: Review and Answer locked in a held tab, wherever they are', () => {
  it('the opened list: each stays in place, aria-disabled and focusable, its lock reason its tooltip; nothing opens', async () => {
    render(<AppAgentNotes />);
    held();
    sync();
    const list = openList();
    expect(look(list)).toEqual([
      ['u_cover', 'Review', 'true', REVIEW_LOCK],
      ['u_q', 'Answer', 'true', ANSWER_LOCK],
    ]);
    for (const button of asks(list)) {
      expect(button.hasAttribute('disabled')).toBe(false);
      expect(button.classList.contains('agent-notes-btn--held')).toBe(true);
      button.focus();
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
    }
    await act(async () => { await Promise.resolve(); });
    expect(useProjectStore.getState().screen).toBe('workspace'); // a cover Review would go to Projects
    expect(screen.queryByRole('dialog', { name: /A question from/ })).toBeNull();
  });

  it('only Review and Answer lock: Show on canvas on the same Update stays live', async () => {
    render(<AppAgentNotes />);
    held();
    sync([{ ...COVER, refs: ['n1'] }, QUESTION]);
    const list = openList();
    const show = [...list.querySelectorAll<HTMLButtonElement>('[data-note-id="u_cover"] button')]
      .find((button) => button.textContent === 'Show on canvas');
    expect(show).toBeDefined();
    expect([show!.getAttribute('aria-disabled'), show!.getAttribute('title'), show!.classList.contains('agent-notes-btn--held')])
      .toEqual([null, null, false]);
    expect(look(list)[0]).toEqual(['u_cover', 'Review', 'true', REVIEW_LOCK]);
  });

  it('on the promote only the action turns on: the same buttons, in the same places, with the same words', async () => {
    render(<AppAgentNotes />);
    held();
    sync();
    const list = openList();
    const before = look(list).map(([id, label]) => [id, label]);
    promoteAsks();
    expect(look(list)).toEqual(before.map(([id, label]) => [id, label, null, null]));
    fireEvent.click(asks(list).find((button) => button.textContent === 'Answer')!);
    await waitFor(() => expect(useAgentQuestionsStore.getState().formId).toBe('qs_2'));
  });

  it('the arrival card: the same lock, and its click reads nothing', async () => {
    render(<AppAgentNotes />);
    held();
    sync([], 0);
    notesApi.markAgentNotesRead.mockClear();
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: QUESTION, unread: 1, at: 2 });
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.agent-note-card');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(look(card)).toEqual([['card', 'Answer', 'true', ANSWER_LOCK]]);
    fireEvent.click(asks(card)[0]);
    await act(async () => { await Promise.resolve(); });
    expect(useAgentQuestionsStore.getState().formId).toBeNull();
    expect(notesApi.markAgentNotesRead).not.toHaveBeenCalled();
  });

  it('one rule with the Agents panel rows: every open ask locks while the tab is held', () => {
    const [cover, question] = sanitizeNotes(UPDATES);
    expect(heldLockFor(cover)).toBe(REVIEW_LOCK);
    expect(heldLockFor(question)).toBe(ANSWER_LOCK);
    expect(heldLockFor(cover, false)).toBeNull();
    expect(heldLockFor({ ...question, resolvedAt: new Date().toISOString() })).toBeNull();
  });

  it('the locked look is the shared ghost rule: --disabled-label', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const style = document.createElement('style');
    style.textContent = ['src/components/agent-notes/agentNotes.css', 'src/styles/disabled-buttons.css']
      .map((file) => readFileSync(resolve(__dirname, '..', file), 'utf8')).join('\n');
    document.head.append(style);
    try {
      render(<AppAgentNotes />);
      held();
      sync();
      const list = openList();
      expect(asks(list).map((button) => getComputedStyle(button).color)).toEqual([GREY, GREY]);
      promoteAsks();
      expect(asks(list).every((button) => getComputedStyle(button).color !== GREY)).toBe(true);
    } finally {
      style.remove();
    }
  });
});

describe('GM r3 items 1 and 3: a truthful header, a silent retry on the promote, the line\'s words', () => {
  it('a refused read leaves the header unread and says GM\'s line, curly apostrophes', async () => {
    notesApi.markAgentNotesRead.mockRejectedValue(refused());
    render(<AppAgentNotes />);
    held();
    sync();
    const list = openList();
    await waitFor(() => expect(list.textContent).toContain(MARK_READ_REFUSED_COPY));
    expect(MARK_READ_REFUSED_COPY).toBe('Nebula couldn’t mark the updates as read because this tab isn’t connected as you. '
      + 'Open the link Nebula printed when it started.');
    expect(header(list)).toBe('2 · all unread');
    expect(list.textContent).not.toContain('all read');
    expect(list.textContent).not.toContain('try again');
  });

  it('the promote retries the read once, silently, and the header reaches "all read" for real', async () => {
    notesApi.markAgentNotesRead.mockRejectedValueOnce(refused());
    render(<AppAgentNotes />);
    held();
    sync();
    const list = openList();
    await waitFor(() => expect(list.textContent).toContain(MARK_READ_REFUSED_COPY));
    expect(pendingPromoteRetries()).toBe(1);
    notesApi.markAgentNotesRead.mockResolvedValueOnce({ ids: ['u_cover', 'u_q'], unread: 0, projectId: 'p1' });
    act(() => { notePersonPromoted(); });
    await waitFor(() => expect(header(list)).toBe('2 · all read'));
    expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(2);
    expect(list.textContent).not.toContain(MARK_READ_REFUSED_COPY);
    expect(pendingPromoteRetries()).toBe(0);
  });

  it('a retry that fails leaves the header unread and shows no new line', async () => {
    notesApi.markAgentNotesRead.mockRejectedValue(refused());
    render(<AppAgentNotes />);
    held();
    sync();
    const list = openList();
    await waitFor(() => expect(list.textContent).toContain(MARK_READ_REFUSED_COPY));
    act(() => { notePersonPromoted(); });
    await waitFor(() => expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(header(list)).toBe('2 · all unread');
    expect(useAgentNotesStore.getState().error).toBeNull();
    expect(list.textContent).not.toContain('couldn’t mark');
    expect(pendingPromoteRetries()).toBe(0);
  });

  it('a read refused for another reason keeps its line and isn\'t retried on the promote', async () => {
    notesApi.markAgentNotesRead.mockRejectedValue(new RequestFailedError("Couldn't mark the updates as read.", 500, { detail: 'boom' }));
    render(<AppAgentNotes />);
    sync();
    const list = openList();
    await waitFor(() => expect(useAgentNotesStore.getState().error).toBeTruthy());
    const line = useAgentNotesStore.getState().error;
    expect(line).not.toBe(MARK_READ_REFUSED_COPY);
    expect(pendingPromoteRetries()).toBe(0);
    act(() => { notePersonPromoted(); });
    expect(useAgentNotesStore.getState().error).toBe(line);
    expect(notesApi.markAgentNotesRead).toHaveBeenCalledTimes(1);
    expect(header(list)).toBe('2 · all unread');
  });
});

describe('review 2 MEDIUM: the Krea row\'s line clears on the promote', () => {
  beforeEach(() => {
    krea.getKreaConnection.mockReset().mockResolvedValue({ status: 'disconnected' });
  });

  it('a held tab\'s refused Check connection: gone on the promote', async () => {
    krea.checkKreaConnection.mockReset().mockRejectedValue(new RequestFailedError("Couldn't update the Krea connection.", 403,
      { code: PERSON_REQUIRED_CODE, detail: 'x' }));
    const hook = renderHook(() => useKreaConnection());
    await act(async () => { hook.result.current.check(); });
    await waitFor(() => expect(hook.result.current.error).toBeTruthy());
    act(() => { notePersonPromoted(); });
    expect(hook.result.current.error).toBeNull();
  });

  it('a refusal with another reason stays', async () => {
    krea.checkKreaConnection.mockReset().mockRejectedValue(new RequestFailedError("Couldn't update the Krea connection.", 500, { detail: 'down' }));
    const hook = renderHook(() => useKreaConnection());
    await act(async () => { hook.result.current.check(); });
    await waitFor(() => expect(hook.result.current.error).toBeTruthy());
    const line = hook.result.current.error;
    act(() => { notePersonPromoted(); });
    expect(hook.result.current.error).toBe(line);
  });
});

describe('PR #204 round 4: a tab says it is one; refs keep their bounds', () => {
  it('the Updates read carries X-Nebula-Tab and the socket ?tab=1', async () => {
    const { withTabClaim, TAB_HEADER } = await import('../src/lib/tabId');
    expect(TAB_HEADER).toBe('X-Nebula-Tab');
    expect(withTabClaim('ws://127.0.0.1:8795/ws')).toBe('ws://127.0.0.1:8795/ws?tab=1');
    expect(withTabClaim('ws://h/ws?x=1')).toBe('ws://h/ws?x=1&tab=1');
    const source = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, '../src/lib/agentNotes.ts'), 'utf8');
    expect(source).toMatch(/fetchAgentNotes[\s\S]*?\[TAB_HEADER\]: TAB_ID/);
    const wsSource = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, '../src/lib/wsClient.ts'), 'utf8');
    expect(wsSource).toContain('new WebSocket(withTabClaim(url))');
  });

  it('a shared ref\'s firstSince below 0 is dropped (review 2 NIT)', () => {
    const base = { ...COVER, proposal: { ...COVER.proposal, asks: 2, firstSince: T } };
    expect(sanitizeNotes([base])[0].proposal).toMatchObject({ asks: 2, firstSince: T });
    const [negative] = sanitizeNotes([{ ...base, proposal: { ...base.proposal, firstSince: -1 } }]);
    expect(negative.proposal?.firstSince).toBeUndefined();
    expect(negative.proposal?.asks).toBe(2);
  });
});
