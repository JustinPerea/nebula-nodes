import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/react';

/**
 * The parts of the Board view's column that count as outside the view (GM,
 * #213 round 3): a whole-board fit, an Update's Show, and a new tile's "fully
 * in view" (paste, drop and Add images, #210's placement) all use the column
 * less these insets, so nothing they place sits under the board's controls.
 *
 * - The control bar's band: the bar (− + Fit Add images) floats over the
 *   board's bottom-left corner, and the whole width of the board from the
 *   bar's top edge down is outside. A card beside the bar in its band reads
 *   as tucked under it, and a fitted bottom row there is covered at narrow
 *   widths, where the bar spans most of the column.
 * - The Studio's notices at the board's top (#210 round 6q, GM r95): while a
 *   line shows, the whole width of the board from its top down to the notice
 *   stack's bottom, and BOARD_NOTICE_GAP_PX below it, is outside, so a fit
 *   never puts a card under a line (at 1024 x 640 with the offline row up, a
 *   three-line line ran over the fitted card: the refit after the row opened
 *   centred the card in a column the row had shortened, under the line).
 *   Their coming and going still never moves the camera by itself (GM #213
 *   round 3): they count in the next fit, refit (a column resize, the
 *   offline row opening or closing), Show or placement, never as one.
 *
 * The band is measured from the bar itself (its height changes with the skin
 * and the font), the notice band from the stack. With no layout to measure
 * (before the first layout, or in jsdom), the bar's band is
 * BOARD_BAR_BAND_PX and there is no notice band.
 */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The control bar's band when it can't be measured: the bar is 38 px tall
 * (28 px controls, 4 px padding and a 1 px border above and below), and React
 * Flow's Panel puts it 15 px above the board's bottom edge: 15 + 38 = 53.
 */
export const BOARD_BAR_BAND_PX = 53;

export const BOARD_FALLBACK_INSETS: ViewInsets = Object.freeze({ top: 0, right: 0, bottom: BOARD_BAR_BAND_PX, left: 0 });

/** The room kept below the notice stack: the stack's own offset from the board's top (moodboard-board.css, 12 px). */
export const BOARD_NOTICE_GAP_PX = 12;

type Measurable = Pick<Element, 'getBoundingClientRect'>;

/**
 * The insets of `board` (the Board view's column) given its control bar
 * `bar` and its notice stack `notices` (the Studio's lines over its top), or
 * null when the board or the bar has no layout to measure. An empty stack (0
 * tall) or none adds no band.
 */
export function measureBoardViewInsets(board: Measurable | null | undefined, bar: Measurable | null | undefined,
  notices?: Measurable | null): ViewInsets | null {
  const box = board?.getBoundingClientRect();
  const edge = bar?.getBoundingClientRect();
  if (!box || !edge || box.height <= 0 || edge.height <= 0) return null;
  const stack = notices?.getBoundingClientRect();
  const top = stack && stack.height > 0 ? Math.max(0, Math.min(box.height, stack.bottom - box.top + BOARD_NOTICE_GAP_PX)) : 0;
  return { top, right: 0, bottom: Math.max(0, Math.min(box.height, box.bottom - edge.top)), left: 0 };
}

/**
 * The camera that frames `bounds` in a `width` x `height` column inside
 * `insets`: React Flow's fit of the part inside, moved by the top and left
 * insets. The one fit computation (BoardCanvas: Fit, the fit on open, a
 * refit, an Update's Show).
 */
export function frameInInsets(bounds: Rect, width: number, height: number, insets: ViewInsets,
  { minZoom, maxZoom, padding }: { minZoom: number; maxZoom: number; padding: number }): Viewport {
  const inside = insideInsets(width, height, insets);
  const to = getViewportForBounds(bounds, inside.width, inside.height, minZoom, maxZoom, padding);
  return { x: to.x + inside.x, y: to.y + inside.y, zoom: to.zoom };
}

/** The part of a `width` x `height` column inside the insets, as an offset and a size (at least 1 px each way). */
export function insideInsets(width: number, height: number, insets: ViewInsets) {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(1, width - insets.left - insets.right),
    height: Math.max(1, height - insets.top - insets.bottom),
  };
}
