import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentNote } from '../src/lib/agentNotes';

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
const { useAssetProposalsStore } = await import('../src/store/assetProposalsStore');

const CLAUDE = { kind: 'agent', id: 'claude', name: 'Claude', color: '#E8825A' } as const;
const CODEX = { kind: 'agent', id: 'codex', name: 'Codex', color: '#5AA9E8' } as const;

let clock = Date.parse('2026-10-20T12:14:00.000Z');

function note(id: string, overrides: Partial<AgentNote> = {}): AgentNote {
  clock += 1000;
  return {
    id, author: CLAUDE, source: 'agent', about: 'other', at: new Date(clock).toISOString(),
    text: `update ${id}`, parts: [{ text: `update ${id}` }], refs: ['n4'], actions: [],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null, ...overrides,
  };
}

function emit(event: unknown) {
  act(() => {
    for (const handler of ws.handlers) handler(event);
  });
}

function sync(notes: AgentNote[], unread = notes.filter((n) => !n.readAt && !n.dismissedAt).length) {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes, unread, at: 1 });
}

function added(n: AgentNote, unread: number) {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: n, unread, at: 2, removed: [] });
}

/** Advance fake time in small steps, so effects that set new timers run in between. */
function tick(ms: number) {
  for (let left = ms; left > 0; left -= 50) {
    act(() => { vi.advanceTimersByTime(Math.min(50, left)); });
  }
}

function chip() {
  return screen.getByRole('button', { name: /^Updates/ });
}

beforeEach(() => {
  useAgentNotesStore.getState().reset();
  // On the canvas (tests/AgentNotesEveryScreen.test.tsx covers the other screens).
  useProjectStore.setState({ screen: 'workspace' });
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false, viewMode: 'canvas' });
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
  vi.useRealTimers();
});

describe('the Updates chip', () => {
  it('is always there, with both author dots and a muted 0', () => {
    render(<AppAgentNotes />);
    sync([]);
    const button = chip();
    expect(button.textContent).toContain('Updates');
    const count = button.querySelector('.agent-notes-chip__count')!;
    expect(count.textContent).toBe('0');
    expect(count.getAttribute('data-muted')).toBe('true');
    expect(button.querySelectorAll('.agent-notes-dot')).toHaveLength(2);
  });

  it('counts unread updates in the newest author\'s colour', () => {
    render(<AppAgentNotes />);
    sync([note('an_2', { author: CODEX }), note('an_1', { readAt: '2026-10-20T12:00:00.000Z' })]);
    const count = chip().querySelector<HTMLElement>('.agent-notes-chip__count')!;
    expect(count.textContent).toBe('1');
    expect(count.getAttribute('data-muted')).toBe('false');
    expect(chip().style.getPropertyValue('--an-newest')).toBe('#5AA9E8');
    expect(chip().getAttribute('aria-label')).toBe('Updates, 1 unread');
  });
});

