import { fetchAgentNotes, surfaceKey } from './agentNotes';
import { EMPTY_LIST, useAgentNotesStore, type SurfaceList } from '../store/agentNotesStore';

/**
 * A board's own Updates for the corner in Moodboard Studio (Justin's Q113 c).
 * The startup store (store/agentNotesStore.ts) only keeps what the socket
 * says, so no message is missed; loading a board's list and choosing the
 * board in view live here, in the corner's deferred chunk, to keep the
 * first load small.
 */

/** A board's list ("This board"), or an empty one. */
export function selectBoardList(state: { lists: Record<string, SurfaceList> }, boardId: string | null): SurfaceList {
  return boardId ? state.lists[surfaceKey({ kind: 'board', boardId })] ?? EMPTY_LIST : EMPTY_LIST;
}

/** Tries per load: a socket message for the board during a GET means load again. */
const HYDRATE_TRIES = 3;
/** After that many, one more load this much later, while the board is still in view. */
const HYDRATE_RETRY_MS = 2000;

/**
 * Load a board's list (GET /api/moodboards/{id}/agent-notes). If a socket
 * message for the board lands while a GET is in flight, that answer may be
 * older than the store, so load again rather than apply it: the next GET
 * starts after the message and already holds it. (Dropping it instead left
 * the list never loaded, since nothing replays board Updates on connect.)
 * Merging was ruled out: a read or dismiss can land mid-flight too.
 */
export async function hydrateBoard(boardId: string): Promise<void> {
  const key = surfaceKey({ kind: 'board', boardId });
  for (let attempt = 0; attempt < HYDRATE_TRIES; attempt += 1) {
    const seq = useAgentNotesStore.getState().boardSeq[key] ?? 0;
    let listing: Awaited<ReturnType<typeof fetchAgentNotes>>;
    try {
      listing = await fetchAgentNotes({ kind: 'board', boardId });
    } catch {
      return; // A board that is gone (or not saved yet) has no list; a reconnect tries again.
    }
    const store = useAgentNotesStore.getState();
    if ((store.boardSeq[key] ?? 0) !== seq) continue;
    store.apply({ type: 'agentNotes', surface: 'board', op: 'sync', boardId,
      notes: listing.notes, unread: listing.unread, at: Date.now() });
    return;
  }
  // A stream of messages outlasted every try: load again once it has had time
  // to stop, so the list doesn't stay unloaded until a reconnect.
  setTimeout(() => {
    const state = useAgentNotesStore.getState();
    if (state.boardInView === boardId && !state.lists[key]?.loaded) void hydrateBoard(boardId);
  }, HYDRATE_RETRY_MS);
}

/** The board whose updates drop cards from now on (null: none). Cards still
 *  waiting for another board never drop over this one. */
export function setBoardInView(boardId: string | null): void {
  const state = useAgentNotesStore.getState();
  if (state.boardInView === boardId) return;
  const keep = boardId === null ? null : surfaceKey({ kind: 'board', boardId });
  useAgentNotesStore.setState({
    boardInView: boardId,
    arrivals: state.arrivals.filter((a) => !a.key.startsWith('board:') || a.key === keep),
  });
}
