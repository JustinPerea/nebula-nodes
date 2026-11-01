/**
 * Whether the Board view's camera is still where the last whole-board fit
 * left it, and the refit that keeps it there when the board's column changes
 * size (GM, #209 (a): the window narrows or widens, the offline row opens or
 * closes, anything else that moves the grid).
 *
 * - Fitted is a fact about the camera, not about which events arrived: the
 *   board is fitted while the camera is on the last fit's target (within
 *   `sameCamera`'s tolerance), or while a fit spring is still heading there.
 *   React Flow doesn't report every move a person makes the same way (after
 *   one mouse-wheel notch its pan-on-scroll never calls onMoveStart again),
 *   and some moves have no person event at all (the autopan while a card is
 *   dragged to the edge, the pan to a card focused from the keyboard), so
 *   none of them is relied on: whatever moved the camera off the fit, the
 *   board is no longer fitted. A camera moved back onto the fit is fitted.
 * - A whole-board fit (fit on open, the Fit button, Shift+1, a refit) sets
 *   the target. The camera's own moves elsewhere (the zoom buttons, an
 *   Update's Show, which frames only its cards) leave it unfitted unless they
 *   land back on that target: zooming in and back out is fitted again, as a
 *   pan back onto the fit is.
 * - A board that opens fitted (a fresh open, or a camera kept from earlier in
 *   the visit that was fitted then) is fit at once as soon as it has both a
 *   size that isn't 0 x 0 and cards to fit (`ready`): a board laid out late
 *   (mounted while hidden), or whose cards arrive after it mounts, still
 *   opens fitted to its column. A move the person makes first cancels it.
 * - After that, a column resize refits at most once a frame, with the size
 *   read and the camera compared when the frame runs.
 * - A refit changes the camera, never the column, so it can't call itself.
 */
export interface FitCamera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Half a screen pixel, in x and y: less than that isn't a move anyone can see
 * (one mouse-wheel notch pans about 50 px), and it absorbs floating-point
 * rounding on the way through d3. The zoom is compared relative to the fit's
 * zoom: 5e-4 moves the far edge of an 870 px column by under half a pixel.
 */
export const FIT_TOLERANCE_PX = 0.5;
export const FIT_TOLERANCE_ZOOM = 5e-4;

export function sameCamera(a: FitCamera, b: FitCamera): boolean {
  return Math.abs(a.x - b.x) <= FIT_TOLERANCE_PX && Math.abs(a.y - b.y) <= FIT_TOLERANCE_PX
    && Math.abs(a.zoom - b.zoom) <= FIT_TOLERANCE_ZOOM * b.zoom;
}

export interface BoardFitFollow {
  /** The camera is on the last fit's target, or a fit spring is heading there. */
  readonly fitted: boolean;
  /** `camera` is on the last fit's target: a move landing there leaves the board fitted. */
  onFit(camera: FitCamera): boolean;
  /** A whole-board fit to `target`: on a spring still heading there, or already there. */
  fitTo(target: FitCamera, springing: boolean): void;
  /** The fit spring has landed: no spring is heading anywhere now. */
  springEnded(): void;
  /** A camera move this view didn't make: no spring heads anywhere, and no fit on open is still to come. */
  taken(): void;
  /** The board may have cards to fit now: make the fit on open if it is still to come. */
  ready(): void;
  /** React Flow made its camera again, at its default: fit at once again, as on open. */
  reopen(): void;
  /**
   * The camera's own move somewhere other than a whole-board fit (the zoom
   * buttons, an Update's Show): no fit spring heads anywhere now, and a refit
   * still waiting doesn't run. The last fit's target stays, so landing back
   * on it by any route counts as fitted again (GM, #209 review 4: zoom in,
   * then back out).
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
  /** Fit the whole board to the column: at once on open, on the spring after that. False when there was nothing to fit. */
  refit: (instant: boolean) => boolean;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export function createBoardFitFollow({ fitted, camera, refit, requestFrame = (cb) => window.requestAnimationFrame(cb),
  cancelFrame = (id) => window.cancelAnimationFrame(id) }: BoardFitFollowOptions): BoardFitFollow {
  let openFit = fitted;
  let target: FitCamera | null = null;
  let heading = false;
  let size: { width: number; height: number } | null = null;
  let frame = 0;
  const isFitted = () => target !== null && (heading || sameCamera(camera(), target));
  const cancel = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
  };
  const open = () => {
    if (openFit && size && refit(true)) openFit = false;
  };
  return {
    get fitted() { return isFitted(); },
    onFit: (at) => target !== null && sameCamera(at, target),
    fitTo(next, springing) {
      target = { x: next.x, y: next.y, zoom: next.zoom };
      heading = springing;
    },
    springEnded() { heading = false; },
    taken() {
      heading = false;
      openFit = false;
    },
    ready: open,
    reopen() {
      openFit = true;
      target = null;
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
      const same = size !== null && size.width === width && size.height === height;
      const first = size === null;
      size = { width, height };
      if (openFit) {
        open();
        return;
      }
      if (first || same || frame) return;
      frame = requestFrame(() => {
        frame = 0;
        if (isFitted()) refit(false);
      });
    },
    dispose: cancel,
  };
}
