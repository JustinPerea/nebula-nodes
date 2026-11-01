/**
 * Whether the Board view's camera is on the whole-board fit, and the refit
 * that keeps it there when the board's column changes size (GM, #209 (a): the
 * window narrows or widens, the offline row opens or closes, anything else
 * that moves the grid).
 *
 * - Fitted is a fact about the camera, not about which events arrived or
 *   which button got it there (GM, #213 round 3): the board is fitted while
 *   the camera is on the fit of the layout it has now (its cards, in its
 *   column, less the view insets), within `sameCamera`'s tolerance, or while
 *   a spring is heading there. A fit, a refit, a pan or zoom back onto the
 *   fit, a zoom-button spring or an Update's Show that lands on it: each is a
 *   fit. React Flow doesn't report every move a person makes the same way
 *   (after one mouse-wheel notch its pan-on-scroll never calls onMoveStart
 *   again), and some moves have no person event at all (the autopan while a
 *   card is dragged to the edge, the pan to a card focused from the
 *   keyboard), so none of them is relied on.
 * - A board that opens fitted (a fresh open, or a camera kept from earlier in
 *   the visit that was fitted then) is fit at once as soon as it has both a
 *   size that isn't 0 x 0 and cards to fit (`ready`): a board laid out late
 *   (mounted while hidden), or whose cards arrive after it mounts, still
 *   opens fitted to its column. A move the person makes first cancels it.
 * - After that, a column resize refits at most once a frame. The frame asks
 *   whether the camera was on the fit of the column before the resize (or a
 *   spring was heading to the fit), and if so springs to the new column's.
 * - A refit changes the camera, never the column, so it can't call itself.
 */
export interface FitCamera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * GM, #213 round 3: "about 0.5 px and 0.001 zoom, so rounding doesn't break
 * it". Half a screen pixel in x and y is less than anyone can see (one
 * mouse-wheel notch pans about 50 px) and absorbs floating-point rounding on
 * the way through d3; the zoom within 0.001 of the fit's (a zoom-button step
 * is 1.2x, far beyond it).
 */
export const FIT_TOLERANCE_PX = 0.5;
export const FIT_TOLERANCE_ZOOM = 0.001;

export function sameCamera(a: FitCamera, b: FitCamera): boolean {
  return Math.abs(a.x - b.x) <= FIT_TOLERANCE_PX && Math.abs(a.y - b.y) <= FIT_TOLERANCE_PX
    && Math.abs(a.zoom - b.zoom) <= FIT_TOLERANCE_ZOOM;
}

export interface BoardFitFollow {
  /** The camera is on the fit of the layout the board has now, or a spring is heading there. */
  readonly fitted: boolean;
  /** `camera` is on the fit of the layout the board has now: a move landing there leaves the board fitted. */
  onFit(camera: FitCamera): boolean;
  /** A spring heading to the fit has started (Fit, a refit, a zoom or Show that lands on it): fitted until it lands or is stopped. */
  headingToFit(): void;
  /** The spring has landed: no spring is heading anywhere now. */
  springEnded(): void;
  /** A camera move this view didn't make: no spring heads anywhere, and no fit on open is still to come. */
  taken(): void;
  /** The board may have cards to fit now: make the fit on open if it is still to come. */
  ready(): void;
  /** React Flow made its camera again, at its default: fit at once again, as on open. */
  reopen(): void;
  /**
   * The camera's own move somewhere other than the fit (the zoom buttons, an
   * Update's Show of some cards): no spring heads to the fit now, and a refit
   * still waiting doesn't run.
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
  const isFitted = () => heading || onFitAt(camera(), before ?? size);
  const cancel = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
    before = null;
  };
  const open = () => {
    if (openFit && size && refit(true)) openFit = false;
  };
  return {
    get fitted() { return isFitted(); },
    onFit: (at) => onFitAt(at, size),
    headingToFit() { heading = true; },
    springEnded() { heading = false; },
    taken() {
      heading = false;
      openFit = false;
    },
    ready: open,
    reopen() {
      openFit = true;
      heading = false;
      cancel();
      open();
    },
    aside() {
      heading = false;
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
