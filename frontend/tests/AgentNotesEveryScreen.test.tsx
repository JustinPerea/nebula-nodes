import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentNote } from '../src/lib/agentNotes';

/**
 * The Updates corner on every screen (Justin's Q107 a, 2026-10-21): "Show it
 * on every screen, with the open project's Updates." The same list, count,
 * Review and outcomes as on the canvas; socket updates land live wherever
 * the person is. Review and Show work from any screen. Hidden with no
 * project open. On a screen with a header it sits over the header's own
 * slot (the layout's reserved room), not over that screen's controls, and
 * it never takes a screen's keys (Cmd+Z in Moodboard Studio, the canvas's).
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

// The Agents panel's roster read (Q125 item 2): nobody around in these tests.
vi.mock('../src/lib/agentRoster', () => ({ fetchAgentRoster: async () => ({ projectId: null, agents: [], rev: 0 }) }));
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
const { useAssetProposalsStore } = await import('../src/store/assetProposalsStore');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { isStudioShortcutTarget } = await import('../src/components/moodboard-studio/studioKeys');
const { isCanvasShortcutTarget } = await import('../src/lib/canvasShortcutScope');

const CLAUDE = { kind: 'agent', id: 'claude', name: 'Claude Code', color: '#E8825A' } as const;
let clock = Date.parse('2026-10-21T12:14:00.000Z');

function note(id: string, overrides: Partial<AgentNote> = {}): AgentNote {
  clock += 1000;
  return {
    id, author: CLAUDE, source: 'agent', about: 'other', at: new Date(clock).toISOString(),
    text: `update ${id}`, parts: [{ text: `update ${id}` }], refs: ['n4'], actions: [],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null, ...overrides,
  };
}

function ask(target: 'project' | 'moodboard' | 'commons', targetId: string, overrides: Partial<AgentNote> = {}) {
  const text = `Claude Code asks about ${target}`;
  return note(`an_${target}`, {
    source: 'nebula', about: 'proposal', text, parts: [{ text }], refs: [],
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_1', target, targetId } }],
    ...overrides,
  });
}

function emit(event: unknown) {
  act(() => {
    for (const handler of ws.handlers) handler(event);
  });
}

function sync(notes: AgentNote[], projectId: string | null = 'p1') {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId, notes,
    unread: notes.filter((n) => !n.readAt && !n.dismissedAt).length, at: 1 });
}

function chip() {
  return screen.getByRole('button', { name: /^Updates/ });
}

function openEntry(): HTMLElement {
  fireEvent.click(chip());
  return within(screen.getByRole('dialog', { name: 'Updates' })).getAllByRole('listitem')[0];
}

const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const open = vi.fn(async (id: string) => {
  void id;
  useProjectStore.setState({ screen: 'workspace' });
});
const goHome = vi.fn(async () => {
  useProjectStore.setState({ screen: 'home' });
});

/** Put the person on a screen. */
function on(where: 'home' | 'canvas' | 'moodboard-editor' | 'commons' | 'create' | 'character-editor') {
  if (where === 'home') {
    useProjectStore.setState({ screen: 'home' });
    useUIStore.setState({ viewMode: 'canvas' });
  } else {
    useProjectStore.setState({ screen: 'workspace' });
    useUIStore.setState({ viewMode: where });
  }
}

beforeEach(() => {
  useAgentNotesStore.getState().reset();
  useAssetProposalsStore.getState().clear();
  useUIStore.setState({ ...initialUI, agentLogEnabled: true, commonsEnabled: true }, true);
  useProjectStore.setState({
    ...initialProjects, screen: 'workspace', initialized: true, loading: false,
    activeProject: { id: 'p1', name: 'Harbor' } as never, open, goHome,
  }, true);
  open.mockClear();
  goHome.mockClear();
  api.fetchAgentNotes.mockReset().mockResolvedValue({ projectId: 'p1', notes: [], unread: 0, keptWith: 'project' });
  api.markAgentNotesRead.mockReset().mockImplementation(async () => ({ ids: [], unread: 0, projectId: 'p1' }));
  api.dismissAgentNote.mockReset().mockImplementation(async () => ({ unread: 0, projectId: 'p1' }));
  flow.setViewport.mockReset();
  flow.state.nodeLookup = new Map([
    ['n4', { id: 'n4', measured: { width: 240, height: 160 }, internals: { positionAbsolute: { x: 2000, y: 1500 } } }],
  ]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-test-fixture]').forEach((el) => el.remove());
  vi.useRealTimers();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
});

