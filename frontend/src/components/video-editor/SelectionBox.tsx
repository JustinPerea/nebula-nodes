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
  // NOTE FOR 2.3.b: data-track-item-id currently lives on the AbsoluteFill
  // root, which is always full-composition-size. getBoundingClientRect returns
  // the full Player bounding rect regardless of spatial.x/y (the translate3d
  // is on the *inner* content div, not the AbsoluteFill). For 2.3.a this is
  // acceptable — drag still works mechanically because the body fills the
  // canvas. For 2.3.b resize handles to land on layer corners (not canvas
  // corners), you will need to either move data-track-item-id to a content
  // wrapper that receives the transform, or add a separate data attribute on
  // the inner element.
  const spatial = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === remotionNodeId);
    const manifest = (node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    return manifest?.timeline.find((t) => t.id === trackItemId)?.spatial ?? null;
  });
  const dragRef = useRef<DragSession | null>(null);

  useEffect(() => {
    const el = document.querySelector(`[data-track-item-id="${trackItemId}"]`);
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
    if (!drag.moved && (dxScreen !== 0 || dyScreen !== 0)) {
      drag.moved = true;
    }
    if (!drag.moved) return;

    updateTrackItemSpatial(remotionNodeId, trackItemId, {
      x: drag.startSpatialX + dxComp,
      y: drag.startSpatialY + dyComp,
    });
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
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
        onPointerUp={handlePointerUp}
      />
    </div>
  );
}
