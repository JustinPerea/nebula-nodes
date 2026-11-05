/**
 * PR #204 round 13 (review 10 held-calls MEDIUM-1): the Updates' mark-read (POST
 * /api/canvas/agent-notes/read and the board's, require_person) is never sent by a tab that isn't
 * connected as the person: held, demoted, or before the socket's first answer. Opening the list
 * and each update that arrives while it is open ask for a read; one read per list waits, with the
 * newest `upTo` and every id asked for, and goes once on the promote. No line says anything: the
 * updates stay unread until the tab connects. On 8651112c each ask was sent and refused, with a
 * line, and each refusal registered its own retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentNote } from '../src/lib/agentNotes';

const api = vi.hoisted(() => ({ markAgentNotesRead: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/agentNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentNotes')>()),
  markAgentNotesRead: api.markAgentNotesRead,
  fetchAgentNotes: async () => { throw new Error('not read in these tests'); },
}));

const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const session = await import('../src/lib/personSession');
const { personWorkWaiting, resetPersonWorkForTests } = await import('../src/lib/personWork');

const CANVAS = { kind: 'canvas' } as const;
const KEY = 'canvas:p1';
const note = (id: string, minute: number): AgentNote => ({
  id, author: { kind: 'agent', id: 'claude', name: 'Claude', color: '#E8825A' }, source: 'agent', about: 'other',
  at: `2026-10-31T12:0${minute}:00.000Z`, text: `update ${id}`, parts: [{ text: `update ${id}` }], refs: [], actions: [],
  readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
} as AgentNote);
const store = () => useAgentNotesStore.getState();
/** The list, newest first. */
const sync = (notes: AgentNote[]) => store().apply({ type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: 'p1', notes, unread: notes.length, at: 1 });
const arrive = (n: AgentNote) => store().apply({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: n, unread: 9, at: 2, removed: [] });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const sent = () => api.markAgentNotesRead.mock.calls.map(([surface, upTo, ids]) => ({ surface, upTo, ids }));
const refusal = () => Object.assign(new Error('Only the person can do this.'), { status: 403, code: 'person_required' });

beforeEach(() => {
  api.markAgentNotesRead.mockReset().mockImplementation(async () => ({ ids: [], unread: 0, projectId: 'p1' }));
  session.resetPersonSessionForTests();
  resetPersonWorkForTests();
  store().reset();
});
afterEach(() => {
  session.notePersonPromoted();
  resetPersonWorkForTests();
  store().reset();
});

describe('a held tab sends no mark-read (review 10 MEDIUM-1)', () => {
  it('opening the list and an arrival while it is open: nothing sent, no line; the promote sends one read, the newest', async () => {
    session.reportPersonRequired();
    sync([note('an_1', 0)]);
    await store().markRead(CANVAS, 'an_1'); // the list opens
    arrive(note('an_2', 1));
    await store().markRead(CANVAS, 'an_2'); // an update arrives while it is open
    arrive(note('an_3', 2));
    await store().markRead(CANVAS, 'an_3');
    await flush();
    expect(sent()).toEqual([]);
    expect(store().error).toBeNull();
    expect(store().lists[KEY].notes.every((n) => n.readAt === null)).toBe(true);
    // One wait for the list, whatever was asked.
    expect(personWorkWaiting(`agentNotes.read:${KEY}`)).toBe(true);
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([{ surface: CANVAS, upTo: 'an_3', ids: undefined }]);
    session.reportPersonRequired();
    session.notePersonPromoted();
    await flush();
    expect(sent()).toHaveLength(1);
  });

  it('an older upTo asked after a newer one keeps the newer', async () => {
    session.reportPersonRequired();
    sync([note('an_2', 1), note('an_1', 0)]);
    await store().markRead(CANVAS, 'an_2');
    await store().markRead(CANVAS, 'an_1');
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([{ surface: CANVAS, upTo: 'an_2', ids: undefined }]);
  });

  it('ids (a card read) wait with it: those the upTo covers go with it, the rest as one ids read', async () => {
    session.reportPersonRequired();
    sync([note('an_4', 3), note('an_3', 2), note('an_2', 1), note('an_1', 0)]);
    await store().markReadIds(CANVAS, ['an_4']);
    await store().markRead(CANVAS, 'an_2');
    await store().markReadIds(CANVAS, ['an_1']);
    await store().markReadIds(CANVAS, ['an_3', 'an_4']);
    await flush();
    expect(sent()).toEqual([]);
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([
      { surface: CANVAS, upTo: 'an_2', ids: undefined },
      { surface: CANVAS, upTo: undefined, ids: ['an_4', 'an_3'] },
    ]);
  });

  it('what was read meanwhile (another tab of the person\'s) isn\'t read again', async () => {
    session.reportPersonRequired();
    sync([note('an_1', 0)]);
    await store().markRead(CANVAS, 'an_1');
    store().apply({ type: 'agentNotes', surface: 'canvas', op: 'read', projectId: 'p1', ids: ['an_1'], unread: 0, at: 3 });
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([]);
  });

  it('before the socket\'s first answer: nothing sent; the promote sends it', async () => {
    session.resetPersonSessionForTests({ unanswered: true });
    sync([note('an_1', 0)]);
    await store().markRead(CANVAS, 'an_1');
    await flush();
    expect(sent()).toEqual([]);
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([{ surface: CANVAS, upTo: 'an_1', ids: undefined }]);
  });

  it('a board\'s list waits on its own key', async () => {
    session.reportPersonRequired();
    const board = { kind: 'board', boardId: 'b1' } as const;
    store().apply({ type: 'agentNotes', surface: 'board', op: 'sync', boardId: 'b1', notes: [note('an_9', 0)], unread: 1, at: 1 });
    await store().markRead(board, 'an_9');
    expect(sent()).toEqual([]);
    expect(personWorkWaiting('agentNotes.read:board:b1')).toBe(true);
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([{ surface: board, upTo: 'an_9', ids: undefined }]);
  });

  it('a read refused in flight (a demote) joins the wait: the promote sends one read, the newest', async () => {
    sync([note('an_1', 0)]);
    api.markAgentNotesRead.mockImplementationOnce(async () => {
      session.reportPersonRequired(); // the gate refused it: the tab is held
      throw refusal();
    });
    await store().markRead(CANVAS, 'an_1');
    await flush();
    arrive(note('an_2', 1));
    await store().markRead(CANVAS, 'an_2');
    await flush();
    expect(sent()).toHaveLength(1); // the one that went before the demote
    session.notePersonPromoted();
    await flush();
    expect(sent().slice(1)).toEqual([{ surface: CANVAS, upTo: 'an_2', ids: undefined }]);
  });

  it('a read refused in flight, with nothing asked after it: the promote sends it, once', async () => {
    sync([note('an_1', 0)]);
    api.markAgentNotesRead.mockImplementationOnce(async () => {
      session.reportPersonRequired();
      throw refusal();
    });
    await store().markReadIds(CANVAS, ['an_1']); // a card read
    await flush();
    session.notePersonPromoted();
    await flush();
    expect(sent().slice(1)).toEqual([{ surface: CANVAS, upTo: undefined, ids: ['an_1'] }]);
    expect(store().error).toBeNull(); // its line went with the promote
  });
});
