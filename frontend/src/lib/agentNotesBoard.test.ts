import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentNote, AgentNotesSurface } from './agentNotes';

const api = vi.hoisted(() => ({ fetchAgentNotes: vi.fn() }));
vi.mock('./agentNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentNotes')>()),
  ...api,
}));

const { hydrateBoard, selectBoardList } = await import('./agentNotesBoard');
const { useAgentNotesStore } = await import('../store/agentNotesStore');

const CLAUDE = { kind: 'agent', id: 'claude', name: 'Claude Code', color: '#E8825A' } as const;

function note(id: string, at: string): AgentNote {
  return {
    id, author: CLAUDE, source: 'agent', about: 'other', at,
    text: `update ${id}`, parts: [{ text: `update ${id}` }], refs: [], actions: [],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
  };
}

const older = [
  note('an_000000000003', '2026-10-21T12:03:00.000Z'),
  note('an_000000000002', '2026-10-21T12:02:00.000Z'),
  note('an_000000000001', '2026-10-21T12:01:00.000Z'),
];
const fresh = note('an_000000000004', '2026-10-21T12:04:00.000Z');

describe('hydrateBoard', () => {
  beforeEach(() => {
    useAgentNotesStore.setState({ lists: {}, boardSeq: {}, arrivals: [], boardInView: 'b1', error: null });
    api.fetchAgentNotes.mockReset();
  });

  it('loads again, instead of dropping the list, when a board note lands while it loads', async () => {
    // Review finding (2026-10-21): an agent's post_note(board=b1) arriving over
    // the socket during the first GET threw the whole load away, leaving
    // "This board" with only the new note, never loaded, while the count said 4.
    let calls = 0;
    api.fetchAgentNotes.mockImplementation(async (surface: AgentNotesSurface) => {
      expect(surface).toEqual({ kind: 'board', boardId: 'b1' });
      calls += 1;
      if (calls === 1) {
        useAgentNotesStore.getState().apply({
          type: 'agentNotes', surface: 'board', op: 'added', boardId: 'b1',
          note: fresh, unread: 4, at: Date.now(), removed: [],
        });
        return { notes: older, unread: 3 };
      }
      return { notes: [fresh, ...older], unread: 4 };
    });

    await hydrateBoard('b1');

    const list = selectBoardList(useAgentNotesStore.getState(), 'b1');
    expect(api.fetchAgentNotes).toHaveBeenCalledTimes(2);
    expect(list.loaded).toBe(true);
    expect(list.notes.map((n) => n.id)).toEqual([fresh.id, ...older.map((n) => n.id)]);
    expect(list.unread).toBe(4);
  });

  it('loads once when nothing lands meanwhile', async () => {
    api.fetchAgentNotes.mockResolvedValue({ notes: older, unread: 3 });
    await hydrateBoard('b1');
    const list = selectBoardList(useAgentNotesStore.getState(), 'b1');
    expect(api.fetchAgentNotes).toHaveBeenCalledTimes(1);
    expect(list.loaded).toBe(true);
    expect(list.notes).toHaveLength(3);
  });

  it('stops after a few tries under a steady stream of board notes', async () => {
    let n = 10;
    api.fetchAgentNotes.mockImplementation(async () => {
      n += 1;
      useAgentNotesStore.getState().apply({
        type: 'agentNotes', surface: 'board', op: 'added', boardId: 'b1',
        note: note(`an_0000000000${n}`, '2026-10-21T12:10:00.000Z'), unread: 1, at: Date.now(), removed: [],
      });
      return { notes: older, unread: 3 };
    });
    await hydrateBoard('b1');
    expect(api.fetchAgentNotes).toHaveBeenCalledTimes(3);
  });

  it('tries again a little later, while the board is in view, once the stream has stopped', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      api.fetchAgentNotes.mockImplementation(async () => {
        calls += 1;
        if (calls <= 3) {
          useAgentNotesStore.getState().apply({
            type: 'agentNotes', surface: 'board', op: 'added', boardId: 'b1',
            note: note(`an_00000000002${calls}`, '2026-10-21T12:10:00.000Z'), unread: 1, at: Date.now(), removed: [],
          });
        }
        return { notes: older, unread: 3 };
      });
      await hydrateBoard('b1');
      expect(selectBoardList(useAgentNotesStore.getState(), 'b1').loaded).toBe(false);
      await vi.runAllTimersAsync();
      expect(api.fetchAgentNotes).toHaveBeenCalledTimes(4);
      expect(selectBoardList(useAgentNotesStore.getState(), 'b1').loaded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not try again for a board no longer in view', async () => {
    vi.useFakeTimers();
    try {
      api.fetchAgentNotes.mockImplementation(async () => {
        useAgentNotesStore.getState().apply({
          type: 'agentNotes', surface: 'board', op: 'added', boardId: 'b1',
          note: note('an_000000000031', '2026-10-21T12:10:00.000Z'), unread: 1, at: Date.now(), removed: [],
        });
        return { notes: older, unread: 3 };
      });
      await hydrateBoard('b1');
      useAgentNotesStore.setState({ boardInView: null });
      await vi.runAllTimersAsync();
      expect(api.fetchAgentNotes).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a board that is gone without a list', async () => {
    api.fetchAgentNotes.mockRejectedValue(new Error('404'));
    await hydrateBoard('b1');
    expect(api.fetchAgentNotes).toHaveBeenCalledTimes(1);
    expect(selectBoardList(useAgentNotesStore.getState(), 'b1').loaded).toBe(false);
  });
});
