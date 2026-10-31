/**
 * PR #204 round 14, review 11 held-calls (lib: store/agentNotesStore sendRead, holdRead, sendHeldRead):
 * - LOW-1 (A1): a held read keeps the unread updates its `upTo` covered. When that `upTo` leaves the
 *   list before the promote (an agent's next "since its last turn" update replaces it), the promote
 *   still reads what the person saw, by id, and never the newer update they didn't.
 * - GM r23 item 5 (A3, A8): a mark-read refused in flight shows nothing. It is never the person's
 *   own press (the Updates corner reads on open, on an arrival into the open list, or as a card is
 *   used; there is no "Mark all read" control), so the updates stay unread with nothing marked read
 *   in the tab, and every refusal re-joins the list's one wait, however many times it is refused.
 * - LOW-5 N4 (A7): a read held on p1 never goes out once p2 is open.
 * - LOW-5 N10: an id held for the promote that the person's other tab reads meanwhile isn't sent.
 * - NIT-3 (A4): the promote's read on its way, and the list opened again at once: one read, not two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentNote } from '../src/lib/agentNotes';

const api = vi.hoisted(() => ({ markAgentNotesRead: vi.fn(), fetchAgentNotes: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/agentNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentNotes')>()),
  markAgentNotesRead: api.markAgentNotesRead,
  fetchAgentNotes: api.fetchAgentNotes,
}));
const { useAgentNotesStore } = await import('../src/store/agentNotesStore');
const session = await import('../src/lib/personSession');
const { personWorkWaiting, resetPersonWorkForTests } = await import('../src/lib/personWork');
const { pendingPromoteClears, pendingPromoteRetries } = await import('../src/lib/clearsOnPromote');

const CANVAS = { kind: 'canvas' } as const;
const WAIT = 'agentNotes.read:canvas:p1';
const note = (id: string, minute: number, about = 'other'): AgentNote => ({
  id, author: { kind: 'agent', id: 'claude', name: 'Claude', color: '#E8825A' }, source: 'agent', about,
  at: `2026-10-31T12:0${minute}:00.000Z`, text: `u ${id}`, parts: [{ text: `u ${id}` }], refs: [], actions: [],
  readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
} as AgentNote);
const store = () => useAgentNotesStore.getState();
const sync = (notes: AgentNote[], projectId = 'p1') => store().apply({
  type: 'agentNotes', surface: 'canvas', op: 'sync', projectId, notes, unread: notes.filter((n) => !n.readAt).length, at: 1,
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const sent = () => api.markAgentNotesRead.mock.calls.map(([surface, upTo, ids]) => ({ surface, upTo, ids }));
const refusal = () => Object.assign(new Error('Only the person can do this.'), { status: 403, code: 'person_required' });
/** The gate refuses it as the tab loses the person (lib/backend holds the tab on a real 403). */
const refusedInFlight = async () => { session.reportPersonRequired(); throw refusal(); };
const list = () => store().lists['canvas:p1'];

beforeEach(() => {
  api.markAgentNotesRead.mockReset().mockImplementation(async () => ({ ids: [], unread: 0, projectId: 'p1' }));
  api.fetchAgentNotes.mockReset().mockRejectedValue(new Error('not read'));
  session.resetPersonSessionForTests();
  resetPersonWorkForTests();
  store().reset();
});
afterEach(() => {
  session.notePersonPromoted();
  resetPersonWorkForTests();
  store().reset();
});

describe('review 11 LOW-1: the held read keeps what its upTo covered', () => {
  it('A1: the upTo is replaced before the promote; the promote reads the updates it covered, by id, and not the new one', async () => {
    session.reportPersonRequired();
    sync([note('s1', 2, 'sinceLastTurn'), note('an_1', 1), note('an_0', 0)]);
    await store().markRead(CANVAS, 's1'); // the list opened while held, then closed
    expect(sent()).toEqual([]);
    store().apply({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1',
      note: note('s2', 3, 'sinceLastTurn'), unread: 3, at: 2, removed: ['s1'] });
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([{ surface: CANVAS, upTo: undefined, ids: ['an_1', 'an_0'] }]);
  });

  it('the upTo still listed: one upTo read, as before', async () => {
    session.reportPersonRequired();
    sync([note('an_1', 1), note('an_0', 0)]);
    await store().markRead(CANVAS, 'an_1');
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([{ surface: CANVAS, upTo: 'an_1', ids: undefined }]);
  });

  it('what it covered and was read meanwhile, or pruned, isn\'t sent', async () => {
    session.reportPersonRequired();
    sync([note('s1', 2, 'sinceLastTurn'), note('an_1', 1), note('an_0', 0)]);
    await store().markRead(CANVAS, 's1');
    store().apply({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1',
      note: note('s2', 3, 'sinceLastTurn'), unread: 3, at: 2, removed: ['s1', 'an_0'] });
    store().apply({ type: 'agentNotes', surface: 'canvas', op: 'read', projectId: 'p1', ids: ['an_1'], unread: 1, at: 3 });
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([]);
  });
});

