/**
 * The Board view's camera as the agent cursor reads it (PR #233 slice 7b).
 *
 * The Board view is a React Flow with `onlyRenderVisibleElements`, so a card
 * panned fully out of the pane has no DOM element and so no
 * `data-agent-anchor`. The resolver can't find it by query, but the view
 * knows where every card is (flow coordinates) and where the camera is, so
 * it registers that here and the resolver works out the card's screen rect
 * the way React Flow does (`pane + translate + position * zoom`). Nothing is
 * rendered, panned or opened for it. In the cursor chunk and the Studio's.
 */

export interface BoardCardRect { imageId: string; x: number; y: number; width: number; height: number }

export interface BoardView {
  /** The board's saved id (the anchor's board part). */
  boardId: string;
  /** The React Flow pane, whose client rect is the camera's origin. */
  pane(): Element | null;
  /** The camera: translate and zoom, as React Flow's `transform`. */
  camera(): { x: number; y: number; zoom: number } | null;
  /** Every image card on the board, in flow coordinates. */
  cards(): readonly BoardCardRect[];
  /** Called when the camera or the cards move. Returns its unsubscribe. */
  subscribe(listener: () => void): () => void;
}

let current: BoardView | null = null;
const watchers = new Set<() => void>();

/** The Board view mounted (or its board changed): it is the one in view. Returns its unregister. */
export function registerBoardView(view: BoardView): () => void {
  current = view;
  for (const watcher of [...watchers]) watcher();
  return () => {
    if (current !== view) return;
    current = null;
    for (const watcher of [...watchers]) watcher();
  };
}

export const boardView = (): BoardView | null => current;

/** Wakes `listener` when a Board view comes or goes, and on its camera moves. */
export function watchBoardView(listener: () => void): () => void {
  watchers.add(listener);
  let own: (() => void) | null = current?.subscribe(listener) ?? null;
  const rewire = () => { own?.(); own = current?.subscribe(listener) ?? null; };
  watchers.add(rewire);
  return () => { watchers.delete(listener); watchers.delete(rewire); own?.(); };
}
