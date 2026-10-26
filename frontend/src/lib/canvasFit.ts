export type PixelPadding = {
  top: `${number}px`;
  right: `${number}px`;
  bottom: `${number}px`;
  left: `${number}px`;
};

/** Shared by the bottom bar's zoom buttons and the canvas zoom shortcuts. */
export const CANVAS_ZOOM_DURATION = 200;
export const CANVAS_FIT_DURATION = 300;

function px(value: number): `${number}px` {
  return `${value}px`;
}

/**
 * Reserve canvas space for every piece of floating workspace chrome that is
 * currently visible. React Flow's numeric padding uses a viewport-relative
 * formula, so explicit pixels are required to guarantee nodes clear the rail,
 * dock drawer, chat, and inspector when those controls leave canvas space.
 */
export function computeCanvasFitPadding(): PixelPadding {
  const base: PixelPadding = { top: '40px', right: '40px', bottom: '40px', left: '40px' };
  if (typeof window === 'undefined') return base;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const intrusion = { top: 0, right: 0, bottom: 0, left: 0 };
  let railIntrusion = 0;
  let dockIntrusion = 0;
  const safety = 24;
  const chrome = [
    { selector: '.workspace-rail', side: 'left' as const },
    { selector: '.workspace-dock-panel', side: 'left' as const },
    { selector: '.chat-panel', side: 'right' as const },
    { selector: '.canvas-tabs', side: 'top' as const },
    // The floating top bar (project name, Canvas / Creator Studio). It lost
    // the `.canvas-tabs` class when it became the workspace header.
    { selector: '.canvas-tabs-wrap', side: 'top' as const },
    { selector: '.toolbar', side: 'bottom' as const },
    // The app's one stack floats above the toolbar (NoticeRegion): the
    // notices, the toasts and an agent's proposal bar on top. Fit view must
    // not tuck nodes under it.
    { selector: '.notice-region__stack', side: 'bottom' as const },
    // The open Updates list and a dropped update card (top right): Show and
    // Fit view keep the nodes they frame out from under them.
    { selector: '.agent-notes-panel', side: 'right' as const },
    { selector: '.agent-note-card', side: 'right' as const },
    { selector: '.node-inspector-popover', side: null },
    { selector: '.panel--inspector', side: null },
  ];

  for (const { selector, side } of chrome) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (selector === '.workspace-rail') railIntrusion = rect.right;
    if (selector === '.workspace-dock-panel') dockIntrusion = rect.right;

    const distances = {
      left: rect.left,
      right: viewportWidth - rect.right,
      top: rect.top,
      bottom: viewportHeight - rect.bottom,
    };
    const nearest = Math.min(distances.left, distances.right, distances.top, distances.bottom);
    const resolvedSide = side
      ?? (nearest === distances.left
        ? 'left'
        : nearest === distances.right
          ? 'right'
          : nearest === distances.top
            ? 'top'
            : 'bottom');
    if (resolvedSide === 'left') intrusion.left = Math.max(intrusion.left, rect.right);
    else if (resolvedSide === 'right') intrusion.right = Math.max(intrusion.right, viewportWidth - rect.left);
    else if (resolvedSide === 'top') intrusion.top = Math.max(intrusion.top, rect.bottom);
    else intrusion.bottom = Math.max(intrusion.bottom, viewportHeight - rect.top);
  }

  const rightPadding = Math.max(40, intrusion.right + safety);
  const dockConsumesCanvas = dockIntrusion > 0
    && Math.max(40, dockIntrusion + safety) + rightPadding >= viewportWidth;
  // A compact drawer intentionally covers the canvas. Fit underneath it rather
  // than beyond the viewport, so dismissing it reveals the fitted graph.
  const leftPadding = Math.max(40, (dockConsumesCanvas ? railIntrusion : intrusion.left) + safety);

  return {
    top: px(Math.max(40, intrusion.top + safety)),
    right: px(rightPadding),
    bottom: px(Math.max(40, intrusion.bottom + safety)),
    left: px(leftPadding),
  };
}

export interface FlowBox { left: number; top: number; right: number; bottom: number }
export interface ViewportValue { x: number; y: number; zoom: number }

/**
 * The part of the canvas no floating chrome covers (computeCanvasFitPadding),
 * in flow units for this viewport. Agent edits land their arranged nodes
 * inside it (ArrangeController).
 */
export function visibleFlowBox(
  viewport: ViewportValue,
  size: { width: number; height: number },
  padding: PixelPadding = computeCanvasFitPadding(),
): FlowBox {
  const zoom = viewport.zoom || 1;
  return {
    left: (parseFloat(padding.left) - viewport.x) / zoom,
    top: (parseFloat(padding.top) - viewport.y) / zoom,
    right: (size.width - parseFloat(padding.right) - viewport.x) / zoom,
    bottom: (size.height - parseFloat(padding.bottom) - viewport.y) / zoom,
  };
}

/**
 * The viewport that shows `block` whole inside the uncovered area, moving as
 * little as it can: null when it is already in view; a pan when it fits at
 * this zoom; else zoomed out just enough (never in, never under minZoom).
 */
export function viewportRevealing(
  block: FlowBox,
  viewport: ViewportValue,
  size: { width: number; height: number },
  minZoom: number,
  padding: PixelPadding = computeCanvasFitPadding(),
): ViewportValue | null {
  const left = parseFloat(padding.left);
  const top = parseFloat(padding.top);
  const right = size.width - parseFloat(padding.right);
  const bottom = size.height - parseFloat(padding.bottom);
  const room = { width: right - left, height: bottom - top };
  if (room.width <= 0 || room.height <= 0) return null;
  const { zoom } = viewport;
  const screen = {
    left: block.left * zoom + viewport.x,
    top: block.top * zoom + viewport.y,
    right: block.right * zoom + viewport.x,
    bottom: block.bottom * zoom + viewport.y,
  };
  if (screen.left >= left && screen.top >= top && screen.right <= right && screen.bottom <= bottom) return null;
  const width = block.right - block.left;
  const height = block.bottom - block.top;
  if (width * zoom <= room.width && height * zoom <= room.height) {
    const shift = (low: number, high: number, min: number, max: number) =>
      low < min ? min - low : high > max ? max - high : 0;
    return {
      x: viewport.x + shift(screen.left, screen.right, left, right),
      y: viewport.y + shift(screen.top, screen.bottom, top, bottom),
      zoom,
    };
  }
  const fitted = Math.max(minZoom, Math.min(zoom, room.width / width, room.height / height));
  return {
    x: left + (room.width - width * fitted) / 2 - block.left * fitted,
    y: top + (room.height - height * fitted) / 2 - block.top * fitted,
    zoom: fitted,
  };
}

/** A flow-space rectangle, as React Flow's bounds helpers take it. */
export interface FlowRect { x: number; y: number; width: number; height: number }

/** The smallest rectangle around every given one, or null for none. */
export function unionRects(rects: FlowRect[]): FlowRect | null {
  const real = rects.filter((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite));
  if (real.length === 0) return null;
  const left = Math.min(...real.map((rect) => rect.x));
  const top = Math.min(...real.map((rect) => rect.y));
  const right = Math.max(...real.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...real.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
