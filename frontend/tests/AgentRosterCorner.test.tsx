import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The Agents panel (Q125 item 2) at the top of the Updates corner: one line
 * collapsed ("Needs you" and "Working" with count badges), the two groups
 * open, live from the roster read and the socket. GM - Design's copy,
 * 2026-10-25, verbatim.
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

function statusEvent(agent: typeof CODEX, text: string | null, nodeId: string | null = 'n4', rev = 1) {
  return { type: 'agentStatus', agent, change: text === null ? 'cleared' : 'set', rev,
    status: text === null ? null : { text, nodeId, projectId: 'p1', at: Date.now(), secondsAgo: 0 } };
}

function placeNode(id: string, label: string) {
  useGraphStore.setState({
    nodes: [...useGraphStore.getState().nodes.filter((n) => n.id !== id),
      { id, type: 'model-node', position: { x: 100, y: 100 },
        data: { label, definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} } }],
  } as never);
  flow.state.nodeLookup.set(id, { internals: { positionAbsolute: { x: 3000, y: 2000 } }, measured: { width: 200, height: 120 } });
}

async function openList() {
  fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
  const list = screen.getByRole('dialog', { name: 'Updates' });
  return list;
}

/** Open the list and let the panel's roster read land (the backend's has nobody yet). */
async function openListRead() {
  const list = await openList();
  await waitFor(() => expect(rosterApi.fetchAgentRoster).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
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

function syncProject() {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes: [], unread: 0, at: 1 });
}