describe('the list (GM\'s still)', () => {
  it('opens from the chip, marks every update read and shows the header GM drew', async () => {
    render(<AppAgentNotes />);
    const newest = note('an_3');
    sync([newest, note('an_2'), note('an_1', { readAt: '2026-10-20T12:00:00.000Z' })]);
    fireEvent.click(chip());
    const list = screen.getByRole('dialog', { name: 'Updates' });
    expect(api.markAgentNotesRead).toHaveBeenCalledWith({ kind: 'canvas' }, 'an_3');
    expect(within(list).getByText('3 · all read')).toBeTruthy();
    expect(within(list).getByText('kept with this project')).toBeTruthy();
    // The chip's count is a muted 0 while the list is open.
    expect(chip().querySelector('.agent-notes-chip__count')!.textContent).toBe('0');
    expect(chip().getAttribute('aria-expanded')).toBe('true');
    const entries = within(list).getAllByRole('listitem');
    expect(entries.map((entry) => entry.querySelector('.agent-notes-entry__text')!.textContent)).toEqual([
      'update an_3', 'update an_2', 'update an_1',
    ]);
    expect(entries[0].querySelector('.agent-notes-entry__name')!.textContent).toBe('Claude');
    expect(entries[0].style.getPropertyValue('--an-author')).toBe('#E8825A');
    expect(within(entries[0]).getByRole('button', { name: 'Show on canvas' })).toBeTruthy();
  });

  it('greys a dismissed update and keeps it in the list', () => {
    render(<AppAgentNotes />);
    sync([note('an_2', { dismissedAt: '2026-10-20T12:30:00.000Z' }), note('an_1')]);
    fireEvent.click(chip());
    const entries = within(screen.getByRole('dialog', { name: 'Updates' })).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0].getAttribute('data-state')).toBe('done');
  });

  it('ends with "See all actions →", which opens the Agent log', () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'See all actions →' }));
    expect(useUIStore.getState().agentLogOpen).toBe(true);
    // The list steps aside for the log.
    expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
  });

  it('has no "See all actions →" while the Agent log is switched off', () => {
    useUIStore.setState({ agentLogEnabled: false });
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    expect(screen.queryByRole('button', { name: 'See all actions →' })).toBeNull();
  });

  it('says what Not now does only while an entry offers it', () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    expect(screen.queryByText('Not now hides a suggestion for good')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Updates' }), { key: 'Escape' });
    sync([note('an_2', {
      source: 'nebula', about: 'suggestion',
      actions: [
        { label: 'Make frame', op: { kind: 'suggestion.accept', suggestionIds: ['s1'] } },
        { label: 'Not now', op: { kind: 'suggestion.dismiss', suggestionIds: ['s1'] } },
      ],
    })]);
    fireEvent.click(chip());
    expect(screen.getByText('Not now hides a suggestion for good')).toBeTruthy();
  });

  it('closes on Escape and gives focus back to the chip', () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    chip().focus();
    fireEvent.click(chip());
    const list = screen.getByRole('dialog', { name: 'Updates' });
    expect(list.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('closes on a click outside', () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
  });

  it('takes a new update on top while open, marks it read and drops no card', () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    api.markAgentNotesRead.mockClear();
    added(note('an_2'), 1);
    const list = screen.getByRole('dialog', { name: 'Updates' });
    expect(within(list).getAllByRole('listitem')[0].querySelector('.agent-notes-entry__text')!.textContent).toBe('update an_2');
    expect(within(list).getByText('2 · 1 new')).toBeTruthy();
    expect(api.markAgentNotesRead).toHaveBeenCalledWith({ kind: 'canvas' }, 'an_2');
    expect(document.querySelector('.agent-note-card')).toBeNull();
    // "1 new" is this list's own state: it clears when the list closes.
    fireEvent.keyDown(list, { key: 'Escape' });
    fireEvent.click(chip());
    expect(within(screen.getByRole('dialog', { name: 'Updates' })).getByText('2 · all read')).toBeTruthy();
  });

  it('Show brings the nodes an update names into view on a spring and outlines them', async () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'Show on canvas' }));
    expect(useAgentNotesStore.getState().activeOutline()?.refs).toEqual(['n4']);
    // n4 sits outside the 1440x900 view: the view moves (springViewport, frame by frame).
    await vi.waitFor(() => expect(flow.setViewport).toHaveBeenCalled());
    const last = flow.setViewport.mock.calls.at(-1)![0] as { x: number; y: number; zoom: number };
    expect(last.x).toBeLessThan(0);
    expect(last.y).toBeLessThan(0);
  });

  it('a click on a row does what Show does', () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    const entry = within(screen.getByRole('dialog', { name: 'Updates' })).getAllByRole('listitem')[0];
    fireEvent.click(entry.querySelector('.agent-notes-entry__text')!);
    expect(useAgentNotesStore.getState().activeOutline()?.refs).toEqual(['n4']);
  });

  it('hovering a row outlines its refs at once', () => {
    render(<AppAgentNotes />);
    sync([note('an_1')]);
    fireEvent.click(chip());
    const entry = within(screen.getByRole('dialog', { name: 'Updates' })).getAllByRole('listitem')[0];
    fireEvent.mouseEnter(entry);
    expect(useAgentNotesStore.getState().activeOutline()).toMatchObject({ refs: ['n4'], delayMs: 0 });
    fireEvent.mouseLeave(entry);
  });
});

