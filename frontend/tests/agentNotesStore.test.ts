import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentNote } from '../src/lib/agentNotes';

const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const api = vi.hoisted(() => ({
  fetchAgentNotes: vi.fn(),
  markAgentNotesRead: vi.fn(),
  dismissAgentNote: vi.fn(),
}));

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; } },
}));
vi.mock('../src/lib/agentNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentNotes')>()),
  ...api,
}));

const { useAgentNotesStore, selectCanvasList } = await import('../src/store/agentNotesStore');

const AGENT = { kind: 'agent', id: 'claude', name: 'Claude', color: '#E8825A' };

function note(id: string, overrides: Partial<AgentNote> = {}): AgentNote {
  return {
    id, author: AGENT as AgentNote['author'], source: 'agent', about: 'other',
    at: '2026-10-20T12:14:05.000Z', text: `update ${id}`, parts: [{ text: `update ${id}` }],
    refs: ['n1'], actions: [], readAt: null, dismissedAt: null, actedAt: null, actedWith: null, ...overrides,
  };
}

function emit(event: unknown) {
  for (const handler of ws.handlers) handler(event);
}

function sync(projectId: string | null, notes: AgentNote[], unread = notes.length) {
  emit({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId, notes, unread, at: 1 });
}

beforeEach(() => {
  useAgentNotesStore.getState().reset();
  api.fetchAgentNotes.mockReset();
  api.markAgentNotesRead.mockReset();
  api.dismissAgentNote.mockReset();
});

