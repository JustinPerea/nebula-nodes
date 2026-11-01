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
 * - Nothing else covers the board for good: the notices at its top come and
 *   go, so they don't move the camera.
 *
 * The band is measured from the bar itself (its height changes with the skin
 * and the font). With no layout to measure (before the first layout, or in
 * jsdom), it is BOARD_BAR_BAND_PX.
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

type Measurable = Pick<Element, 'getBoundingClientRect'>;

/**
 * The insets of `board` (the Board view's column) given its control bar
 * `bar`, or null when either has no layout to measure.
 */
export function measureBoardViewInsets(board: Measurable | null | undefined, bar: Measurable | null | undefined): ViewInsets | null {
  const box = board?.getBoundingClientRect();
  const edge = bar?.getBoundingClientRect();
  if (!box || !edge || box.height <= 0 || edge.height <= 0) return null;
  return { top: 0, right: 0, bottom: Math.max(0, Math.min(box.height, box.bottom - edge.top)), left: 0 };
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
