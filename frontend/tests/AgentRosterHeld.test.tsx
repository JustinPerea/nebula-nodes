import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * GM, 2026-10-29: the held "agents need you" count. A tab not connected as
 * the person holds no question sets or proposals (they go to the person's
 * sockets only), only their Updates. The open project's unresolved ask
 * Updates come into the shared rule (agentNeedsYou), so the Updates chip's
 * badge and the Agents panel's Needs-you rows read the same held and
 * promoted. A held row keeps the agent's dot, name and lines; its action is
 * locked (aria-disabled, focusable, the lock reason as its tooltip). On the
 * promote only the action turns on: same rows, same order, same words.
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
const { buildRosterRows } = await import('../src/components/agent-notes/agentRosterModel');
const { heldAsks, needsYouCount } = await import('../src/components/agent-notes/agentNeedsYou');
const { sanitizeNotes, MAX_REF_QUESTIONS, MAX_SHARED_ASKS } = await import('../src/lib/agentNotes');

const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };
const CODEX = { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true };

const SET = {
  id: 'qs_1', status: 'open', agent: CLAUDE, note: null, projectId: 'p1', nodeIds: [],
  createdAt: Date.now() - 60_000, closedAt: null, answers: null, update: { id: 'u_q', projectId: 'p1' },
  questions: [{ id: 'q1', text: 'Which crop?', options: ['Square', 'Wide'], multiple: false, allowText: true }],
};

function emit(event: unknown) {
  act(() => {
    for (const handler of [...ws.handlers]) handler(event);
  });
}

async function openList() {
  fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
  const list = screen.getByRole('dialog', { name: 'Updates' });
  return list;
}

async function rosterToggle(list: HTMLElement) {
  return within(list).findByRole('button', { name: /^Agents/ });
}

beforeEach(() => {
  useAgentNotesStore.getState().reset();
  useAgentQuestionsStore.getState().reset();
  useAgentPresenceStore.getState().clear();
  useCanvasProposalsStore.getState().clear();
  useAssetProposalsStore.getState().clear();
  useAgentRosterStore.getState().reset();
  useGraphStore.setState({ nodes: [] } as never);
  flow.state.nodeLookup.clear();
  flow.setViewport.mockReset();
  useProjectStore.setState({ screen: 'workspace' });
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false, viewMode: 'canvas' });
  notesApi.fetchAgentNotes.mockReset().mockResolvedValue({ projectId: 'p1', notes: [], unread: 0 });
  notesApi.markAgentNotesRead.mockReset().mockResolvedValue({ ids: [], unread: 0, projectId: 'p1' });
  notesApi.dismissAgentNote.mockReset().mockResolvedValue({ unread: 0 });
  rosterApi.fetchAgentRoster.mockReset().mockResolvedValue({ projectId: 'p1', agents: [], rev: 0 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(cleanup);

const CURSOR = { id: 'cursor', name: 'Cursor', color: '#E8825A', verified: true };
const T = Date.now() - 120_000;
const REVIEW_LOCK = 'You can review this when this tab is connected as you.';
const ANSWER_LOCK = 'You can answer this when this tab is connected as you.';

function update(id: string, author: typeof CODEX, about: 'proposal' | 'question', extra: Record<string, unknown>) {
  return {
    id, author: { kind: 'agent', ...author }, source: 'nebula', about, at: new Date(T + 60_000).toISOString(),
    text: 'x', parts: [], refs: [], readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
    resolvedAt: null, outcome: null, ...extra,
  };
}

/** Codex's cover ask (oldest), Claude Code's two questions, Cursor's canvas proposal (newest). */
const UPDATES = [
  update('u_cover', CODEX, 'proposal', { proposal: { id: 'pa_cover', kind: 'project', targetId: 'p1', cover: 'image', since: T },
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_cover', target: 'project', targetId: 'p1' } }] }),
  update('u_q', CLAUDE, 'question', { questions: { id: 'qs_2', count: 2, since: T + 1_000 },
    actions: [{ label: 'Answer', op: { kind: 'question.answer', questionId: 'qs_2' } }] }),
  update('u_canvas', CURSOR, 'proposal', { proposal: { id: 'p_canvas', kind: 'canvas', targetId: 'p1', since: T + 2_000 },
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'p_canvas', target: 'canvas', targetId: 'p1' } }] }),
];

function syncUpdates() {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes: UPDATES, unread: 3, at: 1 });
}