describe('the corner shows the open project\'s Updates on every screen', () => {
  it.each(['home', 'canvas', 'moodboard-editor', 'commons', 'create', 'character-editor'] as const)(
    'on %s: the same list and count, and an update from the socket lands live',
    async (where) => {
      on(where);
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
      emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2'), unread: 2, at: 2, removed: [] });
      expect(chip().getAttribute('aria-label')).toBe('Updates, 2 unread');
      // The card drops here too, not only on the canvas.
      await vi.waitFor(() => expect(document.querySelector('.agent-note-card')).not.toBeNull());
    },
  );

  it('loads the open project\'s list when it first mounts off the canvas', async () => {
    on('home');
    api.fetchAgentNotes.mockResolvedValue({ projectId: 'p1', notes: [note('an_9')], unread: 1, keptWith: 'project' });
    render(<AppAgentNotes />);
    await vi.waitFor(() => expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread'));
    expect(api.fetchAgentNotes).toHaveBeenCalledWith({ kind: 'canvas' });
  });

  it('is hidden on Projects while no project is open, and shows once one is', () => {
    on('home');
    useProjectStore.setState({ activeProject: null });
    api.fetchAgentNotes.mockResolvedValue({ projectId: null, notes: [], unread: 0, keptWith: 'project' });
    render(<AppAgentNotes />);
    sync([], null);
    expect(screen.queryByRole('button', { name: /^Updates/ })).toBeNull();
    expect(document.body.classList.contains('agent-notes-shown')).toBe(false);
    sync([note('an_1')], 'p2');
    expect(chip()).toBeTruthy();
    expect(document.body.classList.contains('agent-notes-shown')).toBe(true);
  });

  it('reserves the canvas\'s corner for the docked chat only on the canvas', () => {
    on('moodboard-editor');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    expect(document.body.classList.contains('agent-notes-reserved')).toBe(false);
    act(() => on('canvas'));
    expect(document.body.classList.contains('agent-notes-reserved')).toBe(true);
  });

  it('names the open project off the canvas, where "this project" is unclear', () => {
    on('home');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    expect(within(screen.getByRole('dialog', { name: 'Updates' })).getByText('kept with Harbor')).toBeTruthy();
  });

  it('shows a restarted ask\'s outcome in place of Review (Q108 a)', () => {
    on('home');
    render(<AppAgentNotes />);
    sync([ask('project', 'dusk', { readAt: '2026-10-21T12:30:00.000Z', resolvedAt: '2026-10-21T12:30:00.000Z',
      outcome: 'Closed: Nebula restarted' })]);
    const entry = openEntry();
    expect(entry.textContent).toContain('Closed: Nebula restarted');
    expect(within(entry).queryByRole('button', { name: 'Review' })).toBeNull();
  });
});

describe('Review from any screen lands where the person decides', () => {
  it('a cover ask from Moodboard Studio or the Commons opens Projects at that card', async () => {
    for (const where of ['moodboard-editor', 'commons'] as const) {
      on(where);
      render(<AppAgentNotes />);
      sync([ask('project', 'dusk')]);
      fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
      await vi.waitFor(() => expect(goHome).toHaveBeenCalled());
      expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'project', targetId: 'dusk' });
      cleanup();
      goHome.mockClear();
    }
  });

  it('a board\'s ask from Projects opens the workspace on Moodboard Studio at that board', async () => {
    on('home');
    render(<AppAgentNotes />);
    sync([ask('moodboard', 'mb1')]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('p1'));
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(useUIStore.getState().viewMode).toBe('moodboard-editor');
    expect(useUIStore.getState().moodboardEditorId).toBe('mb1');
    expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'moodboard', targetId: 'mb1' });
  });

  it('a Commons ask from Projects opens the workspace on the Commons', async () => {
    on('home');
    render(<AppAgentNotes />);
    sync([ask('commons', 'ast_1')]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('p1'));
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(useUIStore.getState().viewMode).toBe('commons');
    expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'commons', targetId: 'ast_1' });
  });

  it('closes the list on Review, so the strip it leads to is not under it', async () => {
    on('commons');
    render(<AppAgentNotes />);
    sync([ask('project', 'dusk')]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(goHome).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull());
  });

  it('a board\'s ask from the Commons opens Moodboard Studio on that board', async () => {
    on('commons');
    render(<AppAgentNotes />);
    sync([ask('moodboard', 'mb1')]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('moodboard-editor'));
    expect(useUIStore.getState().moodboardEditorId).toBe('mb1');
    expect(open).not.toHaveBeenCalled();
  });
});

