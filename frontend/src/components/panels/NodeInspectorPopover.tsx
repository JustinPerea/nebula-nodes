import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Pin, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { Inspector } from './Inspector';
import { InspectorFootContext } from './inspectorFootContext';
import { ScrollFade } from '../ScrollFade';
import { hasMoreBelow } from '../../lib/scrollMore';
import { FLOATING_CHROME_CLEARANCE, floatingBottomLimit, floatingChromeTopLine, floatingTopLimit } from '../../lib/bottomBar';
import { springCssVars } from '../../lib/springs';
import { CARD_WIDTH_SPRING_ATTR } from '../../lib/cardWidthSpring';

const POPOVER_GAP = 10;
const POPOVER_WIDTH = 260;
const POPOVER_MIN_WIDTH = 228;
/** The floating Inspector's floor: a short body keeps this height (GM r68). */
const POPOVER_MIN_HEIGHT = 300;
const PINNED_WIDTH = 300;
const PINNED_MIN_WIDTH = 260;
const PINNED_MAX_HEIGHT = 440;
const PINNED_RESIZE_MIN_WIDTH = 240;
const PINNED_RESIZE_MIN_HEIGHT = 260;
const PINNED_GAP = 12;
const VIEWPORT_GUTTER = 16;

/** The springs the foot row's "more below" hairline comes and goes on (GM r87). */
const FOOT_SPRINGS = springCssVars() as CSSProperties;

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

/**
 * Where the node is (GM r92): the React Flow node's own box and the canvas's
 * transform, never its card's box. A card's top shifts inside a node that
 * hasn't moved when its preview lands (an Image Input's padding grows), which
 * is growth, not a move. A node with no React Flow box (none in some tests)
 * reads its card.
 */
