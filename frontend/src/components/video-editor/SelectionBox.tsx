import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { VideoGraphManifest } from '../../types/video';
import { screenToComposition } from '../../lib/video/coordinates';
import { computeResizeScale } from '../../lib/video/resizeMath';
import type { ResizeHandle } from '../../lib/video/resizeMath';
import { computeRotationZ } from '../../lib/video/rotationMath';
import { interpolateVec3 } from '../../lib/video/keyframeInterp';

interface SelectionBoxProps {
  remotionNodeId: string;
  trackItemId: string;
  playerFrameRef: RefObject<HTMLElement | null>;
  currentFrame?: number;
}

interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
  rotationZ: number;
}

interface MoveDragSession {
  type: 'move';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSpatialX: number;
  startSpatialY: number;
  startSpatialZ: number;
  moved: boolean;
}

interface ResizeDragSession {
  type: 'resize';
  pointerId: number;
  handle: ResizeHandle;
  startClientX: number;
  startClientY: number;
  startScale: [number, number, number];
  startRect: ScreenRect;
  moved: boolean;
}

interface RotationDragSession {
  type: 'rotate';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startRotation: [number, number, number];
  startRect: ScreenRect;
  moved: boolean;
}

type DragSession = MoveDragSession | ResizeDragSession | RotationDragSession;

const POINTER_DEAD_ZONE_PX = 4;

function hasMovedPastDeadZone(dxScreen: number, dyScreen: number): boolean {
  return Math.hypot(dxScreen, dyScreen) > POINTER_DEAD_ZONE_PX;
}

