import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Pin, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { Inspector } from './Inspector';

const POPOVER_GAP = 10;
const POPOVER_WIDTH = 260;
const POPOVER_MIN_WIDTH = 228;
const POPOVER_MAX_HEIGHT = 300;
const POPOVER_MIN_HEIGHT = 220;
const PINNED_WIDTH = 300;
const PINNED_MIN_WIDTH = 260;
const PINNED_MAX_HEIGHT = 440;
const PINNED_MIN_HEIGHT = 320;
const PINNED_GAP = 12;
const VIEWPORT_GUTTER = 16;
const BOTTOM_GUTTER = 80;

type PopoverFrame = {
  nodeId: string;
  placement: 'left' | 'right' | 'top' | 'bottom' | 'pinned-left';
  style: CSSProperties;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getInspectorAnchor(nodeId: string) {
  const anchors = document.querySelectorAll<HTMLElement>('[data-node-inspector-anchor]');
  return Array.from(anchors).find((anchor) => anchor.dataset.nodeInspectorAnchor === nodeId) ?? null;
}

function frameEquals(a: PopoverFrame | null, b: PopoverFrame) {
  if (!a || a.nodeId !== b.nodeId || a.placement !== b.placement) return false;
  return (
    a.style.left === b.style.left &&
    a.style.top === b.style.top &&
    a.style.width === b.style.width &&
    a.style.height === b.style.height
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

function measurePinnedFrame(nodeId: string): PopoverFrame {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const library = document.querySelector('.panel--library') as HTMLElement | null;
  const libraryRect = library?.getBoundingClientRect();
  const libraryVisible = Boolean(libraryRect && libraryRect.width > 0 && libraryRect.height > 0);
  const viewportAvailableHeight = Math.max(
    PINNED_MIN_HEIGHT,
    viewportHeight - VIEWPORT_GUTTER - BOTTOM_GUTTER,
  );
  let left = VIEWPORT_GUTTER;
  let top = Math.max(VIEWPORT_GUTTER, viewportHeight - BOTTOM_GUTTER - Math.min(PINNED_MAX_HEIGHT, viewportAvailableHeight));
  let width = Math.min(PINNED_WIDTH, viewportWidth - VIEWPORT_GUTTER * 2);
  let height = Math.min(PINNED_MAX_HEIGHT, viewportAvailableHeight);

  if (libraryRect && libraryVisible) {
    const belowSpace = viewportHeight - libraryRect.bottom - PINNED_GAP - BOTTOM_GUTTER;
    const rightSpace = viewportWidth - libraryRect.right - PINNED_GAP - VIEWPORT_GUTTER;

    if (belowSpace >= PINNED_MIN_HEIGHT) {
      left = clamp(libraryRect.left, VIEWPORT_GUTTER, viewportWidth - width - VIEWPORT_GUTTER);
      top = libraryRect.bottom + PINNED_GAP;
      width = clamp(libraryRect.width, PINNED_MIN_WIDTH, Math.min(PINNED_WIDTH, viewportWidth - left - VIEWPORT_GUTTER));
      height = Math.min(PINNED_MAX_HEIGHT, belowSpace);
    } else if (rightSpace >= PINNED_MIN_WIDTH) {
      left = libraryRect.right + PINNED_GAP;
      top = clamp(libraryRect.top, VIEWPORT_GUTTER, viewportHeight - PINNED_MIN_HEIGHT - VIEWPORT_GUTTER);
      width = Math.min(PINNED_WIDTH, rightSpace);
      height = Math.min(PINNED_MAX_HEIGHT, Math.max(PINNED_MIN_HEIGHT, viewportHeight - top - BOTTOM_GUTTER));
    }
  }

  return {
    nodeId,
    placement: 'pinned-left',
    style: {
      left,
      top,
      width,
      height,
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
  const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!visible || !selectedNodeId) return;

    let raf = 0;
    let stopped = false;

    const tick = () => {
      if (pinned) {
        const nextFrame = frameRef.current?.placement === 'pinned-left'
          ? { ...frameRef.current, nodeId: selectedNodeId }
          : measurePinnedFrame(selectedNodeId);
        if (!frameEquals(frameRef.current, nextFrame)) {
          frameRef.current = nextFrame;
          setFrame(nextFrame);
        }
        return;
      }

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
      const height = Number(nextFrame.style.height ?? PINNED_MIN_HEIGHT);
      const nextLeft = clamp(
        dragRef.current.left + e.clientX - dragRef.current.startX,
        -width + 48,
        window.innerWidth - 48,
      );
      const nextTop = clamp(
        dragRef.current.top + e.clientY - dragRef.current.startY,
        VIEWPORT_GUTTER,
        window.innerHeight - 48,
      );
      const updatedFrame = {
        ...nextFrame,
        style: {
          ...nextFrame.style,
          left: nextLeft,
          top: Math.min(nextTop, window.innerHeight - Math.min(height, window.innerHeight) + 48),
        },
      };
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

  if (!visible || !selectedNodeId || !frame) return null;

  return createPortal(
    <div
      className={`node-inspector-popover${pinned ? ' node-inspector-popover--pinned' : ''}`}
      data-placement={frame.placement}
      style={frame.style}
    >
      <div
        className="node-inspector-popover__header"
        onMouseDown={(e) => {
          if (!pinned) return;
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
      <div className="node-inspector-popover__body">
        <Inspector embedded />
      </div>
    </div>,
    document.body,
  );
}