describe("a canvas proposal's Update (Justin's Q112 a)", () => {
  function canvasAsk(overrides: Partial<AgentNote> = {}) {
    const text = 'Claude Code proposes 3 changes on the canvas';
    return note('an_canvas', {
      source: 'nebula', about: 'proposal', text, parts: [{ text }], refs: [],
      actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'p_1', target: 'canvas', targetId: 'p1' } }],
      ...overrides,
    });
  }

  function proposalView(id: string) {
    return {
      id, status: 'open', agent: { id: 'claude', name: 'Claude Code', color: '#E8825A', verified: false },
      note: 'Hero from the cat line', projectId: 'p1', createdAt: Date.now(), expiresAt: Date.now() + 600_000,
      nodes: [{ ref: '+img', definitionId: 'nano-banana', name: 'Nano Banana', category: 'image', params: {},
        position: { x: 2400, y: 1500 }, cost: { kind: 'paid', provider: 'google', label: 'paid · google' },
        runs: true, willRun: true, ports: { inputs: [], outputs: [] } }],
      edges: [], params: [], run: ['+img'],
      cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: false, providers: ['google'], nodes: [], note: '' },
      references: ['n4'], reason: null, idMap: null, runNodeIds: null,
    } as never;
  }

  /** The canvas mounted, its bar showing the person's proposals. */
  function canvasWithBar(id: string | null) {
    if (id) useCanvasProposalsStore.getState().open(proposalView(id), 'key');
    for (const name of ['react-flow__renderer', 'proposal-bar']) {
      const el = document.createElement('div');
      el.className = name;
      el.tabIndex = -1;
      el.dataset.testFixture = 'true';
      document.body.appendChild(el);
    }
  }

  beforeEach(() => {
    useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  });

  it('Review from Projects opens the project on its canvas with that proposal in the bar', async () => {
    on('home');
    render(<AppAgentNotes />);
    sync([canvasAsk()]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('p1'));
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(useUIStore.getState().viewMode).toBe('canvas');
    canvasWithBar('p_1');
    await vi.waitFor(() => expect(useCanvasProposalsStore.getState().focusedId).toBe('p_1'));
    // Its ghosts come into view on the corner's spring, and the bar takes the keyboard.
    await vi.waitFor(() => expect(flow.setViewport).toHaveBeenCalled());
    expect(document.activeElement?.classList.contains('proposal-bar')).toBe(true);
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull());
  });

  it('Review from a studio goes back to the canvas the way its Back does', async () => {
    on('moodboard-editor');
    useUIStore.setState({ moodboardEditorId: 'mb1' });
    render(<AppAgentNotes />);
    sync([canvasAsk()]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    expect(useUIStore.getState().moodboardEditorId).toBeNull();
    expect(open).not.toHaveBeenCalled();
    canvasWithBar('p_1');
    await vi.waitFor(() => expect(useCanvasProposalsStore.getState().focusedId).toBe('p_1'));
  });

  it('Review on the canvas shows it in the bar without leaving', async () => {
    on('canvas');
    canvasWithBar('p_1');
    render(<AppAgentNotes />);
    sync([canvasAsk()]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(useCanvasProposalsStore.getState().focusedId).toBe('p_1'));
    expect(open).not.toHaveBeenCalled();
  });

  it('a proposal no longer waiting says so, and the list stays open with it', async () => {
    on('canvas');
    canvasWithBar(null);
    render(<AppAgentNotes />);
    sync([canvasAsk()]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
    await vi.waitFor(() => expect(useAgentNotesStore.getState().error).toMatch(/no longer waiting/), { timeout: 6000 });
    expect(useCanvasProposalsStore.getState().focusedId).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
  }, 15_000);

  it('a settled one shows how it ended in place of Review, and is never "Expired" by the canvas', () => {
    on('home');
    render(<AppAgentNotes />);
    sync([canvasAsk({ readAt: '2026-10-21T12:30:00.000Z', resolvedAt: '2026-10-21T12:30:00.000Z', outcome: 'Accepted' })]);
    const entry = openEntry();
    expect(entry.textContent).toContain('Accepted');
    expect(within(entry).queryByRole('button', { name: 'Review' })).toBeNull();
    cleanup();
    // Still open, while the bar hasn't heard of it yet (Projects): Review stands.
    render(<AppAgentNotes />);
    sync([canvasAsk()]);
    expect(within(openEntry()).getByRole('button', { name: 'Review' })).toBeTruthy();
  });
});

