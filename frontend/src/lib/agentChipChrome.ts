import { intersect, area, type Box } from './agentAnchorResolve';
import type { Obstacle } from './agentEdgeChips';

/**
 * What the edge chips read of the page (PR #233 slice 9): the visible pane
 * (the canvas less the open docks, as the board's view insets measure the
 * Board view's column) and the floating panels a cursor can be under (the
 * Inspector, the Agent log, Updates). Reads rects by the panels' own class
 * names (the ones lib/noticeSides.ts and lib/canvasFit.ts already read), so
 * no panel needs a new attribute and the entry stays as it is. In the cursor
 * chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */

/** The side drawers: they take their width from the pane. */
export const DOCK_SELECTOR = '.workspace-dock-panel, .chat-panel';

/** The floating panels: a cursor under one is off screen. */
export const CHROME_SELECTORS: readonly { id: string; selector: string }[] = [
  { id: 'inspector', selector: '.node-inspector-popover, .panel--inspector' },
  { id: 'agent-log', selector: '.agent-log' },
  { id: 'updates', selector: '.agent-notes-panel, .agent-note-card' },
];

const boxOf = (element: Element): Box | null => {
  if (element.classList.contains('panel--exiting')) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
};

/** The pane's box less the side drawers that stand over it: a drawer in its left half takes the left, else the right. */
export function visiblePane(pane: Box, docks: readonly Box[]): Box {
  let left = pane.left;
  let right = pane.left + pane.width;
  const middle = pane.left + pane.width / 2;
  for (const dock of docks) {
    if (area(intersect(pane, dock)) === 0) continue;
    if (dock.left + dock.width / 2 < middle) left = Math.max(left, dock.left + dock.width);
    else right = Math.min(right, dock.left);
  }
  return { left, top: pane.top, width: Math.max(0, right - left), height: pane.height };
}

export interface ChipView { view: Box; obstacles: Obstacle[] }

/** The visible pane and the floating panels now, in client px. */
export function readChipView(pane: Box, root: ParentNode = document): ChipView {
  const docks = [...root.querySelectorAll(DOCK_SELECTOR)].flatMap((element) => boxOf(element) ?? []);
  const obstacles: Obstacle[] = [];
  for (const { id, selector } of CHROME_SELECTORS) {
    [...root.querySelectorAll(selector)].forEach((element, index) => {
      const box = boxOf(element);
      if (box) obstacles.push({ id: `${id}${index}`, box });
    });
  }
  return { view: visiblePane(pane, docks), obstacles };
}
