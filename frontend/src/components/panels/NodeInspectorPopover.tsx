import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Pin, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { Inspector } from './Inspector';
import { InspectorFootContext } from './inspectorFootContext';
import { ScrollFade } from '../ScrollFade';
import { floatingBarLimit, floatingBottomLimit, floatingTopLimit } from '../../lib/bottomBar';

const POPOVER_GAP = 10;
const POPOVER_WIDTH = 260;
const POPOVER_MIN_WIDTH = 228;
/** The floating Inspector's floor: a short body keeps this height (GM r68). */
const POPOVER_MIN_HEIGHT = 300;
/**
 * How far the floating Inspector keeps clear of the floating top chrome (the
 * selection toolbar) and of the bottom bar when it grows to fit its content
 * (GM r68: "up to the space between the floating top chrome and the bottom
 * bar, with 12 px clear of each. At 1440x900 that's about 660 px."). Measured
 * live there: the toolbar ends at 142 and the bar starts at 828, so 154-816.
 */
export const POPOVER_CHROME_CLEARANCE = 12;
const PINNED_WIDTH = 300;
const PINNED_MIN_WIDTH = 260;
const PINNED_MAX_HEIGHT = 440;
const PINNED_RESIZE_MIN_WIDTH = 240;
const PINNED_RESIZE_MIN_HEIGHT = 260;
const PINNED_GAP = 12;
const VIEWPORT_GUTTER = 16;

type PopoverFrame = {
  nodeId: string;
  placement: 'left' | 'right' | 'top' | 'bottom' | 'pinned-left';
  suspended?: boolean;
  style: CSSProperties;
};

type PinnedPreference = { left: number; top: number; width: number; height: number };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getInspectorAnchor(nodeId: string) {
  const anchors = document.querySelectorAll<HTMLElement>('[data-node-inspector-anchor]');
  return Array.from(anchors).find((anchor) => anchor.dataset.nodeInspectorAnchor === nodeId) ?? null;
}

function frameEquals(a: PopoverFrame | null, b: PopoverFrame) {
  if (!a || a.nodeId !== b.nodeId || a.placement !== b.placement || a.suspended !== b.suspended) return false;
  return (
    a.style.left === b.style.left &&
    a.style.top === b.style.top &&
    a.style.width === b.style.width &&
    a.style.height === b.style.height &&
    a.style.minWidth === b.style.minWidth &&
    a.style.maxWidth === b.style.maxWidth &&
    a.style.minHeight === b.style.minHeight &&
    a.style.maxHeight === b.style.maxHeight
  );
}

/**
 * Where the floating Inspector opens beside its node: right of it, else left,
 * else under it, flipped above it when under would cross the bottom (GM -
 * Design, 2026-10-23: "When there's no room below the node, flip it up or
 * shift it, so its foot row is always whole"). Every placement then stays
 * between two measured lines (lib/bottomBar.ts): below the workspace header
 * and the selection toolbar, whichever is lower, and above the notice
 * region's reserved band over the bottom bar, so a notice never covers its
 * foot row and it never moves when a notice comes or goes (GM, round 2).
 * When the room between them is shorter than the panel, the panel gets
 * shorter and its body scrolls. Runs every frame while open, so a resize, a
 * pan, the toolbar coming or going, or the bar growing moves it at once.
 */
/**
 * The height the panel needs to show its whole body (GM r68: "It grows to fit
 * its content"), or null before it is laid out. What the panel holds besides
 * its body's viewport (the header, the foot row, the borders: the panel's
 * height less the viewport's) plus the body's padding and its content's own
 * height. The content box (`__content`, a flow root, so its sections'
 * margins stay inside it) has its own height whatever the panel's, so a body
 * that gets shorter reads shorter, and the read holds while the layout spring
 * runs the panel's height (both heights move together). Layout sizes only
 * (offsetHeight, clientHeight), never a transformed box, so the panel's enter
 * scale doesn't read as a change.
 */