/** The person's sync after the promote: the asks themselves, made when their Updates' refs say. */
function promote() {
  emit({ type: 'questionsOpened', answerKey: 'k_q', set: { ...SET, id: 'qs_2', createdAt: T + 1_000,
    update: { id: 'u_q', projectId: 'p1' },
    questions: [SET.questions[0], { ...SET.questions[0], id: 'q2', text: 'Which light?' }] } });
  emit({ type: 'proposalOpened', acceptKey: 'k_c', proposal: { id: 'p_canvas', status: 'open', agent: CURSOR, note: 'n',
    projectId: 'p1', createdAt: T + 2_000, expiresAt: Date.now() + 600_000, nodes: [], edges: [], params: [], run: [],
    references: [], cost: {} } });
  act(() => {
    useAssetProposalsStore.getState().sync([{ ...coverProposal({ id: 'pa_cover', agent: CODEX, createdAt: T,
      target: { kind: 'project', id: 'p1', name: 'Followups' }, update: { id: 'u_cover', projectId: 'p1' } } as never),
    acceptKey: 'k_a' }]);
  });
}

const chip = () => screen.getByRole('button', { name: /^Updates/ });
const rows = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-group="needsYou"]')];
const looks = (list: HTMLElement) => rows(list).map((row) => ({
  name: row.querySelector('.agent-roster__name')?.textContent,
  count: row.querySelector('.agent-roster__count')?.textContent,
  line: row.querySelector('.agent-roster__line')?.textContent,
  dot: row.querySelector<HTMLElement>('.agent-notes-dot')?.getAttribute('style'),
}));

describe('GM 2026-10-29: the held needs-you count', () => {
  it('held: the badge and the Needs-you rows count the asks the Updates name; each row is locked, not hidden', async () => {
    render(<AppAgentNotes />);
    act(() => { useAssetProposalsStore.setState({ awaitingSync: true }); });
    syncUpdates();
    expect(chip().querySelector('.agent-notes-needs-badge')?.textContent).toBe('3');
    expect(chip().getAttribute('aria-label')).toBe('Updates, 3 unread, 3 agents need you');
    const list = await openList();
    const toggle = await rosterToggle(list);
    expect(toggle.querySelector('.agent-notes-needs-badge')?.textContent).toBe('3');
    fireEvent.click(toggle);
    expect(looks(list)).toEqual([
      { name: 'Codex', count: '1 proposal', line: 'Waiting for your OK.', dot: expect.stringContaining('#5B9DFF') },
      { name: 'Claude Code', count: '2 questions', line: 'Waiting for your answer.', dot: expect.stringContaining('#3FC1A5') },
      { name: 'Cursor', count: '1 proposal', line: 'Waiting for your OK.', dot: expect.stringContaining('#E8825A') },
    ]);
    const [cover, questions, canvas] = rows(list);
    for (const row of [cover, questions, canvas]) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(row.hasAttribute('disabled')).toBe(false);
      row.focus();
      expect(document.activeElement).toBe(row);
    }
    expect([cover, questions, canvas].map((row) => row.getAttribute('title'))).toEqual([REVIEW_LOCK, ANSWER_LOCK, REVIEW_LOCK]);
    expect(questions.getAttribute('aria-label')).toBe(`Claude Code, unverified, 2 questions. ${ANSWER_LOCK}`);
    // No placeholder sentence in the row: the lock reason is its tooltip only.
    expect(list.textContent).not.toContain('when this tab is connected as you');
    // Locked: nothing opens, and nothing moves the person (an open cover ask would go to Projects).
    fireEvent.click(cover);
    fireEvent.click(questions);
    fireEvent.click(canvas);
    await act(async () => { await Promise.resolve(); });
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(screen.queryByRole('dialog', { name: /A question from/ })).toBeNull();
    expect(useCanvasProposalsStore.getState().focusedId).toBeNull();
  });

  it('promote: the same badge, the same rows in the same order with the same words; only the action turns on', async () => {
    render(<AppAgentNotes />);
    act(() => { useAssetProposalsStore.setState({ awaitingSync: true }); });
    syncUpdates();
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    const held = looks(list);
    const heldLabel = chip().getAttribute('aria-label');
    promote();
    expect(chip().getAttribute('aria-label')).toBe(heldLabel);
    expect(chip().querySelector('.agent-notes-needs-badge')?.textContent).toBe('3');
    expect(looks(list)).toEqual(held);
    expect(rows(list).map((row) => row.getAttribute('aria-disabled'))).toEqual([null, null, null]);
    expect(rows(list).map((row) => row.getAttribute('title'))).toEqual(['Open proposal', 'Open questions', 'Open proposal']);
    fireEvent.click(rows(list)[2]);
    await waitFor(() => expect(useCanvasProposalsStore.getState().focusedId).toBe('p_canvas'));
  });

  it('a resolved Update, a reader\'s note and an ask this tab holds add nothing', () => {
    const resolved = { ...UPDATES[0], resolvedAt: new Date().toISOString() };
    const reader = { ...UPDATES[2], author: { kind: 'reader', id: 'r', name: 'Reader', color: '#fff' } };
    const asks = heldAsks(sanitizeNotes([resolved, reader, UPDATES[1]]), (id) => id === 'qs_2');
    expect(asks).toEqual([]);
    expect(heldAsks(sanitizeNotes(UPDATES), () => false).map((ask) => [ask.kind, ask.id, ask.createdAt, ask.count]))
      .toEqual([['proposal', 'pa_cover', T, 1], ['questions', 'qs_2', T + 1_000, 2], ['proposal', 'p_canvas', T + 2_000, 1]]);
  });

  it('one rule: an ask held and its view count once, and the badge is the Needs-you group', () => {
    const asks = heldAsks(sanitizeNotes(UPDATES), () => false);
    const view = { ...coverProposal({ id: 'pa_cover', agent: CODEX, createdAt: T }), update: { id: 'u_cover', projectId: 'p1' } };
    const input = { projectId: 'p1', questions: [], canvasProposals: [], assetProposals: [view as never], held: asks };
    expect(needsYouCount(input)).toBe(3);
    const built = buildRosterRows({ ...input, now: Date.now(), statuses: [], cursors: [], nodeLabel: () => null });
    expect(built.filter((row) => row.group === 'needsYou').map((row) => [row.agent.name, row.countLine, row.locked]))
      .toEqual([['Codex', '1 proposal', null], ['Claude Code', '2 questions', ANSWER_LOCK], ['Cursor', '1 proposal', REVIEW_LOCK]]);
  });
});

