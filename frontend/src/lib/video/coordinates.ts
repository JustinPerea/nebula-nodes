/**
 * Convert a screen-pixel delta to a composition-pixel delta.
 *
 * The Remotion <Player> renders at whatever size its CSS gives it (typically
 * 1280px max-width with 16:9 aspect ratio, but it shrinks on narrower
 * viewports). Drag deltas come in as screen pixels — we scale them into the
 * 1280x720 composition coordinate space so spatial.x/y stays consistent
 * regardless of player size.
 *
 * playerEl is the <div> that wraps the Player at its rendered size (NOT the
 * full editor view, NOT the inner Remotion compositor — the wrapper that
 * matches the rendered Player's bounding box).
 */
export function screenToComposition(
  dxScreen: number,
  dyScreen: number,
  playerEl: HTMLElement,
  compositionWidth = 1280,
  compositionHeight = 720,
): { x: number; y: number } {
  const rect = playerEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  return {
    x: (dxScreen / rect.width) * compositionWidth,
    y: (dyScreen / rect.height) * compositionHeight,
  };
}
