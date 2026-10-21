import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentNote, AgentNotesSurface } from '../src/lib/agentNotes';

/**
 * A board's own Updates in Moodboard Studio (Justin's Q113 c, 2026-10-21):
 * "Two sections in one list: "This board" first, then the project. One chip
 * with one count (both added), opening it reads both, and an empty board
 * section is hidden." Board Updates show only in the Studio on that board;
 * every other screen keeps the open project's list alone (Q107 a).
 */

const flow = vi.hoisted(() => ({
  state: {
    transform: [0, 0, 1] as [number, number, number],
    width: 1440,
    height: 900,
    minZoom: 0.1,
    nodes: [] as unknown[],
    userSelectionActive: false,
    nodeLookup: new Map<string, unknown>(),
  },
  setViewport: vi.fn(),
}));
const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const api = vi.hoisted(() => ({
  fetchAgentNotes: vi.fn(),
  markAgentNotesRead: vi.fn(),
  dismissAgentNote: vi.fn(),
}));

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
  ...api,
}));

const { AppAgentNotes } = await import('../src/components/agent-notes/AgentNotesCorner');
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const { useUIStore } = await import('../src/store/uiStore');
const { useProjectStore } = await import('../src/store/projectStore');
const { useBoardCanvasStore } = await import('../src/store/boardCanvasStore');

const CLAUDE = { kind: 'agent', id: 'claude', name: 'Claude Code', color: '#E8825A' } as const;
const ARGON = { kind: 'reader', id: 'argon', name: 'Gemini 4 Argon', color: '#B4A7FF' } as const;
let clock = Date.parse('2026-10-21T12:14:00.000Z');

function note(id: string, overrides: Partial<AgentNote> = {}): AgentNote {
  clock += 1000;
  return {
    id, author: CLAUDE, source: 'agent', about: 'other', at: new Date(clock).toISOString(),
    text: `update ${id}`, parts: [{ text: `update ${id}` }], refs: ['n4'], actions: [],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null, ...overrides,
  };
}

/** A board update about image i2 (#2 on the board), as the server draws it. */
function boardNote(id: string, overrides: Partial<AgentNote> = {}): AgentNote {
  return note(id, {
    text: `board ${id} about #2`, parts: [{ text: `board ${id} about ` }, { ref: 'i2', number: 2 }],
    refs: ['i2'], ...overrides,
  });
}

function emit(event: unknown) {
  act(() => {
    for (const handler of ws.handlers) handler(event);
  });
}

function syncProject(notes: AgentNote[], projectId: string | null = 'p1') {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId, notes,
    unread: notes.filter((n) => !n.readAt && !n.dismissedAt).length, at: 1 });
}

function boardAdded(n: AgentNote, unread: number, boardId = 'b1') {
  emit({ type: 'agentNotes', surface: 'board', op: 'added', boardId, note: n, unread, at: 2, removed: [] });
}

/** What GET .../agent-notes answers, per surface. */
let lists: { canvas: AgentNote[]; boards: Record<string, AgentNote[]> };

function unreadOf(notes: AgentNote[]) {
  return notes.filter((n) => !n.readAt && !n.dismissedAt).length;
}

function chip() {
  return screen.getByRole('button', { name: /^Updates/ });
}

function openList() {
  fireEvent.click(chip());
  return screen.getByRole('dialog', { name: 'Updates' });
}

const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const initialBoards = useBoardCanvasStore.getState();

/** Moodboard Studio with board b1 open: its images are i1, i2, i3 (#1, #2, #3). */
function inStudio(boardId = 'b1') {
  useProjectStore.setState({ screen: 'workspace' });
  useUIStore.setState({ viewMode: 'moodboard-editor', moodboardEditorId: boardId });
  useBoardCanvasStore.setState({ studioBoard: { boardId, boardKey: `k-${boardId}`, imageIds: ['i1', 'i2', 'i3'] } });
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  useAgentNotesStore.getState().reset();
  useUIStore.setState({ ...initialUI, agentLogEnabled: true }, true);
  useProjectStore.setState({
    ...initialProjects, screen: 'workspace', initialized: true, loading: false,
    activeProject: { id: 'p1', name: 'Harbor' } as never,
  }, true);
  useBoardCanvasStore.setState({ ...initialBoards, studioBoard: null, showRequest: null }, true);
  lists = { canvas: [], boards: {} };
  api.fetchAgentNotes.mockReset().mockImplementation(async (surface: AgentNotesSurface) => (surface.kind === 'board'
    ? { boardId: surface.boardId, notes: lists.boards[surface.boardId] ?? [],
      unread: unreadOf(lists.boards[surface.boardId] ?? []), keptWith: 'board' }
    : { projectId: 'p1', notes: lists.canvas, unread: unreadOf(lists.canvas), keptWith: 'project' }));
  api.markAgentNotesRead.mockReset().mockImplementation(async () => ({ ids: [], unread: 0 }));
  api.dismissAgentNote.mockReset().mockImplementation(async () => ({ unread: 0 }));
  flow.setViewport.mockReset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
  useBoardCanvasStore.setState(initialBoards, true);
});