describe('GM, PR #204 round 1: a held row reads disabled', () => {
  const sheets = ['src/components/agent-notes/agentNotes.css', 'src/components/agent-notes/agentRoster.css',
    'src/styles/disabled-buttons.css'];
  let style: HTMLStyleElement;
  beforeEach(async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    style = document.createElement('style');
    // The shared helper's own selectors, applied by the real sheets (jsdom resolves no var(), so the declared value is read).
    style.textContent = sheets.map((file) => readFileSync(resolve(__dirname, '..', file), 'utf8')).join('\n');
    document.head.append(style);
  });
  afterEach(() => style.remove());

  const ink = (row: HTMLElement) => ['.agent-roster__name', '.agent-roster__count', '.agent-roster__line']
    .map((selector) => getComputedStyle(row.querySelector(selector)!).color);
  const dotInk = (row: HTMLElement) => getComputedStyle(row.querySelector('.agent-notes-dot')!).color;
  const GREY = 'var(--disabled-label, rgba(255, 255, 255, 0.55))';

  it('every line of a held row, the name included, takes the shared grey; the dot keeps its colour; promoted, its own inks come back', async () => {
    render(<AppAgentNotes />);
    act(() => { useAssetProposalsStore.setState({ awaitingSync: true }); });
    syncUpdates();
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    const dotsHeld = rows(list).map(dotInk);
    for (const row of rows(list)) expect(ink(row)).toEqual([GREY, GREY, GREY]);
    expect(dotsHeld.every((value) => value !== GREY)).toBe(true);
    promote();
    for (const row of rows(list)) expect(ink(row).some((value) => value === GREY)).toBe(false);
    expect(rows(list).map(dotInk)).toEqual(dotsHeld);
  });
});