describe('the card', () => {
  it('drops for a new update, outlines what it names and leaves by itself without marking it read', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    added(note('an_1', { text: 'The upscaler reads the wrong image', parts: [{ text: 'The upscaler reads the wrong image' }] }), 1);
    tick(600);
    const card = screen.getByRole('status', { name: /Update from Claude/ });
    expect(card.textContent).toContain('The upscaler reads the wrong image');
    expect(chip().classList.contains('agent-notes-chip--ringed')).toBe(true);
    expect(useAgentNotesStore.getState().activeOutline()).toMatchObject({ refs: ['n4'], delayMs: 800, staggerMs: 250 });
    tick(4500);
    tick(1000);
    expect(screen.queryByRole('status', { name: /Update from Claude/ })).toBeNull();
    expect(api.markAgentNotesRead).not.toHaveBeenCalled();
    expect(useAgentNotesStore.getState().activeOutline()).toBeNull();
  });

  it('holds while hovered', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    added(note('an_1'), 1);
    tick(600);
    fireEvent.mouseEnter(screen.getByRole('status', { name: /Update from Claude/ }));
    tick(9000);
    expect(screen.getByRole('status', { name: /Update from Claude/ })).toBeTruthy();
  });

  it('× dismisses the update; it stays in the list', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    added(note('an_1'), 1);
    tick(600);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this update' }));
    expect(api.dismissAgentNote).toHaveBeenCalledWith({ kind: 'canvas' }, 'an_1');
  });

  it('clicking the card marks it read', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    added(note('an_1'), 1);
    tick(600);
    fireEvent.click(screen.getByRole('status', { name: /Update from Claude/ }).querySelector('.agent-note-card__text')!);
    // Only that update: older unread ones stay unread.
    expect(api.markAgentNotesRead).toHaveBeenCalledWith({ kind: 'canvas' }, undefined, ['an_1']);
  });

  it('drops arrivals one after another', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    added(note('an_1'), 1);
    added(note('an_2'), 2);
    tick(600);
    expect(screen.getByRole('status', { name: /Update from Claude/ }).textContent).toContain('update an_1');
    tick(5500);
    tick(600);
    expect(screen.getByRole('status', { name: /Update from Claude/ }).textContent).toContain('update an_2');
  });

  it('turns four or more at once into one card that opens the list', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    // An agent's burst: separate posts a few hundred ms apart still count as at once.
    for (let i = 1; i <= 4; i += 1) {
      added(note(`an_${i}`), i);
      tick(250);
    }
    tick(600);
    const card = screen.getByRole('status', { name: '4 new updates' });
    fireEvent.click(within(card).getByRole('button', { name: '4 new updates' }));
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeTruthy();
  });

  it('folds a slower burst into one card: the card up becomes "4 new updates"', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    // An MCP agent's posts land 1 to 3 s apart, too slow for the gather window.
    added(note('an_1'), 1);
    tick(600);
    expect(screen.getByRole('status', { name: /Update from Claude/ }).textContent).toContain('update an_1');
    for (let i = 2; i <= 4; i += 1) {
      tick(900);
      added(note(`an_${i}`), i);
    }
    tick(100);
    expect(screen.queryByRole('status', { name: /Update from Claude/ })).toBeNull();
    expect(screen.getByRole('status', { name: '4 new updates' })).toBeTruthy();
  });

  it('never swaps the card under the pointer', () => {
    vi.useFakeTimers();
    render(<AppAgentNotes />);
    sync([]);
    added(note('an_1'), 1);
    tick(600);
    fireEvent.mouseEnter(screen.getByRole('status', { name: /Update from Claude/ }));
    for (let i = 2; i <= 4; i += 1) added(note(`an_${i}`), i);
    tick(600);
    expect(screen.getByRole('status', { name: /Update from Claude/ }).textContent).toContain('update an_1');
  });

  it('drops nothing in a hidden tab, though the count still rises', () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    render(<AppAgentNotes />);
    sync([]);
    added(note('an_1'), 1);
    tick(500);
    expect(document.querySelector('.agent-note-card')).toBeNull();
    expect(chip().querySelector('.agent-notes-chip__count')!.textContent).toBe('1');
  });
});

describe('the corner on the canvas', () => {
  it('reserves the top-right corner so the docked chat starts below the chip', () => {
    const { unmount } = render(<AppAgentNotes />);
    expect(document.body.classList.contains('agent-notes-reserved')).toBe(true);
    unmount();
    expect(document.body.classList.contains('agent-notes-reserved')).toBe(false);
  });
});