describe('Moodboard Studio shows the open board\'s Updates beside the project\'s (Q113 c)', () => {
  it('two sections in one list: "This board" first, then the project, each saying where it is kept', async () => {
    lists.boards.b1 = [boardNote('an_b1')];
    inStudio();
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    const dialog = openList();
    const sections = within(dialog).getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['This board', 'This project']);
    expect(within(sections[0]).getByText('kept with this board')).toBeTruthy();
    expect(within(sections[1]).getByText('kept with Harbor')).toBeTruthy();
    expect(within(sections[0]).getByText('board an_b1 about #2')).toBeTruthy();
    expect(within(sections[1]).getByText('update an_p1')).toBeTruthy();
    // The header keeps the count of both and the read state.
    expect(dialog.querySelector('.agent-notes-panel__count')!.textContent).toBe('2 · all read');
  });

  it('loads the board\'s list when the Studio opens a board', async () => {
    inStudio();
    render(<AppAgentNotes />);
    await settle();
    expect(api.fetchAgentNotes).toHaveBeenCalledWith({ kind: 'board', boardId: 'b1' });
  });

  it('with no board Updates the list is the project\'s, exactly as on other screens', async () => {
    inStudio();
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    const dialog = openList();
    expect(within(dialog).queryAllByRole('region')).toHaveLength(0);
    expect(within(dialog).queryByText('This board')).toBeNull();
    expect(dialog.querySelector('.agent-notes-panel__kept')!.textContent).toBe('kept with Harbor');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
  });

  it('one chip, one count: the board\'s unread plus the project\'s', async () => {
    lists.boards.b1 = [boardNote('an_b1'), boardNote('an_b2')];
    inStudio();
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    expect(chip().getAttribute('aria-label')).toBe('Updates, 3 unread');
  });

  it('opening the list reads both lists', async () => {
    lists.boards.b1 = [boardNote('an_b2'), boardNote('an_b1')];
    inStudio();
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    openList();
    await settle();
    expect(api.markAgentNotesRead).toHaveBeenCalledWith({ kind: 'board', boardId: 'b1' }, 'an_b2');
    expect(api.markAgentNotesRead).toHaveBeenCalledWith({ kind: 'canvas' }, 'an_p1');
    fireEvent.click(chip());
    expect(chip().getAttribute('aria-label')).toBe('Updates');
  });

  it('a board update from the socket lands live: the count rises, a card drops, and it is in the board section', async () => {
    inStudio();
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
    boardAdded(boardNote('an_live'), 1);
    expect(chip().getAttribute('aria-label')).toBe('Updates, 2 unread');
    await vi.waitFor(() => expect(document.querySelector('.agent-note-card')?.textContent).toContain('board an_live about #2'));
    const dialog = openList();
    const [board] = within(dialog).getAllByRole('region');
    expect(board.getAttribute('aria-label')).toBe('This board');
    expect(within(board).getByText('board an_live about #2')).toBeTruthy();
  });

  it('an update for another board is neither counted nor shown', async () => {
    inStudio();
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    boardAdded(boardNote('an_other'), 1, 'b9');
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector('.agent-note-card')?.textContent ?? '').not.toContain('an_other');
    expect(within(openList()).queryByText(/an_other/)).toBeNull();
  });

  it('a board update posted while the person was elsewhere drops no card when they open the board later', async () => {
    useUIStore.setState({ viewMode: 'canvas' });
    render(<AppAgentNotes />);
    syncProject([]);
    boardAdded(boardNote('an_earlier'), 1);
    lists.boards.b1 = [boardNote('an_earlier')];
    act(() => inStudio());
    await settle();
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector('.agent-note-card')).toBeNull();
  });

  it('draws board numbers as the board is now, and Show #n selects and frames it on the board', async () => {
    lists.boards.b1 = [boardNote('an_b1')];
    useProjectStore.setState({ screen: 'workspace' });
    useUIStore.setState({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    // i1 was removed since the server drew "#2": i2 is #1 now.
    useBoardCanvasStore.setState({ studioBoard: { boardId: 'b1', boardKey: 'k-b1', imageIds: ['i2', 'i3'] } });
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    const dialog = openList();
    const [board] = within(dialog).getAllByRole('region');
    expect(within(board).getByText('board an_b1 about #1')).toBeTruthy();
    fireEvent.click(within(board).getByRole('button', { name: 'Show #1' }));
    expect(useBoardCanvasStore.getState().showRequest).toMatchObject({ boardId: 'b1', imageIds: ['i2'] });
    // The same screen: the list stays open, as Show on the canvas does there.
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
  });

  it('a Nebula action that has no route on main yet says so and changes nothing', async () => {
    lists.boards.b1 = [boardNote('an_run', {
      author: ARGON, source: 'nebula', about: 'analyze',
      actions: [{ label: 'Undo the sort', op: { kind: 'run.undo', boardId: 'b1', runId: 'r1' } }],
    })];
    inStudio();
    render(<AppAgentNotes />);
    syncProject([]);
    await settle();
    const dialog = openList();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo the sort' }));
    await vi.waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/Undo the sort.*can't run here yet/));
    expect(api.dismissAgentNote).not.toHaveBeenCalled();
    expect(useBoardCanvasStore.getState().showRequest).toBeNull();
  });

  it('a card\'s dismiss goes to the board\'s own list', async () => {
    inStudio();
    render(<AppAgentNotes />);
    syncProject([]);
    await settle();
    boardAdded(boardNote('an_live'), 1);
    await vi.waitFor(() => expect(document.querySelector('.agent-note-card')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this update' }));
    await settle();
    expect(api.dismissAgentNote).toHaveBeenCalledWith({ kind: 'board', boardId: 'b1' }, 'an_live');
  });

  it('reads the board\'s list again after the socket reconnects', async () => {
    inStudio();
    render(<AppAgentNotes />);
    await settle();
    api.fetchAgentNotes.mockClear();
    lists.boards.b1 = [boardNote('an_missed')];
    emit({ type: 'socketReconnected' });
    await settle();
    expect(api.fetchAgentNotes).toHaveBeenCalledWith({ kind: 'board', boardId: 'b1' });
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
  });
});

describe('where board Updates show, and where they don\'t', () => {
  it('a Global board (in no project) shows its section above the open project\'s, the same way', async () => {
    lists.boards.g1 = [boardNote('an_g')];
    inStudio('g1');
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    const sections = within(openList()).getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['This board', 'This project']);
  });

  it('with no project open, a board with Updates still shows its own list (and only that)', async () => {
    useProjectStore.setState({ screen: 'home', activeProject: null });
    lists.boards.b1 = [boardNote('an_b1')];
    render(<AppAgentNotes />);
    syncProject([], null);
    act(() => {
      useUIStore.setState({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
      useBoardCanvasStore.setState({ studioBoard: { boardId: 'b1', boardKey: 'k-b1', imageIds: ['i1', 'i2'] } });
    });
    await settle();
    const dialog = openList();
    expect(within(dialog).queryAllByRole('region')).toHaveLength(0);
    expect(dialog.querySelector('.agent-notes-panel__kept')!.textContent).toBe('kept with this board');
    expect(within(dialog).getByText('board an_b1 about #2')).toBeTruthy();
  });

  it('with no project open and no board Updates there is no corner', async () => {
    useProjectStore.setState({ screen: 'home', activeProject: null });
    render(<AppAgentNotes />);
    syncProject([], null);
    act(() => {
      useUIStore.setState({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
      useBoardCanvasStore.setState({ studioBoard: { boardId: 'b1', boardKey: 'k-b1', imageIds: ['i1'] } });
    });
    await settle();
    expect(screen.queryByRole('button', { name: /^Updates/ })).toBeNull();
  });

  it.each(['canvas', 'commons', 'create'] as const)('on %s only the project\'s list shows, never a board\'s', async (where) => {
    lists.boards.b1 = [boardNote('an_b1')];
    inStudio();
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    expect(chip().getAttribute('aria-label')).toBe('Updates, 2 unread');
    act(() => {
      // Leaving the Studio unmounts it, which clears the board it published.
      useUIStore.setState({ viewMode: where });
      useBoardCanvasStore.setState({ studioBoard: null });
    });
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
    boardAdded(boardNote('an_b2'), 2);
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
    const dialog = openList();
    expect(within(dialog).queryAllByRole('region')).toHaveLength(0);
    expect(within(dialog).queryByText(/board an_b/)).toBeNull();
    await settle();
    expect(api.markAgentNotesRead).not.toHaveBeenCalledWith({ kind: 'board', boardId: 'b1' }, expect.anything());
  });

  it('a board the Studio has not published (a new, unsaved draft) shows no board section', async () => {
    lists.boards.b1 = [boardNote('an_b1')];
    useUIStore.setState({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    render(<AppAgentNotes />);
    syncProject([note('an_p1')]);
    await settle();
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
    expect(api.fetchAgentNotes).not.toHaveBeenCalledWith({ kind: 'board', boardId: 'b1' });
  });
});
