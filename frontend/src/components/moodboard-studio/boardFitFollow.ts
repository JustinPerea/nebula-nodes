/**
 * Whether the Board view's camera is on the whole-board fit, and the refit
 * that keeps it there when the board's column changes size (GM, #209 (a): the
 * window narrows or widens, the offline row opens or closes, anything else
 * that moves the grid).
 *
 * - Fitted is the person's intent (GM, #213 round 3 and 3b): it is set by a
 *   fit (Fit, Shift+1, the fit on open, a refit) and by the camera landing on
 *   the fit of the layout the board has now (its cards, in its column, less
 *   the view insets, within `sameCamera`'s tolerance) however it got there: a
 *   pan or zoom back onto it, a zoom-button spring or an Update's Show that
 *   lands on it. Only a camera move clears it: the person's own (a pan, a
 *   pinch, a wheel, the autopan while a card is dragged to the edge) that
 *   doesn't land on the fit, or the camera's own (the zoom buttons, a Show)
 *   going somewhere else. A card added, moved or removed doesn't: the camera
 *   stays where it is, and the next resize refits to the cards there are
 *   then.
 * - So the follower keeps the camera where the board was last fitted (the
 *   anchor): fitted is "a spring is heading to the fit, or the camera is on
 *   the fit now, or it hasn't moved from the anchor". A card edit moves no
 *   camera, so it keeps the anchor; any camera move does, even one no
 *   callback reported (React Flow doesn't report every move a person makes
 *   the same way: after one mouse-wheel notch its pan-on-scroll never calls
 *   onMoveStart again), unless it lands on the fit.
 * - A board that opens fitted (a fresh open, or a camera kept from earlier in
 *   the visit that was fitted then) is fit at once as soon as it has both a
 *   size that isn't 0 x 0 and cards to fit (`ready`): a board laid out late
 *   (mounted while hidden), or whose cards arrive after it mounts, still
 *   opens fitted to its column. A move the person makes first cancels it.
 * - After that, a column resize refits at most once a frame, if the board is
 *   fitted when the frame runs (the camera judged against the fit of the
 *   column before the resize), springing to the new column's fit.
 * - A refit changes the camera, never the column, so it can't call itself.
 */
export interface FitCamera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * GM, #213 round 3 and r5: half a screen pixel in x and y, and the zoom
 * within 0.1% of the second camera's (the fit's: 0.001 at zoom 1). Half a
 * pixel is less than anyone can see (one mouse-wheel notch pans about 50 px)
 * and absorbs floating-point rounding on the way through d3. The zoom is
 * relative so it means the same at every zoom: an absolute 0.001 at the
 * board's minimum zoom (0.02) would count a 5% pinch as the fit.
 */
export const FIT_TOLERANCE_PX = 0.5;
export const FIT_TOLERANCE_ZOOM = 0.001;

export function sameCamera(a: FitCamera, b: FitCamera): boolean {
  return Math.abs(a.x - b.x) <= FIT_TOLERANCE_PX && Math.abs(a.y - b.y) <= FIT_TOLERANCE_PX
    && Math.abs(a.zoom - b.zoom) <= FIT_TOLERANCE_ZOOM * b.zoom;
}

export interface BoardFitFollow {
  /** Fitted: set by a fit or by landing on the fit, cleared only by a camera move off it; or a spring is heading to the fit. */
  readonly fitted: boolean;
  /** `camera` is on the fit of the layout the board has now: a move landing there leaves the board fitted. */
  onFit(camera: FitCamera): boolean;
  /** A spring heading to the fit has started (Fit, a refit, a zoom or Show that lands on it): fitted while it runs, and where it lands. */
  headingToFit(): void;
  /** The spring has landed: no spring is heading anywhere now; one that was heading to the fit leaves the board fitted where it landed. */
  springEnded(): void;
  /** A camera move this view didn't make, to where the camera is now: no spring heads anywhere, no fit on open is still to come, and the board is fitted only if the move landed on the fit. */
  taken(): void;
  /** The board may have cards to fit now: make the fit on open if it is still to come. */
  ready(): void;
  /** React Flow made its camera again, at its default: fit at once again, as on open. */
  reopen(): void;
  /**
   * The camera's own move somewhere other than the fit (the zoom buttons, an
   * Update's Show of some cards): not fitted, and a refit still waiting
   * doesn't run.
   */
  aside(): void;
  /** The board column measured at this size. */
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface BoardFitFollowOptions {
  /** Fit on open: a fresh open, or a camera kept from earlier in the visit that was fitted then. */
  fitted: boolean;
  /** Where the camera is now. */
  camera: () => FitCamera;
  /** The whole-board fit of the cards the board has now in a column this size, or null when there is nothing to fit. */
  fitFor: (width: number, height: number) => FitCamera | null;
  /** Fit the whole board to the column: at once on open, on the spring after that. False when there was nothing to fit. */
  refit: (instant: boolean) => boolean;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export function createBoardFitFollow({ fitted, camera, fitFor, refit, requestFrame = (cb) => window.requestAnimationFrame(cb),
  cancelFrame = (id) => window.cancelAnimationFrame(id) }: BoardFitFollowOptions): BoardFitFollow {
  let openFit = fitted;
  // Where the camera was when the board was last fitted (a fit spring or the
  // fit on open landed, or a move landed on the fit): while the camera hasn't moved from it,
  // the board is fitted, whatever happened to the cards since. Any camera
  // move off it clears it, even one no callback reported.
  let anchor: FitCamera | null = null;
  let heading = false;
  let size: { width: number; height: number } | null = null;
  // The column before the resizes a waiting refit frame will answer: the
  // camera is judged against that column's fit until the frame runs.
  let before: { width: number; height: number } | null = null;
  let frame = 0;
  const onFitAt = (at: FitCamera, column: { width: number; height: number } | null) => {
    const fit = column ? fitFor(column.width, column.height) : null;
    return fit !== null && sameCamera(at, fit);
  };
  const isFitted = () => {
    if (heading) return true;
    const now = camera();
    return onFitAt(now, before ?? size) || (anchor !== null && sameCamera(now, anchor));
  };
  const cancel = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
    before = null;
  };
  const open = () => {
    if (openFit && size && refit(true)) {
      openFit = false;
      anchor = camera();
    }
  };
  return {
    get fitted() { return isFitted(); },
    onFit: (at) => onFitAt(at, size),
    headingToFit() { heading = true; },
    springEnded() {
      // A spring that was heading to the fit has landed there: the fit the
      // person asked for, even if a card changed while it ran.
      if (heading) anchor = camera();
      heading = false;
    },
    taken() {
      heading = false;
      openFit = false;
      // One tolerance whether a move was reported or not (GM r5): a move
      // that stays within sameCamera of the anchor keeps it.
      const now = camera();
      if (onFitAt(now, before ?? size)) anchor = now;
      else if (anchor !== null && !sameCamera(now, anchor)) anchor = null;
    },
    ready: open,
    reopen() {
      openFit = true;
      anchor = null;
      heading = false;
      cancel();
      open();
    },
    aside() {
      heading = false;
      anchor = null;
      cancel();
    },
    resize(width, height) {
      if (!width || !height) return;
      const previous = size;
      const same = previous !== null && previous.width === width && previous.height === height;
      size = { width, height };
      if (openFit) {
        open();
        return;
      }
      if (!previous || same || frame) return;
      before = previous;
      frame = requestFrame(() => {
        const fittedBefore = isFitted();
        frame = 0;
        before = null;
        if (fittedBefore) refit(false);
      });
    },
    dispose: cancel,
  };
}