function contentFitHeight(popover: HTMLElement | null): number | null {
  if (!popover || popover.offsetHeight <= 0) return null;
  const body = popover.querySelector<HTMLElement>('.node-inspector-popover__body');
  const content = body?.querySelector<HTMLElement>('.node-inspector-popover__content');
  if (!body || !content) return null;
  const style = window.getComputedStyle(body);
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  return popover.offsetHeight - body.clientHeight + padding + content.offsetHeight;
}

/** How long the layout spring may run after a content height change (its
 *  360 ms in panels.css, and a frame or two to settle). */
export const CONTENT_RESIZE_MS = 400;

/**
 * `panelNeed`: the height the panel needs to show its whole body
 * (contentFitHeight), or null when not yet known (300 px until then).
 * `heldTop`: where its top stays while its content changes height (GM r68:
 * "anchored at the top, so the file row doesn't move under the pointer"), or
 * null to place it afresh beside its node.
 */
function measurePopoverFrame(nodeId: string, anchor: HTMLElement, panelNeed: number | null = null,
  heldTop: number | null = null): PopoverFrame {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  // 12 px under the floating top chrome (the header and the selection
  // toolbar, whichever is lower; lib/bottomBar.ts).
  const topLimit = floatingTopLimit(VIEWPORT_GUTTER, POPOVER_CHROME_CLEARANCE);
  const rightSpace = viewportWidth - rect.right - POPOVER_GAP - VIEWPORT_GUTTER;
  const leftSpace = rect.left - POPOVER_GAP - VIEWPORT_GUTTER;

  // Which side, and so how wide and where across: none of it depends on height.
  let placement: PopoverFrame['placement'] = 'right';
  let width = Math.min(POPOVER_WIDTH, Math.max(POPOVER_MIN_WIDTH, rightSpace));
  let left = rect.right + POPOVER_GAP;
  if (rightSpace < POPOVER_MIN_WIDTH && leftSpace >= POPOVER_MIN_WIDTH) {
    placement = 'left';
    width = Math.min(POPOVER_WIDTH, leftSpace);
    left = rect.left - POPOVER_GAP - width;
  } else if (rightSpace < POPOVER_MIN_WIDTH) {
    const availableWidth = viewportWidth - VIEWPORT_GUTTER * 2;
    width = Math.max(240, Math.min(POPOVER_WIDTH, availableWidth));
    left = rect.left + rect.width / 2 - width / 2;
    placement = 'bottom';
  }
  left = clamp(left, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, viewportWidth - width - VIEWPORT_GUTTER));

  // 12 px above the bar across the whole width, and above the Canvas actions
  // panel only where it is over that panel (lib/bottomBar.ts). GM r68 bounds
  // the panel by the bar, not by the notice region's reserved band (its
  // "about 660 px at 1440x900" is the bar's line; the band's would be 612).
  const bottomLimit = floatingBarLimit(VIEWPORT_GUTTER, POPOVER_CHROME_CLEARANCE, viewportHeight,
    { left, right: left + width });
  // Its whole body, never under 300 px, up to the room between the lines:
  // only past that does the body scroll (as one; the foot stays).
  const own = panelNeed === null ? POPOVER_MIN_HEIGHT : Math.max(POPOVER_MIN_HEIGHT, Math.ceil(panelNeed));
  // Its content changed height while it stood still: the top stays, and only
  // the bottom edge moves, as far as the bar's line (then the body scrolls).
  // Placed afresh (opened, another node, the node moved), a node low on the
  // screen shifts it up instead.
  if (heldTop !== null && placement !== 'bottom') {
    const top = clamp(heldTop, topLimit, bottomLimit);
    const held = Math.max(0, Math.min(own, bottomLimit - top));
    if (held >= Math.min(own, POPOVER_MIN_HEIGHT)) {
      return { nodeId, placement, style: { left, top, width, height: held } };
    }
  }
  const height = Math.max(0, Math.min(own, bottomLimit - topLimit));
  // Beside the node, level with its top. Low on the screen it shifts up to
  // fit before it gets shorter (the clamp below: up to the top line first).
  let top = rect.top - 8;
  if (placement === 'bottom') {
    top = rect.bottom + POPOVER_GAP;
    if (top + height > bottomLimit) {
      const aboveTop = rect.top - POPOVER_GAP - height;
      if (aboveTop >= topLimit) {
        top = aboveTop;
        placement = 'top';
      }
    }
  }

  return {
    nodeId,
    placement,
    style: {
      left,
      top: clamp(top, topLimit, Math.max(topLimit, bottomLimit - height)),
      width,
      height,
    },
  };
}

