/**
 * Which canvas camera moves are the canvas's own: its fit after an agent's
 * nodes land (Canvas) and the reveal after an arrange (ArrangeController).
 * projectStore saves those along with the change that caused them, quietly,
 * instead of reading "Unsaved changes" and restarting the 600 ms autosave
 * debounce on every frame. Everything else stays the person's: a pan, zoom
 * or scroll (it has an input event), and the programmatic moves the person
 * asks for (the toolbar's zoom, Fit view, the command palette), which have
 * no input event either, so "no event" alone can't tell them apart.
 *
 * React Flow reports each move as start, frames, end (d3-zoom's gesture),
 * and a transition that another move interrupts ends before the next one
 * starts. The canvas claims a move right before making it; the next move to
 * start with no input event takes the claim, and its frames are the
 * canvas's own until the next move starts. A move's end isn't used: React
 * Flow reports onMoveEnd on a timer (150 ms with panOnScroll), so the end
 * of a fit the next one interrupted, or of the person's scroll, can arrive
 * in the middle of the canvas's next move. Every move starts with a start,
 * so the start alone decides. A claim no move took up within CLAIM_MS
 * expires, so it can never mark a later move of the person's.
 */

const CLAIM_MS = 1000;

let claimedAt: number | null = null;
let ownMove = false;

/** Right before the canvas moves the camera itself (fitView, setViewport). */
export function claimCameraMove(): void {
  claimedAt = Date.now();
}

/** React Flow's onMoveStart. */
export function cameraMoveStarted(event: unknown): void {
  ownMove = !event && claimedAt !== null && Date.now() - claimedAt <= CLAIM_MS;
  claimedAt = null;
}

/** For one onMove frame: the canvas's own move, not the person's. */
export function cameraMoveIsCanvasOwn(event: unknown): boolean {
  return !event && ownMove;
}

export function resetCanvasCameraForTests(): void {
  claimedAt = null;
  ownMove = false;
}