describe('agent notes store (Updates)', () => {
  it('takes the open project list from a sync and drops malformed updates', () => {
    sync('p1', [note('an_2'), { id: 'bad' } as unknown as AgentNote, note('an_1')], 2);
    const list = selectCanvasList(useAgentNotesStore.getState());
    expect(useAgentNotesStore.getState().canvasProjectId).toBe('p1');
    expect(list.notes.map((n) => n.id)).toEqual(['an_2', 'an_1']);
    expect(list.unread).toBe(2);
    expect(list.loaded).toBe(true);
    // A sync is the list as it is: no card drops for it.
    expect(useAgentNotesStore.getState().arrivals).toEqual([]);
  });

  it('puts an added update on top, takes the server count, and queues it to drop', () => {
    sync('p1', [note('an_1')], 1);
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2'), unread: 2, at: 2 });
    const list = selectCanvasList(useAgentNotesStore.getState());
    expect(list.notes.map((n) => n.id)).toEqual(['an_2', 'an_1']);
    expect(list.unread).toBe(2);
    expect(useAgentNotesStore.getState().arrivals.map((a) => [a.key, a.id])).toEqual([['canvas:p1', 'an_2']]);
    // The same update twice (a reconnect race) is kept once.
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2'), unread: 2, at: 3 });
    expect(selectCanvasList(useAgentNotesStore.getState()).notes).toHaveLength(2);
  });

  it('an added update drops the ones it pushed out (a replaced "since its last turn" one, the cap)', () => {
    sync('p1', [note('an_old', { about: 'sinceLastTurn' }), note('an_1')], 2);
    emit({
      type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1',
      note: note('an_new', { about: 'sinceLastTurn' }), unread: 2, at: 2, removed: ['an_old'],
    });
    expect(selectCanvasList(useAgentNotesStore.getState()).notes.map((n) => n.id)).toEqual(['an_new', 'an_1']);
  });

  it('follows read and dismiss from any tab', () => {
    sync('p1', [note('an_2'), note('an_1')], 2);
    emit({ type: 'agentNotes', surface: 'canvas', op: 'read', projectId: 'p1', ids: ['an_1'], unread: 1, at: Date.parse('2026-10-20T12:20:00Z') });
    let list = selectCanvasList(useAgentNotesStore.getState());
    expect(list.notes.find((n) => n.id === 'an_1')?.readAt).toBe('2026-10-20T12:20:00.000Z');
    expect(list.unread).toBe(1);
    emit({
      type: 'agentNotes', surface: 'canvas', op: 'dismissed', projectId: 'p1', ids: ['an_2'],
      note: note('an_2', { dismissedAt: '2026-10-20T12:21:00.000Z' }), unread: 0, at: 5,
    });
    list = selectCanvasList(useAgentNotesStore.getState());
    expect(list.notes[0].dismissedAt).toBe('2026-10-20T12:21:00.000Z');
    expect(list.unread).toBe(0);
  });

  it('drops a queued card once its update is read elsewhere', () => {
    sync('p1', [], 0);
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_1'), unread: 1, at: 2 });
    emit({ type: 'agentNotes', surface: 'canvas', op: 'read', projectId: 'p1', ids: ['an_1'], unread: 0, at: 3 });
    expect(useAgentNotesStore.getState().arrivals).toEqual([]);
  });

  it('switching projects brings that project its own updates', () => {
    sync('p1', [note('an_1')], 1);
    sync('p2', [note('an_9')], 1);
    expect(useAgentNotesStore.getState().canvasProjectId).toBe('p2');
    expect(selectCanvasList(useAgentNotesStore.getState()).notes.map((n) => n.id)).toEqual(['an_9']);
  });

  it('keeps board updates apart, keyed by board', () => {
    sync('p1', [note('an_1')], 1);
    emit({ type: 'agentNotes', surface: 'board', op: 'added', boardId: 'b1', note: note('an_b'), unread: 1, at: 2 });
    expect(selectCanvasList(useAgentNotesStore.getState()).notes.map((n) => n.id)).toEqual(['an_1']);
    expect(useAgentNotesStore.getState().lists['board:b1'].notes.map((n) => n.id)).toEqual(['an_b']);
  });

  it('marks read up to an update optimistically and takes the server count back', async () => {
    sync('p1', [note('an_3'), note('an_2'), note('an_1', { readAt: '2026-10-20T11:00:00.000Z' })], 2);
    api.markAgentNotesRead.mockResolvedValue({ ids: ['an_3', 'an_2'], unread: 0, projectId: 'p1' });
    const done = useAgentNotesStore.getState().markRead({ kind: 'canvas' }, 'an_3');
    const list = selectCanvasList(useAgentNotesStore.getState());
    expect(list.unread).toBe(0);
    expect(list.notes.every((n) => n.readAt)).toBe(true);
    // An older read time is kept.
    expect(list.notes[2].readAt).toBe('2026-10-20T11:00:00.000Z');
    await done;
    expect(api.markAgentNotesRead).toHaveBeenCalledWith({ kind: 'canvas' }, 'an_3');
  });

  it('marks read only up to the given update (older ones), not newer arrivals', () => {
    sync('p1', [note('an_3'), note('an_2'), note('an_1')], 3);
    api.markAgentNotesRead.mockResolvedValue({ ids: ['an_2', 'an_1'], unread: 1 });
    void useAgentNotesStore.getState().markRead({ kind: 'canvas' }, 'an_2');
    const list = selectCanvasList(useAgentNotesStore.getState());
    expect(list.notes.map((n) => Boolean(n.readAt))).toEqual([false, true, true]);
    expect(list.unread).toBe(1);
  });

  it('marks just the given updates read (a clicked card)', () => {
    sync('p1', [note('an_2'), note('an_1')], 2);
    api.markAgentNotesRead.mockResolvedValue({ ids: ['an_2'], unread: 1 });
    void useAgentNotesStore.getState().markReadIds({ kind: 'canvas' }, ['an_2']);
    const list = selectCanvasList(useAgentNotesStore.getState());
    expect(list.notes.map((n) => Boolean(n.readAt))).toEqual([true, false]);
    expect(list.unread).toBe(1);
    expect(api.markAgentNotesRead).toHaveBeenCalledWith({ kind: 'canvas' }, undefined, ['an_2']);
  });

  it('dismisses optimistically and puts the update back if the server refuses', async () => {
    sync('p1', [note('an_1')], 1);
    api.dismissAgentNote.mockRejectedValue(new Error('That update is no longer in the list'));
    const done = useAgentNotesStore.getState().dismiss({ kind: 'canvas' }, 'an_1');
    expect(selectCanvasList(useAgentNotesStore.getState()).notes[0].dismissedAt).toBeTruthy();
    expect(selectCanvasList(useAgentNotesStore.getState()).unread).toBe(0);
    await done;
    expect(selectCanvasList(useAgentNotesStore.getState()).notes[0].dismissedAt).toBeNull();
    expect(selectCanvasList(useAgentNotesStore.getState()).unread).toBe(1);
    expect(useAgentNotesStore.getState().error).toBe('That update is no longer in the list');
  });

  it('loads the canvas list on demand', async () => {
    api.fetchAgentNotes.mockResolvedValue({ projectId: 'p3', notes: [note('an_7')], unread: 1, keptWith: 'project' });
    await useAgentNotesStore.getState().hydrateCanvas();
    expect(useAgentNotesStore.getState().canvasProjectId).toBe('p3');
    expect(selectCanvasList(useAgentNotesStore.getState()).notes.map((n) => n.id)).toEqual(['an_7']);
  });

  it('never lets a slower fetch overwrite a newer socket push', async () => {
    let answer: (value: unknown) => void = () => {};
    api.fetchAgentNotes.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const loading = useAgentNotesStore.getState().hydrateCanvas();
    sync('p1', [note('an_2'), note('an_1')], 2);
    answer({ projectId: 'p1', notes: [note('an_1')], unread: 1, keptWith: 'project' });
    await loading;
    expect(selectCanvasList(useAgentNotesStore.getState()).notes.map((n) => n.id)).toEqual(['an_2', 'an_1']);
  });

  it('takes queued arrivals once', () => {
    sync('p1', [], 0);
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_1'), unread: 1, at: 2 });
    emit({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2'), unread: 2, at: 3 });
    expect(useAgentNotesStore.getState().takeArrivals('canvas:p1')).toEqual(['an_1', 'an_2']);
    expect(useAgentNotesStore.getState().takeArrivals('canvas:p1')).toEqual([]);
  });

  it('holds outlines by source, hover over Show over the card', () => {
    const { setOutline } = useAgentNotesStore.getState();
    setOutline('card', { refs: ['n1'], color: '#E8825A', delayMs: 800, staggerMs: 250 });
    setOutline('hover', { refs: ['n2'], color: '#E8825A', delayMs: 0, staggerMs: 0 });
    expect(useAgentNotesStore.getState().activeOutline()?.refs).toEqual(['n2']);
    setOutline('hover', null);
    expect(useAgentNotesStore.getState().activeOutline()?.refs).toEqual(['n1']);
  });
});