describe('PR #204 review 1 MEDIUM-1: two asks that share one Update', () => {
  // The reviewer's repro: Codex asks for cover A, Claude Code asks one question,
  // then Codex asks for cover B. Codex's two asks share one Update, which names
  // only the newest (B); the ref's `asks` and `firstSince` say what it stands for.
  const A = T;
  const Q = T + 1_500;
  const B = T + 3_000;
  const shared = (asks: number, firstSince: number, id = 'pa_b', since = B) => update('u_cover', CODEX, 'proposal', {
    proposal: { id, kind: 'project', targetId: 'p1', cover: 'image', since, asks, firstSince },
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: id, target: 'project', targetId: 'p1' } }] });
  const question = update('u_q1', CLAUDE, 'question', { questions: { id: 'qs_1', count: 1, since: Q },
    actions: [{ label: 'Answer', op: { kind: 'question.answer', questionId: 'qs_1' } }] });
  const sync = (notes: unknown[]) => emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes,
    unread: notes.length, at: 1 });
  const changed = (note: unknown) => emit({ type: 'agentNotes', surface: 'canvas', op: 'changed', projectId: 'p1',
    ids: ['u_cover'], note, at: 2 });
  const cover = (id: string, createdAt: number) => ({ ...coverProposal({ id, agent: CODEX, createdAt,
    target: { kind: 'project', id: 'p1', name: 'Followups' }, update: { id: 'u_cover', projectId: 'p1' } } as never), acceptKey: `k_${id}` });
  const promoteBoth = () => {
    emit({ type: 'questionsOpened', answerKey: 'k_q1', set: { ...SET, id: 'qs_1', createdAt: Q, update: { id: 'u_q1', projectId: 'p1' } } });
    act(() => { useAssetProposalsStore.getState().sync([cover('pa_a', A), cover('pa_b', B)]); });
  };
  const summary = (list: HTMLElement) => looks(list).map((row) => `${row.name}: ${row.count}`);

  it('held and promoted read the same: the full count, in the order of the oldest ask, with the same badge', async () => {
    render(<AppAgentNotes />);
    act(() => { useAssetProposalsStore.setState({ awaitingSync: true }); });
    sync([shared(2, A), question]);
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    const held = summary(list);
    expect(held).toEqual(['Codex: 2 proposals', 'Claude Code: 1 question']);
    const badge = chip().querySelector('.agent-notes-needs-badge')?.textContent;
    expect(badge).toBe('2');
    promoteBoth();
    expect(summary(list)).toEqual(held);
    expect(chip().querySelector('.agent-notes-needs-badge')?.textContent).toBe(badge);
    expect(rows(list).map((row) => row.getAttribute('aria-disabled'))).toEqual([null, null]);
  });

  it('one of the two closing while the tab is held: the Update says one, and so does the row', async () => {
    render(<AppAgentNotes />);
    act(() => { useAssetProposalsStore.setState({ awaitingSync: true }); });
    sync([shared(2, A), question]);
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    // A withdrawn: the Update stays on B, now standing for one, from B's time.
    changed(shared(1, B));
    expect(summary(list)).toEqual(['Claude Code: 1 question', 'Codex: 1 proposal']);
    emit({ type: 'questionsOpened', answerKey: 'k_q1', set: { ...SET, id: 'qs_1', createdAt: Q, update: { id: 'u_q1', projectId: 'p1' } } });
    act(() => { useAssetProposalsStore.getState().sync([cover('pa_b', B)]); });
    expect(summary(list)).toEqual(['Claude Code: 1 question', 'Codex: 1 proposal']);
  });

  it('an undo reopening the closed one: the Update counts it again, held as promoted', async () => {
    render(<AppAgentNotes />);
    act(() => { useAssetProposalsStore.setState({ awaitingSync: true }); });
    sync([shared(1, B), question]);
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    expect(summary(list)).toEqual(['Claude Code: 1 question', 'Codex: 1 proposal']);
    changed(shared(2, A));
    expect(summary(list)).toEqual(['Codex: 2 proposals', 'Claude Code: 1 question']);
    promoteBoth();
    expect(summary(list)).toEqual(['Codex: 2 proposals', 'Claude Code: 1 question']);
  });

  it('an Update with no share fields (an older backend) still counts one, from its own time', () => {
    const [ask] = heldAsks(sanitizeNotes([update('u', CODEX, 'proposal', { proposal: { id: 'pa_x', kind: 'project', targetId: 'p1', since: B },
      actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_x', target: 'project', targetId: 'p1' } }] })]), () => false);
    expect(ask).toMatchObject({ count: 1, createdAt: B });
  });
});

describe('PR #204 review 1 NIT-1: the guards a mutant survived', () => {
  it('heldAsks skips a proposal this tab holds even when no view of it is in the count (a closed view, its Update not yet resolved)', () => {
    const notes = sanitizeNotes([UPDATES[0]]);
    expect(heldAsks(notes, (id) => id === 'pa_cover')).toEqual([]);
    expect(heldAsks(notes, () => false)).toHaveLength(1);
    // The badge with the view gone (closing) but the tab still holding it: nothing waits.
    expect(needsYouCount({ projectId: 'p1', questions: [], canvasProposals: [], assetProposals: [],
      held: heldAsks(notes, (id) => id === 'pa_cover') })).toBe(0);
  });

  it('a question ref outside 1..MAX_REF_QUESTIONS reads as no count', () => {
    const at = (count: unknown) => sanitizeNotes([update('u', CLAUDE, 'question', { questions: { id: 'qs_x', count, since: T },
      actions: [] })])[0].questionsCount;
    expect(at(MAX_REF_QUESTIONS)).toBe(MAX_REF_QUESTIONS);
    expect(at(MAX_REF_QUESTIONS + 1)).toBeNull();
    expect(at(0)).toBeNull();
    expect(at(99)).toBeNull();
  });

  it('a shared ref outside 1..MAX_SHARED_ASKS reads as no count', () => {
    const at = (asks: unknown) => sanitizeNotes([update('u', CODEX, 'proposal', { proposal: { id: 'pa', kind: 'project', targetId: 'p1', asks },
      actions: [] })])[0].proposal?.asks;
    expect(at(MAX_SHARED_ASKS)).toBe(MAX_SHARED_ASKS);
    expect(at(MAX_SHARED_ASKS + 1)).toBeUndefined();
    expect(at(0)).toBeUndefined();
  });
});