describe('Show on canvas from another screen', () => {
  function canvasMounts() {
    const renderer = document.createElement('div');
    renderer.className = 'react-flow__renderer';
    renderer.dataset.testFixture = 'true';
    document.body.appendChild(renderer);
  }

  it('from a studio: goes to the canvas, then frames and outlines what it names', async () => {
    on('moodboard-editor');
    useUIStore.setState({ moodboardEditorId: 'mb1' });
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Show on canvas' }));
    await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    // The list steps aside once on the canvas it leads to (not before: a
    // Show that can't go keeps it open, with its reason).
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull());
    expect(useUIStore.getState().moodboardEditorId).toBeNull();
    expect(flow.setViewport).not.toHaveBeenCalled();
    canvasMounts();
    await vi.waitFor(() => expect(flow.setViewport).toHaveBeenCalled());
    expect(useAgentNotesStore.getState().activeOutline()?.refs).toEqual(['n4']);
  });

  it('from Projects: opens the project\'s canvas first', async () => {
    on('home');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Show on canvas' }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('p1'));
    canvasMounts();
    await vi.waitFor(() => expect(flow.setViewport).toHaveBeenCalled());
  });
});

// p157 bug: App mounts the Agent log only on the canvas (App.tsx), but the
// corner is on every screen. Off the canvas "See all actions →" set
// agentLogOpen and focused a header that wasn't there: nothing showed, and
// the log popped open later on the canvas. It now goes to the canvas first
// (the way Show does) and opens the log there, focused, once it has mounted.
describe('"See all actions →" from any screen', () => {
  /** App's Agent log: mounted only on the canvas, collapsed again on unmount (AgentLog.tsx). */
  function MountedLog() {
    const open = useUIStore((s) => s.agentLogOpen);
    useEffect(() => () => useUIStore.getState().setAgentLogOpen(false), []);
    return <div className="agent-log"><button type="button" className="agent-log__header" aria-expanded={open}>Agent log</button></div>;
  }
  function CanvasLog() {
    const workspace = useProjectStore((s) => s.screen === 'workspace');
    const canvas = useUIStore((s) => s.viewMode === 'canvas');
    return workspace && canvas ? <MountedLog /> : null;
  }
  /** Every moment agentLogOpen is true, whether the canvas (and so the log) was on screen. */
  function watchOpenOffCanvas() {
    const offCanvas: string[] = [];
    const check = () => {
      if (!useUIStore.getState().agentLogOpen) return;
      const where = useProjectStore.getState().screen === 'workspace' ? useUIStore.getState().viewMode : 'home';
      if (where !== 'canvas') offCanvas.push(where);
    };
    const stopUI = useUIStore.subscribe(check);
    const stopProjects = useProjectStore.subscribe(check);
    return { offCanvas, stop: () => { stopUI(); stopProjects(); } };
  }

  it.each(['home', 'create', 'commons'] as const)(
    'from %s: goes to the canvas, then opens the Agent log with focus on its header',
    async (where) => {
      on(where);
      const watch = watchOpenOffCanvas();
      try {
        render(<><AppAgentNotes /><CanvasLog /></>);
        sync([note('an_1')]);
        fireEvent.click(chip());
        fireEvent.click(screen.getByRole('button', { name: 'See all actions →' }));
        await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
        expect(useProjectStore.getState().screen).toBe('workspace');
        if (where === 'home') expect(open).toHaveBeenCalledWith('p1');
        const header = await screen.findByRole('button', { name: 'Agent log' });
        await vi.waitFor(() => expect(useUIStore.getState().agentLogOpen).toBe(true));
        await vi.waitFor(() => expect(document.activeElement).toBe(header));
        expect(header.getAttribute('aria-expanded')).toBe('true');
        // The list steps aside once the log is open (not before: a See all
        // that can't get there keeps it open, with its reason).
        await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull());
        expect(watch.offCanvas).toEqual([]);
      } finally {
        watch.stop();
      }
    },
  );

  it('never leaves the log set to open off the canvas when the person leaves before it mounts', async () => {
    on('create');
    const watch = watchOpenOffCanvas();
    try {
      // No Agent log mounts (its chunk is slow, or the person moved on first).
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      fireEvent.click(chip());
      fireEvent.click(screen.getByRole('button', { name: 'See all actions →' }));
      await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
      act(() => on('moodboard-editor'));
      // Past the wait for the log's header (goToCanvas.whenReady, 3 s).
      await new Promise((resolve) => setTimeout(resolve, 3300));
      expect(useUIStore.getState().agentLogOpen).toBe(false);
      expect(watch.offCanvas).toEqual([]);
    } finally {
      watch.stop();
    }
  }, 10000);

  it('on the canvas opens the log in place, as before', () => {
    on('canvas');
    render(<><AppAgentNotes /><CanvasLog /></>);
    sync([note('an_1')]);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'See all actions →' }));
    expect(useUIStore.getState().agentLogOpen).toBe(true);
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it.each(['home', 'create', 'commons'] as const)('on %s: no link while the Agent log is switched off (Q38)', (where) => {
    on(where);
    useUIStore.setState({ agentLogEnabled: false });
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'See all actions →' })).toBeNull();
  });
});

