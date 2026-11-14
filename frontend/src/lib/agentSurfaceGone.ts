import type { AgentCursorAnchor } from './wsClient';

/** What the Studios say is open: a saved board with its image ids, a saved
 *  Character with its view count (boardCanvasStore.studioBoard,
 *  studioCharacterStore). */
export interface OpenStudios {
  board: { boardId: string; imageIds: readonly string[] } | null;
  character: { characterId: string; viewCount: number } | null;
}

/**
 * The anchor's item no longer exists: an image removed from its board, or a
 * reference view removed from its Character (GM - Design 4). The cursor then
 * holds its spot. Only while that item's Studio is open on its board or
 * Character and the sub-item isn't there: a panel that closed isn't a removal.
 * A whole board or Character that is gone is the backend's to say (the
 * cursor leaves); a Style has no sub-items.
 */
export function itemIsGone(anchor: AgentCursorAnchor, open: OpenStudios): boolean {
  if (!('surface' in anchor)) return false;
  const [item, sub] = anchor.itemId.split('/');
  if (!sub) return false;
  if (anchor.surface === 'moodboard') {
    return open.board !== null && open.board.boardId === item && !open.board.imageIds.includes(sub);
  }
  if (anchor.surface === 'character') {
    const position = Number(sub);
    return open.character !== null && open.character.characterId === item
      && Number.isInteger(position) && position > open.character.viewCount;
  }
  return false;
}
