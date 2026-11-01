import { create } from 'zustand';
import type { MoodboardImage } from '../../types';
import { resolveAssetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import type { MoodboardOp } from '../../lib/moodboardEdits';
import type { BoardPlaceholder } from './boardPlaceholder';

/**
 * Adds in flight, kept per board rather than in the open Studio (GM's ruling
 * on review 4: an add whose person left the board mid-upload isn't dropped,
 * it lands on that board). A board's held spots and List rows live here, by
 * the board's draft key, so they outlive a board switch or the Studio
 * closing: placement still counts them, and they show again when the person
 * comes back while the upload runs. Client-only: never in a draft, never
 * saved, never sent.
 */
interface BoardAddsState {
  /** By the board's draft key as it was when the add started (read through its aliases). */
  held: Record<string, BoardPlaceholder[]>;
}

export const useBoardAddStore = create<BoardAddsState>(() => ({ held: {} }));

/** Held spots' ids, unique across every board. */
let holderSeq = 0;
export function nextHolderId(): string {
  holderSeq += 1;
  return `placeholder-${holderSeq}`;
}

/** Nothing held, ids from 1 again (tests). */
export function resetBoardAdds() {
  holderSeq = 0;
  openBoard = null;
  useBoardAddStore.setState({ held: {} });
}

const resolve = (key: string) => resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key);

/** Every spot and row held for the board `key` names (a key that was copied to another counts as that one). */
export function heldOn(held: Record<string, BoardPlaceholder[]>, key: string): BoardPlaceholder[] {
  const board = resolve(key);
  const lists = Object.entries(held).filter(([from]) => from === board || resolve(from) === board).map(([, list]) => list);
  return lists.length === 1 ? lists[0] : lists.flat();
}

/** Change the held spots of the board `key` names. */
export function changeHeld(key: string, change: (current: BoardPlaceholder[]) => BoardPlaceholder[]) {
  const board = resolve(key);
  useBoardAddStore.setState((state) => {
    const next = change(heldOn(state.held, board));
    const held = Object.fromEntries(Object.entries(state.held).filter(([from]) => from !== board && resolve(from) !== board));
    if (next.length) held[board] = next;
    return { held };
  });
}

/** The holders `ids` name, gone from whichever board holds them. */
export function releaseHeld(ids: Iterable<string>) {
  const gone = new Set(ids);
  if (gone.size === 0) return;
  useBoardAddStore.setState((state) => ({ held: Object.fromEntries(Object.entries(state.held)
    .map(([key, list]) => [key, list.filter((holder) => !gone.has(holder.id))] as const)
    .filter(([, list]) => list.length > 0)) }));
}

/** Of the holders `ids` name, the filled ones (their image has faded in), gone. */
export function releaseFilled(ids: Iterable<string>) {
  const gone = new Set(ids);
  useBoardAddStore.setState((state) => ({ held: Object.fromEntries(Object.entries(state.held)
    .map(([key, list]) => [key, list.filter((holder) => !(gone.has(holder.id) && holder.filled))] as const)
    .filter(([, list]) => list.length > 0)) }));
}

/** The board open in the Studio now, and how it takes an add as its own
 *  step (with its undo). Null while no board is open. */
export interface OpenBoard {
  key: string;
  /** Adds the ops as one step of the open board (sent at once with `now`); false if it can't take them now. */
  commit: (ops: MoodboardOp[], label: string, aspects: Record<string, number>, now: boolean) => boolean;
}
let openBoard: OpenBoard | null = null;

export function setOpenBoard(board: OpenBoard) { openBoard = board; }
export function clearOpenBoard(board: OpenBoard) { if (openBoard === board) openBoard = null; }
/** The open board, if it is the one `key` names. */
export function openBoardFor(key: string): OpenBoard | null {
  return openBoard && resolve(openBoard.key) === resolve(key) ? openBoard : null;
}

/** The images of the board `key` names, as its draft holds them. */
export function boardImages(key: string): MoodboardImage[] {
  const draft = useAssetStudioDraftStore.getState().entries[resolve(key)]?.draft as { images?: MoodboardImage[] } | undefined;
  return draft?.images ?? [];
}
