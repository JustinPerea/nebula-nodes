/**
 * Whether the Board view's camera is still where the last whole-board fit
 * left it, and the refit that keeps it there when the board's column changes
 * size (GM, #209 (a): the window narrows or widens, the offline row opens or
 * closes, anything else that moves the grid).
 *
 * - A whole-board fit (fit on open, the Fit button, Shift+1, a refit) makes
 *   the board fitted. Anything else that moves the camera ends that: a
 *   person's pan, zoom, wheel, pinch or drag of the canvas (React Flow gives
 *   those a source event; the camera's own springs and fits have none), the
 *   zoom buttons, and an Update's Show, which frames only its cards.
 * - A column resize refits only while fitted, at most once a frame, with the
 *   size read when the frame runs. The first size the board is measured at
 *   only records it: fit on open (React Flow's fitView) already used it.
 * - A refit changes the camera, never the column, so it can't call itself.
 */
export interface BoardFitFollow {
  readonly fitted: boolean;
  /** A whole-board fit was made (or is springing). */
  markFitted(): void;
  /** The camera moved for any other reason: the board is no longer fitted. */
  leave(): void;
  /** React Flow's move start: a person's own when `event` is set. */
  moveStart(event: unknown): void;
  /** The board column measured at this size. */
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface BoardFitFollowOptions {
  /** Fitted to begin with: a fresh open (fit on open), or a camera kept from earlier in the visit that was fitted then. */
  fitted: boolean;
  refit: () => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export function createBoardFitFollow({ fitted, refit, requestFrame = (cb) => window.requestAnimationFrame(cb),
  cancelFrame = (id) => window.cancelAnimationFrame(id) }: BoardFitFollowOptions): BoardFitFollow {
  let isFitted = fitted;
  let size: { width: number; height: number } | null = null;
  let frame = 0;
  const cancel = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
  };
  return {
    get fitted() { return isFitted; },
    markFitted() { isFitted = true; },
    leave() {
      isFitted = false;
      cancel();
    },
    moveStart(event) {
      if (event) this.leave();
    },
    resize(width, height) {
      if (!width || !height) return;
      const first = size === null;
      if (!first && size!.width === width && size!.height === height) return;
      size = { width, height };
      if (first || !isFitted || frame) return;
      frame = requestFrame(() => {
        frame = 0;
        if (isFitted) refit();
      });
    },
    dispose: cancel,
  };
}