function nodePlace(nodeId: string, anchor: HTMLElement, card: DOMRect) {
  const node = anchor.closest<HTMLElement>('.react-flow__node') ?? anchor;
  const box = node === anchor ? card : node.getBoundingClientRect();
  const canvas = anchor.closest<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
  return {
    at: `${nodeId}:${box.left}:${box.top}:${canvas}`,
    // The card inside it: its size and its offset from the node's corner.
    card: `${nodeId}:${card.width}:${card.height}:${card.left - box.left}:${card.top - box.top}`,
  };
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
 * How long an open may last at most (GM r82): from the panel's mount, its
 * content settling (an image decoding, the first late layout) counts as
 * placing it, until every image in it is complete and its height has held
 * for OPEN_STABLE_FRAMES frames, or this long, whichever comes first. After
 * that, a change in its content holds its top (GM r72).
 */
export const OPEN_SETTLE_CAP_MS = 300;
export const OPEN_STABLE_FRAMES = 2;

/**
 * Where the floating Inspector stands beside its node: right of it, else left,
 * else under it, flipped above it when under would cross the bottom line (GM -
 * Design, 2026-10-23: "When there's no room below the node, flip it up or
 * shift it, so its foot row is always whole"). Every placement stays between
 * two measured lines (lib/bottomBar.ts): 12 px under the floating top chrome
 * and 12 px over the notice region's reserved band (GM r68, r72). Runs every
 * frame while open, so a pan, a zoom or the toolbar coming or going moves it
 * at once.
 *
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
  // toolbar, whichever is lower): lib/bottomBar.ts floatingChromeTopLine, the
  // only source for that line.
  const topLimit = floatingChromeTopLine(VIEWPORT_GUTTER);
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

  // 12 px above the notice region's reserved band, which stands on the bar
  // across the whole width, and above the Canvas actions panel only where it
  // is over that panel (lib/bottomBar.ts). GM r72: "Cap to the BAND line, not
  // the bar: the reserved notice band wins; a notice covering
  // Run/Duplicate/Delete is the overlap r57 rules out" (154-754 at 1440x900,
  // 600 px measured live; r68's bar line gave 662).
  const bottomLimit = floatingBottomLimit(VIEWPORT_GUTTER, viewportHeight, { left, right: left + width },
    FLOATING_CHROME_CLEARANCE);
  // Its whole body, never under 300 px, up to the room between the lines:
  // only past that does the body scroll (as one; the foot stays).
  const own = panelNeed === null ? POPOVER_MIN_HEIGHT : Math.max(POPOVER_MIN_HEIGHT, Math.ceil(panelNeed));
  // Its content changed height while it stood still: the top stays, and only
  // the bottom edge moves, as far as the band's line (then the body scrolls).
  // Placed afresh (opened, its content settling while it opens, another
  // node, the node moved, the window resized), a node low on the screen
  // shifts it up instead.
  //
  // The order (GM r68's "anchored at the top, so the file row doesn't move
  // under the pointer", confirmed in r72): "don't move what's under the
  // pointer" comes before the fit. Shift-up happens only on placement (the
  // open, until its content is stable, GM r82; another node; the node moving;
  // a window resize, r82); after a content change the top holds and the
  // extra scrolls, even on a low node that a fresh placement would shift.
  // Under or over its node (no room beside it) it follows the node, so it
  // never holds a top.
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
  // Closed: its frame goes with it, so a reopen never paints the last open's
  // frame first (review 2 LOW-2: it showed for a frame, and for good when
  // the node had no card on screen, past every line). Set while rendering,
  // so the closed render is the one React commits.
  if ((!visible || !selectedNodeId) && frame !== null) setFrame(null);
  // The node whose open has settled (GM r92 Q3): until then the popover
  // carries data-opening and the foot's "more below" hairline waits, so a
  // body that overflows only while its content settles never shows it.
  // Reset as it closes or another node opens (set while rendering, as above).
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  // The foot's "more below" hairline (GM r87), decided here and drawn by
  // data-more-below on the foot (styles/slava-restraint.css). Off through the
  // open (GM r92 Q3). GM r98: while a height spring runs it holds the state
  // it had when the spring started (on stays on, off stays off; the body's
  // overflow mid-spring is the spring's lag, not the content), and when the
  // spring rests it is read again and springs to the new state.
  const [line, setLine] = useState(false);
  // What the line shows now (null: not yet decided for this open), and the
  // state latched at a spring's start, released when it rests.
  const lineRef = useRef<boolean | null>(null);
  const lineHeldRef = useRef<boolean | null>(null);
  const openNow = visible ? selectedNodeId : null;
  if (openNow !== openFor) {
    setOpenFor(openNow);
    setSettledFor(null);
    setLine(false);
  }
  // The foot under the scrolling body that holds the Run / Duplicate / Delete row (InspectorFoot.tsx).
  const [foot, setFoot] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef<PopoverFrame | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pinnedPreferenceRef = useRef<PinnedPreference | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);
  // GM r68: a height change from the content (an upload landing, "No
  // preview" collapsing, a section opening) runs on the layout spring, anchored
  // at the top. So do the open's own settling (GM r82), the held top let go by
  // a window resize (r82) and its card growing while it stands under or over
  // the node (r82, NIT-2). Only then (review 7 M2 on #208): a pan, zoom or
  // drag moves the panel with its node at once.
  const [contentResizing, setContentResizing] = useState(false);
  // GM r107: while the card's own width springs (lib/cardWidthSpring.ts), the
  // panel's edge follows the card's edge as it is on screen, in the same
  // frame, so the gap between them holds every frame. Its left then rides
  // no spring of its own (panels.css).
  const [followsCard, setFollowsCard] = useState(false);
  const followsCardRef = useRef(false);
  const needRef = useRef<{ nodeId: string; need: number | null } | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // GM r22 Q5 on #208: rigid wins. A pan or drag that starts mid-spring
  // ends the spring at its end layout at once (the transition goes with the
  // attribute, so the panel jumps to where it was going), then tracks 1:1.
  const resizingRef = useRef(false);
  const anchorAtRef = useRef<string | null>(null);
  // The node card's size and its offset in the node, so its growing (a
  // preview landing, its top shifting inside the node) is told from a move.
  const anchorSizeRef = useRef<string | null>(null);
  // The window's size, so a resize is told from a content change.
  const viewportRef = useRef<string | null>(null);
  // The top held while the content changes height, until the node moves, another
  // node opens or the window resizes.
  const heldTopRef = useRef<{ nodeId: string; top: number } | null>(null);
  // The open (GM r82): until its content is stable (every image complete,
  // then OPEN_STABLE_FRAMES frames at one height) or OPEN_SETTLE_CAP_MS from
  // the mount, a settle is placement: it may shift the panel up, on the spring.
  const openRef = useRef<{ nodeId: string; settled: boolean; stable: number; last: number | null } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One measuring step, also run straight after each render (below), so the
  // panel opens at its content's height in its first painted frame. `tick` is
  // true for the once-a-frame step (the open counts its stable frames there).
  const stepRef = useRef<((tick?: boolean) => void) | null>(null);
  useEffect(() => () => {
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!pinned) pinnedPreferenceRef.current = null;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    // Every open decides its line afresh, with no spring held over.
    lineRef.current = null;
    lineHeldRef.current = null;
    // Closed: the next open measures afresh (the frame state is cleared
    // as it closes, above).
    if (!visible || !selectedNodeId) {
      frameRef.current = null;
      needRef.current = null;
      anchorAtRef.current = null;
      anchorSizeRef.current = null;
      viewportRef.current = null;
      heldTopRef.current = null;
      openRef.current = null;
      stepRef.current = null;
      return;
    }

    // A new open (or another node): it settles as placement for a while.
    const open = { nodeId: selectedNodeId, settled: false, stable: 0, last: null };
    openRef.current = open;

    // The hairline (GM r92 Q3, r98): off until the open has settled; then the
    // state held by a running spring, else whether the body has more below.
    const updateLine = () => {
      const body = popoverRef.current?.querySelector<HTMLElement>('.node-inspector-popover__body');
      const next = open.settled && openRef.current === open
        && (lineHeldRef.current ?? (body ? hasMoreBelow(body) : false));
      if (next !== lineRef.current) {
        lineRef.current = next;
        setLine(next);
      }
    };
    // The spring has rested (or a move ended it): let go of the held state
    // and read the body again.
    const releaseLine = () => {
      lineHeldRef.current = null;
      updateLine();
    };

    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      open.settled = true;
      setSettledFor(open.nodeId);
      updateLine();
    }, OPEN_SETTLE_CAP_MS);

    let raf = 0;
    let stopped = false;

    const startSpring = () => {
      // Reduced motion: the panel jumps (panels.css), so no spring runs and
      // nothing waits for one; the line reads the body at once (review 4
      // NIT-1). A spring already running is ended with it.
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        if (resizeTimer.current) clearTimeout(resizeTimer.current);
        resizeTimer.current = null;
        if (resizingRef.current) {
          resizingRef.current = false;
          setContentResizing(false);
        }
        lineHeldRef.current = null;
        return;
      }
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        resizeTimer.current = null;
        resizingRef.current = false;
        setContentResizing(false);
        releaseLine();
      }, CONTENT_RESIZE_MS);
      // GM r98: the line keeps what it shows as this spring starts. A
      // spring restarted mid-run shows the held state, so it keeps it too.
      lineHeldRef.current = lineRef.current ?? false;
      resizingRef.current = true;
      setContentResizing(true);
    };

    // The open ends once every image in it is complete and its height has
    // then held for OPEN_STABLE_FRAMES frames (or at the cap, above). Any
    // step may restart the count; only a frame adds to it.
    const advanceOpen = (popover: HTMLElement | null, need: number | null, tick: boolean) => {
      const current = openRef.current;
      if (!current || current.nodeId !== selectedNodeId || current.settled) return;
      const imagesDone = Boolean(popover)
        && Array.from(popover!.querySelectorAll('img')).every((image) => image.complete);
      const height = need === null ? null : Math.ceil(need);
      if (!imagesDone || height === null || height !== current.last) {
        current.stable = 0;
        current.last = height;
      } else if (tick) {
        current.stable += 1;
      }
      if (current.stable >= OPEN_STABLE_FRAMES) {
        current.settled = true;
        setSettledFor(current.nodeId);
      }
    };

    const step = (tick = false) => {
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
        // Its open settles the same way (GM r92 Q2, Q3: the same hairline,
        // after the same settle), on its content's own height.
        const popover = popoverRef.current;
        advanceOpen(popover, popover?.querySelector<HTMLElement>('.node-inspector-popover__content')?.offsetHeight ?? null,
          tick);
      } else {
        const anchor = getInspectorAnchor(selectedNodeId);
        if (anchor) {
          // Where the node is, from its own box and the canvas's transform
          // (GM r92): its card growing or its top shifting inside it (a
          // preview landing) is not a move.
          const { at, card: size } = nodePlace(selectedNodeId, anchor, anchor.getBoundingClientRect());
          const following = anchor.hasAttribute(CARD_WIDTH_SPRING_ATTR);
          const moved = anchorAtRef.current !== null && at !== anchorAtRef.current;
          const grew = !moved && anchorSizeRef.current !== null && size !== anchorSizeRef.current;
          const viewport = `${window.innerWidth}x${window.innerHeight}`;
          const resized = viewportRef.current !== null && viewport !== viewportRef.current;
          if (resizingRef.current && moved) {
            if (resizeTimer.current) clearTimeout(resizeTimer.current);
            resizeTimer.current = null;
            resizingRef.current = false;
            setContentResizing(false);
            lineHeldRef.current = null;
          }
          anchorAtRef.current = at;
          anchorSizeRef.current = size;
          viewportRef.current = viewport;
          const wasHeld = heldTopRef.current?.nodeId === selectedNodeId;
          // Placed afresh beside it: moved, another node, or the window
          // resized (GM r82: "a window resize re-places and drops the held
          // top").
          if (moved || resized || !wasHeld) heldTopRef.current = null;
          // Still opening (GM r82): its content settling is placement.
          const opening = openRef.current?.nodeId === selectedNodeId && !openRef.current.settled;
          // The height its whole body needs (GM r68), read from the panel
          // as it is on screen; it holds while the spring runs (see
          // contentFitHeight), so the panel settles in one step and never
          // runs on past its content.
          const popover = popoverRef.current;
          const need = popover && !popover.classList.contains('node-inspector-popover--pinned')
            ? contentFitHeight(popover) : null;
          // The content got taller or shorter on the same node, which hasn't
          // moved: the new height springs in the same render as that height.
          // Once the open has settled, the top holds from here on (until the
          // node moves, another node opens or the window resizes); while it
          // opens, it is placed afresh. The first look at a node doesn't
          // spring, nor a node that moved.
          const seen = needRef.current;
          const shown = frameRef.current;
          const contentChanged = !moved && seen?.nodeId === selectedNodeId && seen.need !== null && need !== null
            && Math.ceil(need) !== Math.ceil(seen.need) && shown?.nodeId === selectedNodeId
            && shown.placement !== 'pinned-left';
          // So does the card growing in a node that hasn't moved, beside it
          // (GM r92: a preview landing shifts the card's top inside the
          // node), so the panel doesn't follow the card's top. Under or over
          // the node it follows the card (r82).
          const besideGrew = grew && shown?.nodeId === selectedNodeId
            && (shown.placement === 'left' || shown.placement === 'right');
          if ((contentChanged || besideGrew) && !opening && !heldTopRef.current) {
            heldTopRef.current = { nodeId: selectedNodeId, top: Number(shown!.style.top) };
          }
          const nextFrame = measurePopoverFrame(selectedNodeId, anchor, need, heldTopRef.current?.top ?? null);
          // What springs, never a move: a content change; the held top let
          // go by a resize, and the resize after it while that glide runs,
          // so it follows the resize live (GM r82); the card growing, which
          // moves a panel under the node or flips it above (r82).
          const glide = resized && !moved && (wasHeld || resizingRef.current);
          // GM r104: the edge facing the card follows it on the same spring,
          // so a card widening beside the panel (an Image Input's preview
          // landing) moves its left edge on the spring, never in one frame.
          const shifts = shown?.nodeId === selectedNodeId && shown.placement !== 'pinned-left'
            && (shown.style.height !== nextFrame.style.height || shown.style.top !== nextFrame.style.top
              || shown.style.left !== nextFrame.style.left);
          if (shifts && (contentChanged || glide || grew)) startSpring();
          needRef.current = { nodeId: selectedNodeId, need };
          if (opening) advanceOpen(popover, need, tick);
          const changed = !frameEquals(frameRef.current, nextFrame);
          if (changed) frameRef.current = nextFrame;
          // The frame the card's spring ends in still follows: the card
          // lands at rest there, off the spring's last overshoot, and the
          // panel takes that last step with it, not on a spring of its own.
          // Only a frame lets go (the re-measure straight after a commit is
          // the same frame).
          const wasFollowing = followsCardRef.current;
          const follow = following || (wasFollowing && (changed || !tick));
          const followChanged = follow !== wasFollowing;
          followsCardRef.current = follow;
          const commit = () => {
            if (changed) setFrame(nextFrame);
            if (followChanged) setFollowsCard(follow);
          };
          // Following the card: commit before this frame is painted (a
          // once-a-frame step runs in requestAnimationFrame, before the
          // browser lays out and paints that frame), so the panel's edge is
          // where the card's is on screen, never a frame behind it.
          if (tick && (follow || followChanged) && (changed || followChanged)) flushSync(commit);
          else commit();
        } else if (frameRef.current !== null) {
          frameRef.current = null;
          setFrame(null);
        }
      }
      // After this step's spring decision, so a spring that starts here
      // holds the line it had before it.
      updateLine();
    };
    stepRef.current = step;

    const tick = () => {
      step(true);
      if (!stopped) {
        raf = window.requestAnimationFrame(tick);
      }
    };

    raf = window.requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (stepRef.current === step) stepRef.current = null;
      window.cancelAnimationFrame(raf);
      // This open is over (closed, another node, pinned): a spring still
      // running doesn't carry into the next open.
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = null;
      resizingRef.current = false;
      setContentResizing(false);
      followsCardRef.current = false;
      setFollowsCard(false);
      lineHeldRef.current = null;
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
      data-follows-card={followsCard && !pinned ? '' : undefined}
      data-opening={settledFor !== selectedNodeId ? '' : undefined}
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
      {/* Its top edge shows a hairline while the body can scroll further
          down (GM r87), on the house springs (styles/slava-restraint.css),
          held through a height spring (GM r98, updateLine above). */}
      <div ref={setFoot} className="node-inspector-popover__foot" style={FOOT_SPRINGS}
        data-more-below={line ? '' : undefined} />
    </div>,
    document.body,
  );
}