// p157 review: a step to another screen that can't go through must say why,
// where the person is looking. "See all actions →" and an off-canvas Show
// used to close the list first, so the reason went to a list that was gone
// (and showed up, unexplained, the next time it opened).
describe('a step away that can\'t go through says why', () => {
  const NOT_OPENED = "The project didn't open. Try again.";
  function alertText() {
    return within(screen.getByRole('dialog', { name: 'Updates' })).getByRole('alert').textContent;
  }

  it('See all from Projects that can\'t open the project: the list stays open with the reason, not an old one', async () => {
    on('home');
    open.mockImplementationOnce(async () => {});
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    act(() => useAgentNotesStore.setState({ error: 'an older reason' }));
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'See all actions →' }));
    await vi.waitFor(() => expect(alertText()).toBe(NOT_OPENED));
    expect(useProjectStore.getState().screen).toBe('home');
    expect(useUIStore.getState().agentLogOpen).toBe(false);
  });

  it('See all whose Agent log never shows on the canvas says so in the open list', async () => {
    on('create');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'See all actions →' }));
    await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    // Past the wait for the log's header (goToCanvas.whenReady, 3 s).
    await new Promise((resolve) => setTimeout(resolve, 3300));
    expect(alertText()).toBe("The Agent log didn't open. Try again.");
    expect(useUIStore.getState().agentLogOpen).toBe(false);
  }, 10000);

  it('Show from Projects that can\'t open the project keeps the list open with the reason', async () => {
    on('home');
    open.mockImplementationOnce(async () => {});
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(within(openEntry()).getByRole('button', { name: 'Show on canvas' }));
    await vi.waitFor(() => expect(alertText()).toBe(NOT_OPENED));
    expect(useProjectStore.getState().screen).toBe('home');
  });

  it('Show from a card that can\'t go opens the list, where the reason shows', async () => {
    on('home');
    open.mockImplementationOnce(async () => {});
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2'), unread: 2, at: 2, removed: [] });
    await vi.waitFor(() => expect(document.querySelector('.agent-note-card')).not.toBeNull());
    const card = document.querySelector<HTMLElement>('.agent-note-card')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Show on canvas' }));
    await vi.waitFor(() => expect(alertText()).toBe(NOT_OPENED));
  });

  // While Blind labeling or Agent review holds unsaved work, the corner's
  // ways out of the Commons (See all, Show, Review) ask first through the
  // Commons' popover, anchored to the clicked button (commons-leave, GM -
  // Design; #163 refused with a reason). The step runs only once the person
  // chose to leave and the Commons is clean. CommonsView registers the ask;
  // here a stand-in records it.
  describe('from the Commons with unsaved labels', () => {
    type Asked = { anchor: HTMLElement | null; leave: () => void };
    let asked: Asked[] = [];
    async function unsaved(value: boolean) {
      const { setCommonsUnsaved, setCommonsLeaveAsk } = await import('../src/lib/commonsUnsaved');
      setCommonsLeaveAsk(value ? (anchor, leave) => { asked.push({ anchor, leave }); } : null);
      setCommonsUnsaved(value);
    }
    /** The person chose a leave: the Commons is clean, then the step runs. */
    async function chooseLeave() {
      const { setCommonsUnsaved } = await import('../src/lib/commonsUnsaved');
      setCommonsUnsaved(false);
      act(() => { asked[asked.length - 1].leave(); });
    }
    beforeEach(() => { asked = []; });
    afterEach(async () => { await unsaved(false); });

    it('See all asks, anchored to See all, and goes to the canvas once they leave', async () => {
      on('commons');
      await unsaved(true);
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      fireEvent.click(chip());
      const seeAll = screen.getByRole('button', { name: 'See all actions →' });
      fireEvent.click(seeAll);
      expect(asked).toHaveLength(1);
      expect(asked[0].anchor).toBe(seeAll);
      expect(useUIStore.getState().viewMode).toBe('commons');
      expect(within(screen.getByRole('dialog', { name: 'Updates' })).queryByRole('alert')).toBeNull();
      await chooseLeave();
      await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    });

    it('Show asks, anchored to Show, and goes to the canvas once they leave', async () => {
      on('commons');
      await unsaved(true);
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      const show = within(openEntry()).getByRole('button', { name: 'Show on canvas' });
      fireEvent.click(show);
      expect(asked).toHaveLength(1);
      expect(asked[0].anchor).toBe(show);
      expect(useUIStore.getState().viewMode).toBe('commons');
      await chooseLeave();
      await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    });

    it.each([['moodboard', 'mb1'], ['project', 'dusk']] as const)(
      'Review on a %s ask asks, anchored to Review, and goes once they leave',
      async (target, targetId) => {
        on('commons');
        await unsaved(true);
        render(<AppAgentNotes />);
        sync([ask(target, targetId)]);
        const review = within(openEntry()).getByRole('button', { name: 'Review' });
        fireEvent.click(review);
        expect(asked).toHaveLength(1);
        expect(asked[0].anchor).toBe(review);
        expect(useUIStore.getState().viewMode).toBe('commons');
        expect(goHome).not.toHaveBeenCalled();
        expect(useAssetProposalsStore.getState().review).toBeNull();
        await chooseLeave();
        if (target === 'project') await vi.waitFor(() => expect(goHome).toHaveBeenCalledTimes(1));
        else await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('moodboard-editor'));
        expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: target, targetId });
      },
    );

    it("Review on a Commons ask doesn't leave the Commons, so it opens the reference without asking", async () => {
      on('commons');
      await unsaved(true);
      render(<AppAgentNotes />);
      sync([ask('commons', 'ast_1')]);
      fireEvent.click(within(openEntry()).getByRole('button', { name: 'Review' }));
      await vi.waitFor(() => expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'commons', targetId: 'ast_1' }));
      expect(asked).toHaveLength(0);
      expect(useUIStore.getState().viewMode).toBe('commons');
    });

    it('once saved, See all goes to the canvas without asking', async () => {
      on('commons');
      await unsaved(true);
      await unsaved(false);
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      fireEvent.click(chip());
      fireEvent.click(screen.getByRole('button', { name: 'See all actions →' }));
      await vi.waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
      expect(asked).toHaveLength(0);
    });
  });
});

