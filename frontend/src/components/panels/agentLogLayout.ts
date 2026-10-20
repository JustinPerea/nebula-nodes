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