function measurePinnedFrame(nodeId: string, preference: PinnedPreference | null): PopoverFrame {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const railRect = document.querySelector('.workspace-rail')?.getBoundingClientRect();
  const railRight = railRect && railRect.width > 0 && railRect.height > 0 ? railRect.right : 0;
  const railLeft = Math.max(VIEWPORT_GUTTER, railRight + PINNED_GAP);
  let leftBound = railLeft;

  // Every dock drawer shares this footprint. Measure it live so opening Assets,
  // History, or Settings cannot leave a pinned Inspector over navigation.
  for (const drawer of document.querySelectorAll('.workspace-dock-panel')) {
    const rect = drawer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) leftBound = Math.max(leftBound, rect.right + PINNED_GAP);
  }
  const rightBound = viewportWidth - VIEWPORT_GUTTER;
  const suspended = leftBound > railLeft && rightBound - leftBound < PINNED_MIN_WIDTH;
  // Compact drawers cover the canvas. Keep the Inspector mounted but hidden
  // until they close, preserving its fields, selection, and user's pin position.
  if (suspended) leftBound = railLeft;

  const availableWidth = Math.max(0, rightBound - leftBound);
  const minWidth = Math.min(PINNED_RESIZE_MIN_WIDTH, availableWidth);
  const maxWidth = Math.min(520, availableWidth);
  const width = clamp(preference?.width ?? PINNED_WIDTH, minWidth, maxWidth);
  const left = clamp(preference?.left ?? leftBound, leftBound, rightBound - width);
  // Between the same measured lines as the floating Inspector
  // (lib/bottomBar.ts): below the header and the selection toolbar, above
  // the notice band over the bottom bar, and above the Canvas actions panel
  // only where it is over it. In a window too short for that, the lines give
  // way (the bottom one first) so the Inspector keeps its smallest size.
  const topBound = Math.min(floatingTopLimit(VIEWPORT_GUTTER),
    Math.max(VIEWPORT_GUTTER, viewportHeight - VIEWPORT_GUTTER - PINNED_RESIZE_MIN_HEIGHT));
  const bottomBound = Math.max(
    floatingBottomLimit(VIEWPORT_GUTTER, viewportHeight, { left, right: left + width }),
    Math.min(viewportHeight - VIEWPORT_GUTTER, topBound + PINNED_RESIZE_MIN_HEIGHT),
  );
  const availableHeight = Math.max(0, bottomBound - topBound);
  const minHeight = Math.min(PINNED_RESIZE_MIN_HEIGHT, availableHeight);
  const height = clamp(preference?.height ?? PINNED_MAX_HEIGHT, minHeight, availableHeight);
  const top = clamp(preference?.top ?? bottomBound - height, topBound, bottomBound - height);

  return {
    nodeId,
    placement: 'pinned-left',
    suspended,
    style: {
      left,
      top,
      width,
      height,
      minWidth,
      maxWidth,
      minHeight,
      maxHeight: availableHeight,
    },
  };
}