describe('an asset proposal\'s Update (Q92 a)', () => {

  function ask(target: 'project' | 'moodboard' | 'commons', targetId: string, overrides: Partial<AgentNote> = {}) {
    const text = { project: 'Claude asks to change the cover of Dusk', moodboard: 'Claude asks to send Dusk board\'s notes to generators',
      commons: 'Claude asks to change a reference in the Commons' }[target];
    return note(`an_${target}`, {
      source: 'nebula', about: 'proposal', text, parts: [{ text }], refs: [],
      actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_1', target, targetId } }],
      ...overrides,
    });
  }

  function reviewIn(entry: HTMLElement) {
    fireEvent.click(within(entry).getByRole('button', { name: 'Review' }));
  }

  function openEntry(): HTMLElement {
    fireEvent.click(chip());
    return within(screen.getByRole('dialog', { name: 'Updates' })).getAllByRole('listitem')[0];
  }

  beforeEach(() => {
    useAssetProposalsStore.getState().clear();
    useProjectStore.setState({ goHome: vi.fn(async () => {}) });
  });

  it('says it waits for the person and Review opens the Projects screen at that card', async () => {
    render(<AppAgentNotes />);
    sync([ask('project', 'dusk')]);
    const entry = openEntry();
    expect(entry.textContent).toContain('waiting for your OK');
    expect(entry.textContent).toContain('Claude asks to change the cover of Dusk');
    // Not a canvas proposal: never "Expired" for want of one on the canvas.
    expect(entry.textContent).not.toContain('Expired');
    reviewIn(entry);
    await vi.waitFor(() => expect(useProjectStore.getState().goHome).toHaveBeenCalledTimes(1));
    expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'project', targetId: 'dusk' });
  });

  it('Review on a board\'s ask opens Moodboard Studio on that board', async () => {
    const enter = vi.fn();
    useUIStore.setState({ enterMoodboardEditor: enter });
    render(<AppAgentNotes />);
    sync([ask('moodboard', 'mb1')]);
    reviewIn(openEntry());
    await vi.waitFor(() => expect(enter).toHaveBeenCalledWith('mb1'));
    expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'moodboard', targetId: 'mb1' });
  });

  it('Review on a Commons ask opens the Commons on that reference, or says it is off', async () => {
    const enterCommons = vi.fn();
    useUIStore.setState({ enterCommons, commonsEnabled: true });
    render(<AppAgentNotes />);
    sync([ask('commons', 'ast_1')]);
    reviewIn(openEntry());
    await vi.waitFor(() => expect(enterCommons).toHaveBeenCalledTimes(1));
    expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'commons', targetId: 'ast_1' });

    cleanup();
    useAssetProposalsStore.getState().clear();
    useUIStore.setState({ commonsEnabled: false });
    render(<AppAgentNotes />);
    sync([ask('commons', 'ast_1')]);
    reviewIn(openEntry());
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Commons'));
    expect(useAssetProposalsStore.getState().review).toBeNull();
  });

  it('once the proposal closed, says how in place of Review, greyed', () => {
    render(<AppAgentNotes />);
    sync([ask('project', 'dusk', { readAt: '2026-10-20T12:30:00.000Z', resolvedAt: '2026-10-20T12:30:00.000Z',
      outcome: 'Accepted: the cover changed' })]);
    const entry = openEntry();
    expect(within(entry).queryByRole('button', { name: 'Review' })).toBeNull();
    expect(entry.textContent).toContain('Accepted: the cover changed');
    expect(entry.textContent).not.toContain('waiting for your OK');
    expect(entry.getAttribute('data-state')).toBe('done');
  });

  it('a resolved message from the socket replaces the open one', () => {
    render(<AppAgentNotes />);
    const open = ask('project', 'dusk');
    sync([open]);
    emit({ type: 'agentNotes', surface: 'canvas', op: 'resolved', projectId: 'p1', ids: [open.id], unread: 0, at: 3,
      note: { ...open, readAt: '2026-10-20T12:30:00.000Z', resolvedAt: '2026-10-20T12:30:00.000Z', outcome: 'Withdrawn by Claude' } });
    const entry = openEntry();
    expect(entry.textContent).toContain('Withdrawn by Claude');
    expect(within(entry).queryByRole('button', { name: 'Review' })).toBeNull();
  });
});
