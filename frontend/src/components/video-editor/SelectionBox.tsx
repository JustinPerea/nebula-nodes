import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';
import { useGraphStore } from '../../store/graphStore';
import type { VideoGraphManifest } from '../../types/video';
import { screenToComposition } from '../../lib/video/coordinates';

interface SelectionBoxProps {
  remotionNodeId: string;
  trackItemId: string;
  playerFrameRef: RefObject<HTMLElement | null>;
}

interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragSession {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSpatialX: number;
  startSpatialY: number;
  moved: boolean;
}

const POINTER_DEAD_ZONE_PX = 4;

function hasMovedPastDeadZone(dxScreen: number, dyScreen: number): boolean {
  return Math.hypot(dxScreen, dyScreen) > POINTER_DEAD_ZONE_PX;
}

export function SelectionBox({ remotionNodeId, trackItemId, playerFrameRef }: SelectionBoxProps) {
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const updateTrackItemSpatial = useGraphStore((s) => s.updateTrackItemSpatial);
  // Subscribe to the selected item's spatial so SelectionBox re-renders after
  // every updateTrackItemSpatial dispatch (drag tick OR Properties Panel edit).
  // The selector result is used only as a useEffect dep — its value isn't read
  // directly here. Each spatial change produces a new object reference (the
  // store spread creates { ...t.spatial, ...patch }), so Object.is fails and
  // the subscription fires.
  //
  // SelectionBox queries data-track-item-content-id (the transformed inner
  // element) so the outline traces the layer's screen bounds, not the full
  // canvas. Falls back to data-track-item-id for empty/loading-state layers
  // that don't yet render a content element.
  const spatial = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === remotionNodeId);
    const manifest = (node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    return manifest?.timeline.find((t) => t.id === trackItemId)?.spatial ?? null;
  });
  const dragRef = useRef<DragSession | null>(null);

  useEffect(() => {
    const el =
      document.querySelector(`[data-track-item-content-id="${trackItemId}"]`) ??
      document.querySelector(`[data-track-item-id="${trackItemId}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
  }, [trackItemId, spatial]);

  if (!rect) return null;

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // Stop the event from bubbling to PlayerOverlay's onPointerDown — clicking
    // the box body should NOT trigger select/deselect logic; it starts a drag.
    e.stopPropagation();

    // Read the current spatial.x/y once at the start of the gesture so each
    // pointermove computes against a stable origin (avoids cumulative drift).
    const remotion = useGraphStore.getState().nodes.find((n) => n.id === remotionNodeId);
    const manifest = (remotion?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    const item = manifest?.timeline.find((t) => t.id === trackItemId);
    if (!item) return;

    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startSpatialX: item.spatial.x,
      startSpatialY: item.spatial.y,
      moved: false,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const playerEl = playerFrameRef.current;
    if (!playerEl) return;

    const dxScreen = e.clientX - drag.startClientX;
    const dyScreen = e.clientY - drag.startClientY;
    const { x: dxComp, y: dyComp } = screenToComposition(dxScreen, dyScreen, playerEl);

    // Mark the drag as moved on the first non-zero pointermove so a true click
    // (down → up with no move) doesn't flush an undo entry.
    if (!drag.moved && hasMovedPastDeadZone(dxScreen, dyScreen)) {
      drag.moved = true;
    }
    if (!drag.moved) return;

    updateTrackItemSpatial(remotionNodeId, trackItemId, {
      x: drag.startSpatialX + dxComp,
      y: drag.startSpatialY + dyComp,
    });
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released by the browser during cancel.
    }
    dragRef.current = null;
  };

  return (
    <div
      className="remotion-selection-box"
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    >
      <div
        className="remotion-selection-box__body"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}
