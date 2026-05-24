import type { PointerEvent, RefObject } from 'react';
import { useUIStore } from '../../store/uiStore';
import { SelectionBox } from './SelectionBox';

interface PlayerOverlayProps {
  remotionNodeId: string;
  playerFrameRef: RefObject<HTMLElement | null>;
  currentFrame?: number;
}

function hitTestTrackItem(x: number, y: number): string | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const id = el.closest('[data-track-item-content-id]')?.getAttribute('data-track-item-content-id');
    if (id) return id;
  }
  for (const el of els) {
    const root = el.closest('[data-track-item-id]');
    const id = root?.getAttribute('data-track-item-id');
    if (id && !document.querySelector(`[data-track-item-content-id="${id}"]`)) return id;
  }
  return null;
}

export function PlayerOverlay({ remotionNodeId, playerFrameRef, currentFrame = 0 }: PlayerOverlayProps) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const selectedTrackItemIds = useUIStore((s) => s.selectedTrackItemIds);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);
  const toggleSelectedTrackItem = useUIStore((s) => s.toggleSelectedTrackItem);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const hit = hitTestTrackItem(e.clientX, e.clientY);
    if (hit && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      toggleSelectedTrackItem(hit);
      return;
    }
    setSelectedTrackItem(hit);
  };

  const renderedTrackItemIds =
    selectedTrackItemIds.length > 0
      ? selectedTrackItemIds
      : selectedTrackItemId
        ? [selectedTrackItemId]
        : [];

  return (
    <div
      className="remotion-player-overlay"
      onPointerDown={handlePointerDown}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'auto',
      }}
    >
      {renderedTrackItemIds.map((trackItemId) => (
        <SelectionBox
          key={trackItemId}
          remotionNodeId={remotionNodeId}
          trackItemId={trackItemId}
          playerFrameRef={playerFrameRef}
          currentFrame={currentFrame}
          isPrimary={trackItemId === selectedTrackItemId}
        />
      ))}
    </div>
  );
}