describe('the corner keeps clear of each screen\'s controls', () => {
  function slot(rect: { left: number; right: number; top: number; bottom: number }) {
    const header = document.createElement('header');
    header.dataset.testFixture = 'true';
    header.getBoundingClientRect = () => ({ ...rect, top: 0, bottom: 48, left: 0, width: 1440, height: 48, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const el = document.createElement('span');
    el.className = 'agent-notes-slot';
    el.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
    header.appendChild(el);
    document.body.appendChild(header);
  }

  it('sits over the header\'s reserved slot, and drops its list below the header', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    on('moodboard-editor');
    slot({ left: 1300, right: 1412, top: 8, bottom: 40 });
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    // Centred on the 32 px slot: 8 + 16 - 20.
    expect(chip().style.getPropertyValue('--an-chip-top')).toBe('4px');
    expect(chip().style.getPropertyValue('--an-right')).toBe('28px');
    fireEvent.click(chip());
    const list = screen.getByRole('dialog', { name: 'Updates' });
    // Below the header (48) plus the gap, never over the screen's own bar.
    expect(list.style.getPropertyValue('--an-drop-top')).toBe('56px');
  });

  // GM on #199's shots (fix round 3 of PR #200): pinned to the top right, the
  // chip sat on Projects' "New project" once the page scrolled. It leaves with
  // its header now, as the header's Settings does; its card still starts on screen.
  it('scrolls away with its header when the page scrolls (Projects), never over the page below', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    on('home');
    slot({ left: 1163, right: 1308, top: -100, bottom: -68 });
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    const top = Number.parseFloat(chip().style.getPropertyValue('--an-chip-top'));
    // Centred on its slot, 100 px up with the header: off the screen.
    expect(top).toBeLessThan(0);
    expect(top + 40).toBeLessThanOrEqual(0); // the chip is 40 px tall (--agent-notes-chip-h)
    expect(chip().style.getPropertyValue('--an-right')).toBe('132px');
  });

  it('moves onto a slot that mounts after it (a studio\'s chunk lands later)', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const { UpdatesSlot } = await import('../src/components/agent-notes/UpdatesSlot');
    const rect = (r: { left: number; right: number; top: number; bottom: number }) =>
      ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('agent-notes-slot')) return rect({ left: 1300, right: 1412, top: 8, bottom: 40 });
      if (this.tagName === 'HEADER') return rect({ left: 0, right: 1440, top: 0, bottom: 48 });
      return rect({ left: 0, right: 0, top: 0, bottom: 0 });
    });
    try {
      on('moodboard-editor');
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      expect(chip().style.getPropertyValue('--an-chip-top')).toBe('');
      render(<header><UpdatesSlot /></header>);
      await vi.waitFor(() => expect(chip().style.getPropertyValue('--an-chip-top')).toBe('4px'));
      expect(chip().style.getPropertyValue('--an-right')).toBe('28px');
    } finally {
      spy.mockRestore();
    }
  });

  // Review of Q107 a: a chat left open on the canvas stays mounted in the
  // studios (.workspace-overlays--studio), docked from the top gutter at
  // 1280x800 (x 924-1264, y 16-726). The chip keeps its header slot; a card
  // or the list that would meet the chat sits just left of it, and the
  // docked chat starts below the header line the corner drops from.
  function chatPanel(rect: { left: number; right: number; top: number; bottom: number }) {
    const el = document.createElement('div');
    el.dataset.testFixture = 'true';
    el.className = 'chat-panel';
    el.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(el);
  }

  function cardWidths() {
    return vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-note-card') || this.classList.contains('agent-notes-panel') ? 320 : 0;
    });
  }

  it('drops a card and the list left of an open chat in a studio, the chip staying in its slot', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const widths = cardWidths();
    try {
      on('moodboard-editor');
      slot({ left: 1154, right: 1266, top: 8, bottom: 40 });
      chatPanel({ left: 924, right: 1264, top: 16, bottom: 726 });
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      expect(chip().style.getPropertyValue('--an-right')).toBe('14px');
      emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2'), unread: 2, at: 2, removed: [] });
      await vi.waitFor(() => expect(document.querySelector('.agent-note-card')).not.toBeNull());
      const card = document.querySelector<HTMLElement>('.agent-note-card')!;
      await vi.waitFor(() => expect(parseFloat(card.style.getPropertyValue('--an-right'))).toBeGreaterThanOrEqual(1280 - 924 + 8));
      expect(chip().style.getPropertyValue('--an-right')).toBe('14px');
      fireEvent.click(chip());
      const list = screen.getByRole('dialog', { name: 'Updates' });
      expect(parseFloat(list.style.getPropertyValue('--an-right'))).toBeGreaterThanOrEqual(1280 - 924 + 8);
    } finally {
      widths.mockRestore();
    }
  });

  it('keeps a card at its slot when no chat meets it', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const widths = cardWidths();
    try {
      on('moodboard-editor');
      slot({ left: 1154, right: 1266, top: 8, bottom: 40 });
      render(<AppAgentNotes />);
      sync([]);
      emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2'), unread: 1, at: 2, removed: [] });
      await vi.waitFor(() => expect(document.querySelector('.agent-note-card')).not.toBeNull());
      expect(document.querySelector<HTMLElement>('.agent-note-card')!.style.getPropertyValue('--an-right')).toBe('14px');
    } finally {
      widths.mockRestore();
    }
  });

  it('writes the header line it drops from, so the docked chat starts below it; clears it on the canvas', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const root = document.documentElement;
    on('moodboard-editor');
    slot({ left: 1300, right: 1412, top: 8, bottom: 40 });
    const { unmount } = render(<AppAgentNotes />);
    sync([note('an_1')]);
    expect(root.style.getPropertyValue('--agent-notes-drop-top')).toBe('56px');
    document.querySelectorAll('[data-test-fixture]').forEach((el) => el.remove());
    act(() => on('canvas'));
    expect(root.style.getPropertyValue('--agent-notes-drop-top')).toBe('');
    act(() => on('moodboard-editor'));
    slot({ left: 1300, right: 1412, top: 8, bottom: 40 });
    sync([note('an_1'), note('an_3')]);
    expect(root.style.getPropertyValue('--agent-notes-drop-top')).toBe('56px');
    unmount();
    expect(root.style.getPropertyValue('--agent-notes-drop-top')).toBe('');
  });

  // GM review of Q107 a: below about 1360 px the chip drops the word
  // "Updates" (agentNotes.css) and the header reserves its compact width. The
  // corner writes the chip's measured width into the one token the slot and
  // the header padding read; a window resize across the breakpoint changes
  // that width with no re-render, so the corner measures it again then.
  it('measures the chip again on a window resize, so the slot follows its compact width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const root = document.documentElement;
    let width = 134;
    const widths = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-notes-chip') ? width : 0;
    });
    try {
      on('moodboard-editor');
      slot({ left: 1281, right: 1426, top: 8, bottom: 40 });
      render(<AppAgentNotes />);
      sync([note('an_1')]);
      expect(root.style.getPropertyValue('--agent-notes-chip-w')).toBe('134px');
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
      width = 74;
      act(() => { window.dispatchEvent(new Event('resize')); });
      await vi.waitFor(() => expect(root.style.getPropertyValue('--agent-notes-chip-w')).toBe('74px'));
    } finally {
      widths.mockRestore();
      root.style.removeProperty('--agent-notes-chip-w');
    }
  });

  it('keeps the compact chip\'s name, dots and count: only the word is its own element', () => {
    on('commons');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    const button = chip();
    expect(button.getAttribute('aria-label')).toBe('Updates, 1 unread');
    expect(button.querySelectorAll('.agent-notes-chip__dots .agent-notes-dot')).toHaveLength(2);
    expect(button.querySelector('.agent-notes-chip__count')?.textContent).toBe('1');
    // The word the compact chip hides is a leaf of its own, so hiding it leaves the rest.
    const label = button.querySelector('.agent-notes-chip__label');
    expect(label?.textContent).toBe('Updates');
    expect(label?.children).toHaveLength(0);
  });

  // GM review of p157: the count was a circle in the newest author's colour,
  // the size of a dot, so "C Ar 1" read as three people. It is its own
  // element after the dots (styled apart in agentNotes.css, pinned in
  // agentNotesLayoutCss.test.ts) at every count.
  it.each([0, 1, 9, 12])('renders a count of %i in its own element after the dots, never as an author dot', (unread) => {
    on('create');
    render(<AppAgentNotes />);
    sync(Array.from({ length: Math.max(unread, 1) }, (_, i) => note(`an_${i}`, i < unread ? {} : { readAt: '2026-10-21T12:30:00.000Z' })));
    const button = chip();
    expect(button.getAttribute('aria-label')).toBe(unread ? `Updates, ${unread} unread` : 'Updates');
    const count = button.querySelector('.agent-notes-chip__count')!;
    expect(count.textContent).toBe(String(unread));
    expect(count.classList.contains('agent-notes-dot')).toBe(false);
    expect(count.closest('.agent-notes-chip__dots')).toBeNull();
    expect(count.hasAttribute('style')).toBe(false);
    // After the dots (and the word), never between them.
    const dots = button.querySelector('.agent-notes-chip__dots')!;
    expect(dots.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(count.getAttribute('data-muted')).toBe(unread === 0 ? 'true' : 'false');
  });

  // GM review of PR #157, round 2: the 1 row of count-forms.png had no ring,
  // because the ring only showed while a card was up. "One new item is
  // exactly when you most need it to pull. The ring should come on at any
  // count of 1 or more." No card is up here: the list is synced, not dropped.
  it.each([1, 2, 9, 12])('rings the chip at %i unread, with no card up', (unread) => {
    on('create');
    render(<AppAgentNotes />);
    sync(Array.from({ length: unread + 1 }, (_, i) => note(`an_${i}`, i < unread ? {} : { readAt: '2026-10-21T12:30:00.000Z' })));
    expect(screen.queryByRole('status', { name: /Update from/ })).toBeNull();
    expect(chip().getAttribute('aria-label')).toBe(`Updates, ${unread} unread`);
    expect(chip().classList.contains('agent-notes-chip--ringed')).toBe(true);
  });

  it('has no ring at 0 unread, and none while the list is open', () => {
    on('create');
    render(<AppAgentNotes />);
    sync([note('an_read', { readAt: '2026-10-21T12:30:00.000Z' })]);
    expect(chip().classList.contains('agent-notes-chip--ringed')).toBe(false);
    sync([note('an_1'), note('an_2')]);
    expect(chip().classList.contains('agent-notes-chip--ringed')).toBe(true);
    fireEvent.click(chip());
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
    expect(chip().classList.contains('agent-notes-chip--ringed')).toBe(false);
  });

  it('keeps its own corner on the canvas, where no header slot shows', () => {
    on('canvas');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    expect(chip().style.getPropertyValue('--an-chip-top')).toBe('');
  });
});

describe('the corner never takes a screen\'s keys', () => {
  it('Cmd+Z with focus on the chip or a card is still the Studio\'s and the canvas\'s', () => {
    on('moodboard-editor');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    expect(isStudioShortcutTarget(chip(), 'undo')).toBe(true);
    expect(isCanvasShortcutTarget(chip())).toBe(true);
    // The open list is a dialog: its keys are its own (Escape, Tab).
    fireEvent.click(chip());
    const list = screen.getByRole('dialog', { name: 'Updates' });
    expect(isStudioShortcutTarget(list, 'undo')).toBe(false);
    expect(isCanvasShortcutTarget(list)).toBe(false);
  });

  it('lets Cmd+Z through: no key but Escape is handled on the chip', () => {
    on('moodboard-editor');
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    const event = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    chip().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
