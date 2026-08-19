const RUN_HISTORY_WIDTH = 276;
const PANEL_MARGIN = 8;
const MIN_HEADER_VISIBLE = 56;

export function clampRunHistoryPosition(
  position: { x: number; y: number },
  viewport = {
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 720,
  },
): { x: number; y: number } {
  const renderedWidth = Math.min(
    RUN_HISTORY_WIDTH,
    Math.max(0, viewport.width - PANEL_MARGIN * 2),
  );
  const maxX = Math.max(PANEL_MARGIN, viewport.width - renderedWidth - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, viewport.height - MIN_HEADER_VISIBLE);
  return {
    x: Math.min(maxX, Math.max(PANEL_MARGIN, position.x)),
    y: Math.min(maxY, Math.max(PANEL_MARGIN, position.y)),
  };
}
