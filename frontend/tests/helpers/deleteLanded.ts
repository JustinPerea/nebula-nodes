import { expect, vi } from 'vitest';

/** The part of the graph store deleteLanded reads (pass useGraphStore). */
interface GraphStoreLike {
  getState: () => { undoNotice: unknown; undoStack: readonly unknown[] };
}

/**
 * Waits until the person's delete (deleteNode on a backend node) has had its
 * answer. A fake backend's own "deleted" flag is no such sign: it flips when
 * the DELETE arrives, before the answer. Until the answer, the product drops
 * an Undo ("Nothing was undone. Your last change was still saving.", GM r18
 * option (c)) and holds a sync that brings the node back, so a test that
 * presses Undo (or restores from another window) on the flag, or after a
 * fixed sleep, races the answer. A busy CI runner lost that race:
 * graphStore.fix16 "nothing unsaved" timed out in run 41591009433, attempt 1,
 * and the scene edit the race left aside leaked into the next test.
 *
 * Two signs, both required:
 * - the store's own hold has ended (deleteInFlightForTests: no node's delete
 *   unanswered, and an Undo now isn't dropped for the delete on top);
 * - the delete's notice is up: "Deleted the node." (or the kept line after
 *   it) with its Undo, for the step on top of the undo stack.
 * Today both change in one synchronous call (applyDeleteAnswers sets the
 * notice, then its finally clears deletesInFlight and settles the step), and
 * graphStore.fix16 "the delete's hold has ended by the time anything can act
 * on its notice" pins that for the tests that wait on the notice's text.
 * Reading the hold here keeps this helper right even if that coupling breaks
 * (PR #221 review 1 NIT-3).
 *
 * The store module is read when the wait starts, so the test file has
 * already loaded it (after its own vi.mock and fetch setup).
 * tests/deleteLandedRatchet.test.ts keeps tests off the flag and off fixed
 * sleeps between a delete and its Undo.
 */
export async function deleteLanded(store: GraphStoreLike, timeout = 3000): Promise<void> {
  const { deleteInFlightForTests } = await import('../../src/store/graphStore');
  await vi.waitFor(() => {
    expect(deleteInFlightForTests(), 'a delete is still on its way').toBe(false);
    const state = store.getState();
    const notice = state.undoNotice as { offer?: unknown; entry?: unknown } | null;
    expect(notice?.offer).toBe('undo');
    expect(notice?.entry).toBe(state.undoStack.at(-1));
  }, { timeout, interval: 5 });
}