describe('GM r23 item 5: a mark-read refused in flight shows nothing and re-joins the one wait', () => {
  it('the updates stay unread, nothing is marked read in the tab, no line, no retry of its own', async () => {
    sync([note('an_1', 1), note('an_0', 0)]);
    api.markAgentNotesRead.mockImplementationOnce(refusedInFlight);
    await store().markRead(CANVAS, 'an_1');
    await flush();
    expect(sent()).toHaveLength(1);
    expect(store().error).toBeNull();
    expect(list().notes.map((n) => n.readAt)).toEqual([null, null]);
    expect(list().unread).toBe(2);
    expect([pendingPromoteClears(), pendingPromoteRetries()]).toEqual([0, 0]);
    expect(personWorkWaiting(WAIT)).toBe(true);
    expect(api.fetchAgentNotes).not.toHaveBeenCalled(); // nothing changed, so nothing to read again
  });

  it('A3: a demote between the promote\'s send and its answer: held again with no line, sent once on the next promote, never twice', async () => {
    session.reportPersonRequired();
    sync([note('an_1', 1)]);
    await store().markRead(CANVAS, 'an_1');
    api.markAgentNotesRead.mockImplementationOnce(refusedInFlight);
    session.notePersonPromoted();
    await flush();
    expect(sent()).toHaveLength(1);
    expect(store().error).toBeNull();
    expect(list().notes[0].readAt).toBeNull();
    session.notePersonPromoted();
    await flush();
    expect(sent()).toHaveLength(2);
    session.reportPersonRequired();
    session.notePersonPromoted();
    await flush();
    expect(sent()).toHaveLength(2);
  });

  it('A8: refused in flight, then refused again on its promote: still held, sent on the next promote', async () => {
    sync([note('an_1', 1)]);
    api.markAgentNotesRead.mockImplementationOnce(refusedInFlight);
    await store().markRead(CANVAS, 'an_1');
    await flush();
    api.markAgentNotesRead.mockImplementationOnce(refusedInFlight);
    session.notePersonPromoted();
    await flush();
    expect(sent()).toHaveLength(2);
    expect(store().error).toBeNull();
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([
      { surface: CANVAS, upTo: 'an_1', ids: undefined },
      { surface: CANVAS, upTo: 'an_1', ids: undefined },
      { surface: CANVAS, upTo: 'an_1', ids: undefined },
    ]);
    expect(store().error).toBeNull();
  });

  it('a card read refused in flight: no line either, and it goes once on the promote', async () => {
    sync([note('an_1', 1)]);
    api.markAgentNotesRead.mockImplementationOnce(refusedInFlight);
    await store().markReadIds(CANVAS, ['an_1']);
    await flush();
    expect(store().error).toBeNull();
    session.notePersonPromoted();
    await flush();
    expect(sent().slice(1)).toEqual([{ surface: CANVAS, upTo: undefined, ids: ['an_1'] }]);
  });

  it('a failure with another reason still says so (it is not this tab\'s connection)', async () => {
    sync([note('an_1', 1)]);
    api.markAgentNotesRead.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await store().markRead(CANVAS, 'an_1');
    await flush();
    expect(store().error).toBeTruthy();
    expect(personWorkWaiting(WAIT)).toBe(false);
  });
});

describe('review 11 LOW-5: the held read\'s guards', () => {
  it('A7 (N4): held on p1, then p2 opens and the promote comes: p1\'s read is dropped, p2 isn\'t read', async () => {
    session.reportPersonRequired();
    sync([note('an_1', 1)]);
    await store().markRead(CANVAS, 'an_1');
    sync([note('p2_1', 1)], 'p2');
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([]);
  });

  it('N10: a card read held for the promote, read meanwhile by the person\'s other tab, isn\'t sent', async () => {
    session.reportPersonRequired();
    sync([note('an_2', 2), note('an_1', 1)]);
    await store().markReadIds(CANVAS, ['an_1']);
    store().apply({ type: 'agentNotes', surface: 'canvas', op: 'read', projectId: 'p1', ids: ['an_1'], unread: 1, at: 3 });
    session.notePersonPromoted();
    await flush();
    expect(sent()).toEqual([]);
  });
});

describe('review 11 NIT-3: no second read right after the promote', () => {
  it('A4: the promote\'s read on its way, the list opened again at once: one read', async () => {
    session.reportPersonRequired();
    sync([note('an_1', 1)]);
    await store().markRead(CANVAS, 'an_1');
    let answer: (value: unknown) => void = () => {};
    api.markAgentNotesRead.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    session.notePersonPromoted();
    await flush();
    const again = store().markRead(CANVAS, 'an_1'); // the person opens the list again at once
    await flush();
    expect(sent()).toHaveLength(1);
    answer({ ids: ['an_1'], unread: 0, projectId: 'p1' });
    await again;
    await flush();
    expect(sent()).toHaveLength(1);
    expect(list().notes[0].readAt).not.toBeNull();
  });

  it('once that read has answered, the same read asked again goes (nothing is left waiting on it)', async () => {
    sync([note('an_1', 1)]);
    await store().markRead(CANVAS, 'an_1');
    await flush();
    await store().markRead(CANVAS, 'an_1');
    await flush();
    expect(sent()).toHaveLength(2);
  });

  it('a newer read while one is on its way still goes', async () => {
    sync([note('an_1', 1)]);
    api.markAgentNotesRead.mockImplementationOnce(() => new Promise(() => {}));
    void store().markRead(CANVAS, 'an_1');
    store().apply({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: note('an_2', 2), unread: 2, at: 2 });
    void store().markRead(CANVAS, 'an_2');
    await flush();
    expect(sent().map((s) => s.upTo)).toEqual(['an_1', 'an_2']);
  });
});