function computeOrientedScreenSize(
  boundingRect: DOMRect,
  baseWidth: number,
  baseHeight: number,
  scale: [number, number, number],
  rotationZ: number,
): { width: number; height: number } {
  if (baseWidth <= 0 || baseHeight <= 0) {
    return { width: boundingRect.width, height: boundingRect.height };
  }

  const unrotatedWidth = Math.abs(baseWidth * scale[0]);
  const unrotatedHeight = Math.abs(baseHeight * scale[1]);
  if (unrotatedWidth <= 0 || unrotatedHeight <= 0) {
    return { width: boundingRect.width, height: boundingRect.height };
  }

  const aspectRatio = unrotatedWidth / unrotatedHeight;
  const radians = (rotationZ * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const heightFromWidth = boundingRect.width / (aspectRatio * cos + sin);
  const heightFromHeight = boundingRect.height / (aspectRatio * sin + cos);
  const heights = [heightFromWidth, heightFromHeight].filter((n) => Number.isFinite(n) && n > 0);
  if (heights.length === 0) {
    return { width: boundingRect.width, height: boundingRect.height };
  }

  const height = heights.reduce((sum, n) => sum + n, 0) / heights.length;
  return { width: height * aspectRatio, height };
}

const RESIZE_HANDLES: ResizeHandle[] = [
  'corner-tl',
  'corner-tr',
  'corner-bl',
  'corner-br',
  'edge-top',
  'edge-right',
  'edge-bottom',
  'edge-left',
];

export function SelectionBox({
  remotionNodeId,
  trackItemId,
  playerFrameRef,
  currentFrame = 0,
}: SelectionBoxProps) {
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const updateTrackItemSpatial = useGraphStore((s) => s.updateTrackItemSpatial);
  const addOrUpdateKeyframe = useGraphStore((s) => s.addOrUpdateKeyframe);
  const isKeyframeRecording = useUIStore((s) => s.isKeyframeRecording);
  // Subscribe to the selected item so SelectionBox re-renders after
  // every updateTrackItemSpatial dispatch (drag tick OR Properties Panel edit).
  // Each spatial/keyframe change produces a new item object reference, so
  // Object.is fails and the subscription fires.
  //
  // SelectionBox queries data-track-item-content-id (the transformed inner
  // element) so the outline traces the layer's screen bounds, not the full
  // canvas. Falls back to data-track-item-id for empty/loading-state layers
  // that don't yet render a content element.
  const selectedItem = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === remotionNodeId);
    const manifest = (node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    return manifest?.timeline.find((t) => t.id === trackItemId) ?? null;
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
    const hasBaseSize = el instanceof HTMLElement && el.offsetWidth > 0 && el.offsetHeight > 0;
    const baseWidth = hasBaseSize ? el.offsetWidth : 0;
    const baseHeight = hasBaseSize ? el.offsetHeight : 0;
    const scale = selectedItem
      ? interpolateVec3(currentFrame, selectedItem.keyframes.scale ?? [], selectedItem.spatial.scale)
      : ([1, 1, 1] as [number, number, number]);
    const rotation = selectedItem
      ? interpolateVec3(currentFrame, selectedItem.keyframes.rotation ?? [], selectedItem.spatial.rotation)
      : ([0, 0, 0] as [number, number, number]);
    const { width, height } = computeOrientedScreenSize(r, baseWidth, baseHeight, scale, rotation[2]);
    const centerX = r.left + r.width / 2;
    const centerY = r.top + r.height / 2;
    setRect({
      left: centerX - width / 2,
      top: centerY - height / 2,
      width,
      height,
      rotationZ: rotation[2],
    });
  }, [trackItemId, selectedItem, currentFrame]);

  if (!rect) return null;

  const handleBodyPointerDown = (e: PointerEvent<HTMLDivElement>) => {
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
      type: 'move',
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startSpatialX: item.spatial.x,
      startSpatialY: item.spatial.y,
      startSpatialZ: item.spatial.z,
      moved: false,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleResizePointerDown = (handle: ResizeHandle) => (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === remotionNodeId);
    const manifest = (remotion?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    const item = manifest?.timeline.find((t) => t.id === trackItemId);
    if (!item) return;

    dragRef.current = {
      type: 'resize',
      pointerId: e.pointerId,
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScale: item.spatial.scale,
      startRect: rect,
      moved: false,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleRotatePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === remotionNodeId);
    const manifest = (remotion?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    const item = manifest?.timeline.find((t) => t.id === trackItemId);
    if (!item) return;

    dragRef.current = {
      type: 'rotate',
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRotation: item.spatial.rotation,
      startRect: rect,
      moved: false,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const dxScreen = e.clientX - drag.startClientX;
    const dyScreen = e.clientY - drag.startClientY;

    // Mark the drag as moved on the first non-zero pointermove so a true click
    // (down → up with no move) doesn't flush an undo entry.
    if (!drag.moved && hasMovedPastDeadZone(dxScreen, dyScreen)) {
      drag.moved = true;
    }
    if (!drag.moved) return;

    if (drag.type === 'move') {
      const playerEl = playerFrameRef.current;
      if (!playerEl) return;
      const { x: dxComp, y: dyComp } = screenToComposition(dxScreen, dyScreen, playerEl);
      const nextX = drag.startSpatialX + dxComp;
      const nextY = drag.startSpatialY + dyComp;
      if (isKeyframeRecording) {
        addOrUpdateKeyframe(remotionNodeId, trackItemId, 'position', currentFrame, [
          nextX,
          nextY,
          drag.startSpatialZ,
        ]);
      } else {
        updateTrackItemSpatial(remotionNodeId, trackItemId, {
          x: nextX,
          y: nextY,
        });
      }
      return;
    }

    if (drag.type === 'rotate') {
      const nextRotation: [number, number, number] = [
        drag.startRotation[0],
        drag.startRotation[1],
        computeRotationZ(drag.startRect, e.clientX, e.clientY),
      ];
      if (isKeyframeRecording) {
        addOrUpdateKeyframe(remotionNodeId, trackItemId, 'rotation', currentFrame, nextRotation);
      } else {
        updateTrackItemSpatial(remotionNodeId, trackItemId, { rotation: nextRotation });
      }
      return;
    }

    const scale = computeResizeScale({
      handle: drag.handle,
      startScale: drag.startScale,
      rect: drag.startRect,
      dxScreen,
      dyScreen,
      shiftKey: e.shiftKey,
    });
    if (isKeyframeRecording) {
      addOrUpdateKeyframe(remotionNodeId, trackItemId, 'scale', currentFrame, scale);
    } else {
      updateTrackItemSpatial(remotionNodeId, trackItemId, { scale });
    }
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
        transform: `rotateZ(${rect.rotationZ}deg)`,
      }}
    >
      <div
        className="remotion-selection-box__body"
        onPointerDown={handleBodyPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle}
          className={`remotion-selection-box__handle remotion-selection-box__handle--${handle}`}
          data-resize-handle={handle}
          onPointerDown={handleResizePointerDown(handle)}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ))}
      <div
        className="remotion-selection-box__rotation-handle"
        data-rotation-handle="z"
        onPointerDown={handleRotatePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}