export function NodeInspectorPopover() {
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const visible = useUIStore((s) => s.panels.inspector.visible);
  const pinned = useUIStore((s) => s.inspectorPinned);
  const setInspectorVisible = useUIStore((s) => s.setInspectorVisible);
  const setInspectorPinned = useUIStore((s) => s.setInspectorPinned);
  const [frame, setFrame] = useState<PopoverFrame | null>(null);
  // The foot under the scrolling body that holds the Run / Duplicate / Delete row (InspectorFoot.tsx).
  const [foot, setFoot] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef<PopoverFrame | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pinnedPreferenceRef = useRef<PinnedPreference | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);
  // GM r68: a height change from the content (an upload landing, "No
  // preview" collapsing, a section opening) runs on the layout spring, anchored
  // at the top. Only then (review 7 M2 on #208): a pan, zoom, drag or resize
  // moves the panel with its node at once.
  const [contentResizing, setContentResizing] = useState(false);
  const needRef = useRef<{ nodeId: string; need: number | null } | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // GM r22 Q5 on #208: rigid wins. A pan or drag that starts mid-spring
  // ends the spring at its end layout at once (the transition goes with the
  // attribute, so the panel jumps to where it was going), then tracks 1:1.
  const resizingRef = useRef(false);
  const anchorAtRef = useRef<string | null>(null);
  // The top held while the content changes height, until the node moves.
  const heldTopRef = useRef<{ nodeId: string; top: number } | null>(null);
  // One measuring step, also run straight after each render (below), so the
  // panel opens at its content's height in its first painted frame.
  const stepRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!pinned) pinnedPreferenceRef.current = null;
    // Closed: the next open measures afresh.
    if (!visible || !selectedNodeId) {
      frameRef.current = null;
      needRef.current = null;
      anchorAtRef.current = null;
      heldTopRef.current = null;
      stepRef.current = null;
      return;
    }

    let raf = 0;
    let stopped = false;

    const step = () => {
      if (pinned) {
        const currentFrame = frameRef.current;
        const element = popoverRef.current;
        if (currentFrame?.placement === 'pinned-left' && !currentFrame.suspended && element) {
          const width = parseFloat(element.style.width);
          const height = parseFloat(element.style.height);
          // Native CSS resize changes inline dimensions without a React event.
          if (width !== currentFrame.style.width || height !== currentFrame.style.height) {
            pinnedPreferenceRef.current = {
              left: Number(currentFrame.style.left), top: Number(currentFrame.style.top), width, height,
            };
          }
        }
        const nextFrame = measurePinnedFrame(selectedNodeId, pinnedPreferenceRef.current);
        if (!frameEquals(frameRef.current, nextFrame)) {
          frameRef.current = nextFrame;
          setFrame(nextFrame);
        }
      } else {
        const anchor = getInspectorAnchor(selectedNodeId);
        if (anchor) {
          const box = anchor.getBoundingClientRect();
          // Where the node is: its card growing (a preview landing) is not a move.
          const at = `${selectedNodeId}:${box.left}:${box.top}`;
          const moved = anchorAtRef.current !== null && at !== anchorAtRef.current;
          if (resizingRef.current && moved) {
            if (resizeTimer.current) clearTimeout(resizeTimer.current);
            resizeTimer.current = null;
            resizingRef.current = false;
            setContentResizing(false);
          }
          anchorAtRef.current = at;
          // Moved, or another node: placed afresh beside it.
          if (moved || heldTopRef.current?.nodeId !== selectedNodeId) heldTopRef.current = null;
          // The height its whole body needs (GM r68), read from the panel
          // as it is on screen; it holds while the spring runs (see
          // contentFitHeight), so the panel settles in one step and never
          // runs on past its content.
          const popover = popoverRef.current;
          const need = popover && !popover.classList.contains('node-inspector-popover--pinned')
            ? contentFitHeight(popover) : null;
          // The content got taller or shorter on the same node, which hasn't
          // moved: the top holds from here on (until the node moves), and the
          // new height springs in the same render as that height. The first
          // look at a node doesn't, nor a node that moved.
          const seen = needRef.current;
          const shown = frameRef.current;
          const contentChanged = !moved && seen?.nodeId === selectedNodeId && seen.need !== null && need !== null
            && Math.ceil(need) !== Math.ceil(seen.need) && shown?.nodeId === selectedNodeId
            && shown.placement !== 'pinned-left';
          if (contentChanged && !heldTopRef.current) {
            heldTopRef.current = { nodeId: selectedNodeId, top: Number(shown!.style.top) };
          }
          const nextFrame = measurePopoverFrame(selectedNodeId, anchor, need, heldTopRef.current?.top ?? null);
          if (contentChanged && shown!.style.height !== nextFrame.style.height) {
            if (resizeTimer.current) clearTimeout(resizeTimer.current);
            resizeTimer.current = setTimeout(() => {
              resizeTimer.current = null;
              resizingRef.current = false;
              setContentResizing(false);
            }, CONTENT_RESIZE_MS);
            resizingRef.current = true;
            setContentResizing(true);
          }
          needRef.current = { nodeId: selectedNodeId, need };
          if (!frameEquals(frameRef.current, nextFrame)) {
            frameRef.current = nextFrame;
            setFrame(nextFrame);
          }
        } else if (frameRef.current !== null) {
          frameRef.current = null;
          setFrame(null);
        }
      }
    };
    stepRef.current = step;

    const tick = () => {
      step();
      if (!stopped) {
        raf = window.requestAnimationFrame(tick);
      }
    };

    raf = window.requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (stepRef.current === step) stepRef.current = null;
      window.cancelAnimationFrame(raf);
    };
  }, [pinned, selectedNodeId, visible]);

  // After each new frame is in the page, measure once more before it is
  // painted: a panel that just opened (at 300 px, its body not yet laid out)
  // takes its content's height in the same frame. Stops once nothing changes.
  useLayoutEffect(() => {
    if (frame && !frame.suspended && frame.placement !== 'pinned-left') stepRef.current?.();
  }, [frame]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const nextFrame = frameRef.current;
      if (!nextFrame) return;
      const width = Number(nextFrame.style.width ?? PINNED_WIDTH);
      const height = Number(nextFrame.style.height ?? PINNED_MAX_HEIGHT);
      pinnedPreferenceRef.current = {
        left: dragRef.current.left + e.clientX - dragRef.current.startX,
        top: dragRef.current.top + e.clientY - dragRef.current.startY,
        width,
        height,
      };
      const updatedFrame = measurePinnedFrame(nextFrame.nodeId, pinnedPreferenceRef.current);
      frameRef.current = updatedFrame;
      setFrame(updatedFrame);
    }

    function onMouseUp() {
      dragRef.current = null;
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // A confirmed next-step picker unmounts its focused choice. Resume keyboard
  // work in the Inspector only when focus was lost; preserve an active control.
  const hasFrame = Boolean(frame);
  useLayoutEffect(() => {
    if (!visible || !selectedNodeId || !hasFrame || frame?.suspended
      || document.activeElement !== document.body) return;
    popoverRef.current?.querySelector<HTMLElement>(
      '.node-inspector-popover__body input:not(:disabled), .node-inspector-popover__body textarea:not(:disabled), .node-inspector-popover__body select:not(:disabled)',
    )?.focus();
  }, [visible, selectedNodeId, hasFrame, frame?.suspended]);

  if (!visible || !selectedNodeId || !frame) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className={`node-inspector-popover${pinned ? ' node-inspector-popover--pinned' : ''}`}
      data-placement={frame.placement}
      data-content-resizing={contentResizing && !pinned ? '' : undefined}
      hidden={Boolean(frame.suspended)}
      inert={Boolean(frame.suspended)}
      style={frame.style}
    >
      <div
        className="node-inspector-popover__header"
        onMouseDown={(e) => {
          if (!pinned || e.button !== 0) return;
          const left = Number(frame.style.left ?? 0);
          const top = Number(frame.style.top ?? 0);
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            left,
            top,
          };
        }}
      >
        <span className="panel__title">Inspector</span>
        <div className="node-inspector-popover__actions">
          <button
            type="button"
            className={`panel__header-action node-inspector-popover__pin${pinned ? ' node-inspector-popover__pin--active' : ''}`}
            onClick={() => setInspectorPinned(!pinned)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label={pinned ? 'Unpin inspector' : 'Pin inspector to canvas'}
            aria-pressed={pinned}
            title={pinned ? 'Unpin' : 'Pin to canvas'}
          >
            <Pin
              className="node-inspector-popover__pin-icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
          <button
            type="button"
            className="panel__header-action panel__close"
            onClick={() => setInspectorVisible(false)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Close inspector"
            title="Close"
          >
            <X
              className="panel__close-icon"
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
          </button>
        </div>
      </div>
      <InspectorFootContext.Provider value={foot}>
        <ScrollFade className="node-inspector-popover__body">
          <div className="node-inspector-popover__content">
            <Inspector embedded />
          </div>
        </ScrollFade>
      </InspectorFootContext.Provider>
      <div ref={setFoot} className="node-inspector-popover__foot" />
    </div>,
    document.body,
  );
}
