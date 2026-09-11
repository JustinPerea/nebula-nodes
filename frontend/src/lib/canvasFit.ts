export type PixelPadding = {
  top: `${number}px`;
  right: `${number}px`;
  bottom: `${number}px`;
  left: `${number}px`;
};

function px(value: number): `${number}px` {
  return `${value}px`;
}

/**
 * Reserve canvas space for every piece of floating workspace chrome that is
 * currently visible. React Flow's numeric padding uses a viewport-relative
 * formula, so explicit pixels are required to guarantee nodes clear the rail,
 * dock drawer, chat, and inspector at both desktop and compact widths.
 */
export function computeCanvasFitPadding(): PixelPadding {
  const base: PixelPadding = { top: '40px', right: '40px', bottom: '40px', left: '40px' };
  if (typeof window === 'undefined') return base;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const intrusion = { top: 0, right: 0, bottom: 0, left: 0 };
  const safety = 24;
  const chrome = [
    { selector: '.workspace-rail', side: 'left' as const },
    { selector: '.workspace-dock-panel', side: 'left' as const },
    { selector: '.chat-panel', side: 'right' as const },
    { selector: '.canvas-tabs', side: 'top' as const },
    { selector: '.toolbar', side: 'bottom' as const },
    { selector: '.node-inspector-popover', side: null },
    { selector: '.panel--inspector', side: null },
  ];

  for (const { selector, side } of chrome) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

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

  return {
    top: px(Math.max(40, intrusion.top + safety)),
    right: px(Math.max(40, intrusion.right + safety)),
    bottom: px(Math.max(40, intrusion.bottom + safety)),
    left: px(Math.max(40, intrusion.left + safety)),
  };
}