describe('the Agents panel', () => {
  it('is hidden with no agents, and shows one collapsed line with only the groups that have agents', async () => {
    render(<AppAgentNotes />);
    syncProject();
    const list = await openList();
    await waitFor(() => expect(rosterApi.fetchAgentRoster).toHaveBeenCalled());
    expect(within(list).queryByRole('button', { name: /^Agents/ })).toBeNull();

    placeNode('n4', 'Hero shots');
    emit(statusEvent(CODEX, 'Rendering three hero crops'));
    const toggle = await rosterToggle(list);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Working');
    expect(toggle.textContent).not.toContain('Needs you');
    // Collapsed: no rows.
    expect(within(list).queryByRole('button', { name: /Show on canvas/ })).toBeNull();

    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    expect(toggle.textContent).toContain('Needs you');
    const badges = toggle.querySelectorAll('.agent-notes-needs-badge, .agent-roster__badge');
    expect([...badges].map((b) => b.textContent)).toEqual(['1', '1']);
    // GM: the Needs-you badge is the filled pill (the chip's too), never an agent's colour.
    expect(badges[0].classList.contains('agent-notes-needs-badge')).toBe(true);
    expect(badges[1].classList.contains('agent-notes-needs-badge')).toBe(false);
    expect(toggle.closest('section')?.getAttribute('style') ?? '').not.toMatch(/attention/);
  });

  it('opens to two groups; a Working row flies the canvas to its node', async () => {
    render(<AppAgentNotes />);
    syncProject();
    placeNode('n4', 'Hero shots');
    const list = await openListRead();
    emit(statusEvent(CODEX, 'Rendering three hero crops'));
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    fireEvent.click(await rosterToggle(list));
    expect(within(list).getByRole('heading', { name: 'Needs you' })).toBeTruthy();
    expect(within(list).getByRole('heading', { name: 'Working' })).toBeTruthy();

    const working = within(list).getByRole('button', { name: 'Codex, Rendering three hero crops. Show on canvas' });
    expect(working.getAttribute('title')).toBe('Show on canvas');
    expect(within(working).getByText('Rendering three hero crops').getAttribute('title')).toBe('Rendering three hero crops');
    fireEvent.click(working);
    await waitFor(() => expect(flow.setViewport).toHaveBeenCalled());
  });

  it("a Needs-you row opens the question form, and the unverified agent's dot is a ring on both", async () => {
    render(<AppAgentNotes />);
    syncProject();
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    const row = within(list).getByRole('button', { name: 'Claude Code, unverified, 1 question. Open questions' });
    expect(row.getAttribute('title')).toBe('Open questions');
    expect(within(row).getByText('1 question')).toBeTruthy();
    // After a restart there is no status and no cursor: GM's line.
    expect(within(row).getByText('Waiting for your answer.')).toBeTruthy();
    const dot = row.querySelector('.agent-notes-dot');
    expect(dot?.classList.contains('agent-notes-dot--unverified')).toBe(true);
    expect(dot?.getAttribute('title')).toBe('This agent named itself.');

    fireEvent.click(row);
    const form = await screen.findByRole('dialog', { name: 'A question from Claude Code' });
    const formDot = form.querySelector('.agent-notes-dot');
    expect(formDot?.classList.contains('agent-notes-dot--unverified')).toBe(true);
    expect(formDot?.getAttribute('title')).toBe('This agent named itself.');
  });

  it('a Needs-you row with a canvas proposal opens that proposal', async () => {
    render(<AppAgentNotes />);
    syncProject();
    const view = { id: 'p_1', status: 'open', agent: CODEX, note: 'n', projectId: 'p1', createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 600_000, nodes: [], edges: [], params: [], run: [], references: [], cost: {} };
    emit({ type: 'proposalOpened', proposal: view, acceptKey: 'k' });
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    fireEvent.click(within(list).getByRole('button', { name: 'Codex, 1 proposal. Open proposal' }));
    await waitFor(() => expect(useCanvasProposalsStore.getState().focusedId).toBe('p_1'));
  });

  it('updates live: a status cleared falls back to the last action, and the empty line shows when the last one leaves', async () => {
    render(<AppAgentNotes />);
    syncProject();
    placeNode('n4', 'Hero shots');
    const list = await openListRead();
    emit(statusEvent(CODEX, 'Rendering three hero crops'));
    emit({ type: 'agentPresence', agent: CODEX, action: 'move', say: '', at: Date.now(), projectId: 'p1',
      target: { nodeId: 'n4' }, did: { verb: 'Moved', nodeId: 'n4', label: 'Hero shots' } });
    fireEvent.click(await rosterToggle(list));
    expect(within(list).getByRole('button', { name: 'Codex, Rendering three hero crops. Show on canvas' })).toBeTruthy();

    emit(statusEvent(CODEX, null, null, 2));
    expect(within(list).getByRole('button', { name: 'Codex, Moved “Hero shots” · just now. Show on canvas' })).toBeTruthy();

    act(() => useAgentPresenceStore.getState().clear());
    expect(within(list).getByText('No agents are connected right now.')).toBeTruthy();
    // Collapsing it hides the section; with no agents it stays hidden.
    fireEvent.click(within(list).getByRole('button', { name: /^Agents/ }));
    expect(within(list).queryByRole('button', { name: /^Agents/ })).toBeNull();
  });

  it('a new Needs-you item never opens the panel by itself', async () => {
    render(<AppAgentNotes />);
    syncProject();
    placeNode('n4', 'Hero shots');
    const list = await openListRead();
    emit(statusEvent(CODEX, 'Rendering'));
    const toggle = await rosterToggle(list);
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    expect(toggle.textContent).toContain('Needs you');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('reads the roster again after the socket reconnects (a restart clears statuses)', async () => {
    rosterApi.fetchAgentRoster.mockResolvedValue({ projectId: 'p1', rev: 3, agents: [{
      agent: CODEX, group: 'working', status: { text: 'From before', nodeId: null, secondsAgo: 5 },
      lastAction: null, cursor: null, needsYou: { questions: 0, proposals: 0 }, waitingSeconds: null,
      activeSecondsAgo: 5 }] });
    render(<AppAgentNotes />);
    syncProject();
    const list = await openList();
    fireEvent.click(await rosterToggle(list));
    expect(within(list).getByText('From before')).toBeTruthy();
    // A cursor this tab heard before the restart: the read after it is newer, and has none.
    emit({ type: 'agentPresence', agent: CLAUDE, action: 'look', say: '', at: 0, projectId: 'p1',
      target: { x: 1, y: 2 }, did: { verb: 'Looked around', nodeId: null, label: null } });
    expect(within(list).getByText('Looked around · just now')).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    rosterApi.fetchAgentRoster.mockResolvedValue({ projectId: 'p1', rev: 0, agents: [] });
    emit({ type: 'socketReconnected' });
    await waitFor(() => expect(within(list).queryByText('From before')).toBeNull());
    expect(within(list).queryByText('Looked around · just now')).toBeNull();
  });
});

// GM - Design's review of PR #193, item 3: "A waiting question blocks an
// agent, so 'Updates 0' mustn't hide it."
describe('the closed Updates chip marks agents that need the person', () => {
  const chip = () => screen.getByRole('button', { name: /^Updates/ });

  it('shows the Needs-you badge after the unread count, with the count in its name', async () => {
    render(<AppAgentNotes />);
    syncProject();
    expect(chip().getAttribute('aria-label')).toBe('Updates');
    expect(chip().querySelector('.agent-notes-needs-badge')).toBeNull();

    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    expect(chip().getAttribute('aria-label')).toBe('Updates, 0 unread, 1 agent needs you');
    const badge = chip().querySelector('.agent-notes-needs-badge');
    expect(badge?.textContent).toBe('1');
    // After the unread count.
    const count = chip().querySelector('.agent-notes-chip__count');
    expect(count && badge && (count.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();

    const view = { id: 'p_1', status: 'open', agent: CODEX, note: 'n', projectId: 'p1', createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 600_000, nodes: [], edges: [], params: [], run: [], references: [], cost: {} };
    emit({ type: 'proposalOpened', proposal: view, acceptKey: 'k' });
    expect(chip().getAttribute('aria-label')).toBe('Updates, 0 unread, 2 agents need you');
    expect(chip().querySelector('.agent-notes-needs-badge')?.textContent).toBe('2');

    // The same number as the panel's Needs-you group.
    const list = await openList();
    const toggle = await rosterToggle(list);
    expect(toggle.querySelector('.agent-notes-needs-badge')?.textContent).toBe('2');
  });

  it('says the unread count too, and goes away when nothing waits', async () => {
    render(<AppAgentNotes />);
    emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', unread: 2, at: 1, notes: [
      { id: 'u1', source: 'agent', author: { kind: 'agent', name: 'Codex', color: '#5B9DFF' }, text: 'One', refs: [],
        createdAt: Date.now() - 2_000 },
      { id: 'u2', source: 'agent', author: { kind: 'agent', name: 'Codex', color: '#5B9DFF' }, text: 'Two', refs: [],
        createdAt: Date.now() - 1_000 },
    ] });
    emit({ type: 'questionsOpened', set: SET, answerKey: 'k1' });
    expect(chip().getAttribute('aria-label')).toBe('Updates, 2 unread, 1 agent needs you');
    emit({ type: 'questionsClosed', questionId: SET.id, status: 'answered', agentId: CLAUDE.id,
      set: { ...SET, status: 'answered', closedAt: Date.now() } });
    expect(chip().getAttribute('aria-label')).toBe('Updates, 2 unread');
    expect(chip().querySelector('.agent-notes-needs-badge')).toBeNull();
  });

  it('counts only what this tab can answer, as the panel does', () => {
    render(<AppAgentNotes />);
    syncProject();
    // A set heard without its answer key (a tab not connected as the person): Working, not Needs you.
    emit({ type: 'questionsOpened', set: SET });
    expect(chip().getAttribute('aria-label')).toBe('Updates');
  });
});
