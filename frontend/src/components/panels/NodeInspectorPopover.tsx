import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Pin, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { Inspector } from './Inspector';
import { ScrollFade } from '../ScrollFade';

const POPOVER_GAP = 10;
const POPOVER_WIDTH = 260;
const POPOVER_MIN_WIDTH = 228;
const POPOVER_MAX_HEIGHT = 300;
const POPOVER_MIN_HEIGHT = 220;
const PINNED_WIDTH = 300;
const PINNED_MIN_WIDTH = 260;
const PINNED_MAX_HEIGHT = 440;
const PINNED_RESIZE_MIN_WIDTH = 240;
const PINNED_RESIZE_MIN_HEIGHT = 260;
const PINNED_GAP = 12;
const VIEWPORT_GUTTER = 16;
const BOTTOM_GUTTER = 80;

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

function measurePopoverFrame(nodeId: string, anchor: HTMLElement): PopoverFrame {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxHeight = Math.max(
    POPOVER_MIN_HEIGHT,
    viewportHeight - VIEWPORT_GUTTER - BOTTOM_GUTTER,
  );
  const height = Math.min(POPOVER_MAX_HEIGHT, maxHeight);
  const rightSpace = viewportWidth - rect.right - POPOVER_GAP - VIEWPORT_GUTTER;
  const leftSpace = rect.left - POPOVER_GAP - VIEWPORT_GUTTER;

  let placement: PopoverFrame['placement'] = 'right';
  let width = Math.min(POPOVER_WIDTH, Math.max(POPOVER_MIN_WIDTH, rightSpace));
  let left = rect.right + POPOVER_GAP;
  let top = clamp(
    rect.top - 8,
    VIEWPORT_GUTTER,
    viewportHeight - height - VIEWPORT_GUTTER,
  );

  if (rightSpace < POPOVER_MIN_WIDTH && leftSpace >= POPOVER_MIN_WIDTH) {
    placement = 'left';
    width = Math.min(POPOVER_WIDTH, leftSpace);
    left = rect.left - POPOVER_GAP - width;
  } else if (rightSpace < POPOVER_MIN_WIDTH) {
    const availableWidth = viewportWidth - VIEWPORT_GUTTER * 2;
    width = Math.max(240, Math.min(POPOVER_WIDTH, availableWidth));
    left = clamp(rect.left + rect.width / 2 - width / 2, VIEWPORT_GUTTER, viewportWidth - width - VIEWPORT_GUTTER);
    top = rect.bottom + POPOVER_GAP;
    placement = 'bottom';

    if (top + height > viewportHeight - BOTTOM_GUTTER) {
      const aboveTop = rect.top - POPOVER_GAP - height;
      if (aboveTop >= VIEWPORT_GUTTER) {
        top = aboveTop;
        placement = 'top';
      } else {
        top = clamp(top, VIEWPORT_GUTTER, viewportHeight - height - VIEWPORT_GUTTER);
      }
    }
  }

  return {
    nodeId,
    placement,
    style: {
      left,
      top,
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
  const bottomGutter = Math.min(
    BOTTOM_GUTTER,
    Math.max(VIEWPORT_GUTTER, viewportHeight - VIEWPORT_GUTTER - PINNED_RESIZE_MIN_HEIGHT),
  );
  const bottomBound = viewportHeight - bottomGutter;
  const availableHeight = Math.max(0, bottomBound - VIEWPORT_GUTTER);
  const minWidth = Math.min(PINNED_RESIZE_MIN_WIDTH, availableWidth);
  const minHeight = Math.min(PINNED_RESIZE_MIN_HEIGHT, availableHeight);
  const maxWidth = Math.min(520, availableWidth);
  const width = clamp(preference?.width ?? PINNED_WIDTH, minWidth, maxWidth);
  const height = clamp(preference?.height ?? PINNED_MAX_HEIGHT, minHeight, availableHeight);
  const left = clamp(preference?.left ?? leftBound, leftBound, rightBound - width);
  const top = clamp(preference?.top ?? bottomBound - height, VIEWPORT_GUTTER, bottomBound - height);

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
  const frameRef = useRef<PopoverFrame | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pinnedPreferenceRef = useRef<PinnedPreference | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!pinned) pinnedPreferenceRef.current = null;
    if (!visible || !selectedNodeId) return;

    let raf = 0;
    let stopped = false;

    const tick = () => {
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
          const nextFrame = measurePopoverFrame(selectedNodeId, anchor);
          if (!frameEquals(frameRef.current, nextFrame)) {
            frameRef.current = nextFrame;
            setFrame(nextFrame);
          }
        } else if (frameRef.current !== null) {
          frameRef.current = null;
          setFrame(null);
        }
      }

      if (!stopped) {
        raf = window.requestAnimationFrame(tick);
      }
    };

    raf = window.requestAnimationFrame(tick);

    return () => {
      stopped = true;
      window.cancelAnimationFrame(raf);
    };
  }, [pinned, selectedNodeId, visible]);

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
      <ScrollFade className="node-inspector-popover__body">
        <Inspector embedded />
      </ScrollFade>
    </div>,
    document.body,
  );
}
