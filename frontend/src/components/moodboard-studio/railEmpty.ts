import type { AssetScope } from '../../store/uiStore';

const SCOPE_NAME: Record<AssetScope, string> = { project: 'project', global: 'global' };
const BOARD_LIVES: Record<AssetScope, string> = { project: 'in this project', global: 'Global' };

/** What Moodboard Studio's rail says when a scope has no boards. When the open
 * board lives in the other scope it says so, so an empty list never reads as
 * a lost board. */
export function emptyRailMessage(scope: AssetScope, boardScope: AssetScope | null): string {
  if (boardScope && boardScope !== scope) return `No ${SCOPE_NAME[scope]} moodboards. This board is ${BOARD_LIVES[boardScope]}.`;
  return `No ${SCOPE_NAME[scope]} moodboards yet.`;
}
