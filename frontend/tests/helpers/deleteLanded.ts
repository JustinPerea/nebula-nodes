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
 * presses Undo (or restores from another window) on the flag races the
 * answer. A busy CI runner lost that race: graphStore.fix16 "nothing unsaved"
 * timed out in run 41591009433, attempt 1, and the scene edit the race left
 * aside leaked into the next test.
 *
 * The product's own sign is the delete's notice: "Deleted the node." (or the
 * kept line after it) with its Undo, for the step on top of the undo stack,
 * set in the same synchronous call that ends the delete's hold
 * (applyDeleteAnswers, then settleStep). tests/deleteLandedRatchet.test.ts
 * keeps tests off the flag.
 */
export async function deleteLanded(store: GraphStoreLike, timeout = 3000): Promise<void> {
  await vi.waitFor(() => {
    const state = store.getState();
    const notice = state.undoNotice as { offer?: unknown; entry?: unknown } | null;
    expect(notice?.offer).toBe('undo');
    expect(notice?.entry).toBe(state.undoStack.at(-1));
  }, { timeout, interval: 5 });
}
