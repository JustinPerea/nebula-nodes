// Where the Agent log sits: its saved drag position, kept on screen and clear
// of the chat launcher. Pure helpers, shared by AgentLog.tsx and its tests.

export interface Position {
  left: number;
  top: number;
  anchorX?: 'left' | 'right';
  anchorY?: 'top' | 'bottom';
  offsetX?: number;
  offsetY?: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How long "Agent log hidden · Show again" stays up after the hide control. */
export const AGENT_LOG_HIDDEN_NOTICE_MS = 6000;
/** Gap kept between a dragged log and the chat launcher (--stack-gap-sm). */
export const LAUNCHER_GAP = 8;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function positionFromGeometry(
  left: number,
  top: number,
  width: number,
  height: number,
  preferredAnchorX?: Position['anchorX'],
  preferredAnchorY?: Position['anchorY'],
): Position {
  const right = window.innerWidth - left - width;
  const bottom = window.innerHeight - top - height;
  const anchorX = preferredAnchorX ?? (left <= right ? 'left' : 'right');
  const anchorY = preferredAnchorY ?? (top <= bottom ? 'top' : 'bottom');

  return {
    left,
    top,
    anchorX,
    anchorY,
    offsetX: anchorX === 'left' ? left : right,
    offsetY: anchorY === 'top' ? top : bottom,
  };
}

export function resolvePositionForViewport(position: Position, width: number, height: number): Position {
  const anchorX = position.anchorX ?? (position.left <= window.innerWidth - position.left - width ? 'left' : 'right');
  const anchorY = position.anchorY ?? (position.top <= window.innerHeight - position.top - height ? 'top' : 'bottom');
  const offsetX = position.offsetX ?? (anchorX === 'left' ? position.left : window.innerWidth - position.left - width);
  const offsetY = position.offsetY ?? (anchorY === 'top' ? position.top : window.innerHeight - position.top - height);
  const rawLeft = anchorX === 'left' ? offsetX : window.innerWidth - width - offsetX;
  const rawTop = anchorY === 'top' ? offsetY : window.innerHeight - height - offsetY;
  const left = clamp(rawLeft, 0, Math.max(0, window.innerWidth - width));
  const top = clamp(rawTop, 0, Math.max(0, window.innerHeight - height));

  return positionFromGeometry(left, top, width, height, anchorX, anchorY);
}

/**
 * A log at `position` that would cover `obstacle` (the chat launcher) is
 * lifted to sit `gap` px above it, keeping its left edge and anchors. Any
 * other position, or no obstacle, comes back unchanged (same object).
 */
export function keepClearOfRect(
  position: Position,
  width: number,
  height: number,
  obstacle: Rect | null,
  gap = LAUNCHER_GAP,
): Position {
  if (!obstacle) return position;
  const overlaps = position.left < obstacle.right + gap
    && position.left + width > obstacle.left - gap
    && position.top < obstacle.bottom + gap
    && position.top + height > obstacle.top - gap;
  if (!overlaps) return position;
  const top = Math.max(0, obstacle.top - gap - height);
  return positionFromGeometry(position.left, top, width, height, position.anchorX, position.anchorY);
}

export interface EdgeStyle {
  left: number | 'auto';
  right: number | 'auto';
  top: number | 'auto';
  bottom: number | 'auto';
}

/**
 * Fixed-position edges for a stored position, pinned to the edges it is
 * anchored to. A log anchored to the bottom keeps its bottom edge, so
 * expanding it grows the list upward rather than past the window's foot
 * (and under the chat launcher). The "hidden" notice uses the same edges, so
 * it shows where the dragged log was.
 */
export function edgeStyle(position: Position): EdgeStyle {
  const x = position.anchorX === 'right' && typeof position.offsetX === 'number'
    ? { left: 'auto' as const, right: position.offsetX }
    : { left: position.left, right: 'auto' as const };
  const y = position.anchorY === 'bottom' && typeof position.offsetY === 'number'
    ? { top: 'auto' as const, bottom: position.offsetY }
    : { top: position.top, bottom: 'auto' as const };
  return { ...x, ...y };
}

export function samePosition(a: Position, b: Position) {
  return a.left === b.left
    && a.top === b.top
    && a.anchorX === b.anchorX
    && a.anchorY === b.anchorY
    && a.offsetX === b.offsetX
    && a.offsetY === b.offsetY;
}

// -- the person's height (GM - Design r61 answer 1) ---------------------------

/** Where the person's height is kept, as the log's drag position is. */
export const HEIGHT_STORAGE_KEY = 'nebula:agentLog:h';
/** One arrow key moves the resize handle this far (GM r70: 24 px). */
export const RESIZE_KEY_STEP = 24;
/** The handle's name (GM r70) and tooltip (r70 approved its first two
 * sentences; the keys follow, as house tooltips list them: "Arrow keys
 * change shots; Alt + arrow keys reorder."). */
export const RESIZE_HANDLE_LABEL = 'Resize the Agent log';
export const RESIZE_HANDLE_TITLE = 'Drag to resize. Double-click to fit the content. Arrow keys resize; Enter fits the content.';

export interface HeightBounds {
  /** The header, one row and the composer. */
  min: number;
  /** The viewport, less the top chrome. */
  max: number;
}

/** The edge the handle sits on: the one away from the edge the log is
 * pinned by (docked, or dragged and pinned by its bottom: the top edge). */
export function resizeEdge(position: Position | null): 'top' | 'bottom' {
  return !position || position.anchorY === 'bottom' ? 'top' : 'bottom';
}

/** A drag of the handle from `startY` to `y`, from a log `start` px tall. */
export function resizedHeight(start: number, startY: number, y: number, edge: 'top' | 'bottom'): number {
  return edge === 'top' ? start + (startY - y) : start + (y - startY);
}

/** The person's height within its bounds; a window too short for the min gives the min. */
export function clampLogHeight(height: number, bounds: HeightBounds): number {
  return Math.round(Math.max(bounds.min, Math.min(height, Math.max(bounds.min, bounds.max))));
}

/** A saved height, or null for none (the log follows its content). */
export function readStoredHeight(raw: string | null): number | null {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}
