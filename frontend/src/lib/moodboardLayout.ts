/**
 * The board canvas's sizes, as the backend has them
 * (backend/services/moodboard_layout.py). The server writes every card's
 * `w` and `h`; the Studio only needs these to draw a card it hasn't heard
 * back about yet (an image dropped a moment ago).
 */

/** A full-weight card's area: 480 x 270 (plan Q1). */
export const FULL_AREA = 129_600;
/** The smallest card (plan Q3). */
export const MIN_WEIGHT = 0.05;
/** The aspect a card takes when the image's own is unknown. */
export const DEFAULT_ASPECT = 4 / 3;

export function clampWeight(weight: number): number {
  return Math.min(1, Math.max(MIN_WEIGHT, Number.isFinite(weight) ? weight : MIN_WEIGHT));
}

/** Python's round(): halves go to the even neighbour, as the server rounds. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The card size for `weight` (clamped to MIN_WEIGHT..1) at `aspect` (width / height). */
export function sizeFor(weight: number, aspect: number): [number, number] {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  const area = clampWeight(weight) * FULL_AREA;
  return [Math.max(1, roundHalfEven(Math.sqrt(area * ratio))), Math.max(1, roundHalfEven(Math.sqrt(area / ratio)))];
}
