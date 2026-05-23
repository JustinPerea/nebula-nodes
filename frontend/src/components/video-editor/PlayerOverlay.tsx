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
    const id = el.closest('[data-track-item-id]')?.getAttribute('data-track-item-id');
    if (id) return id;
  }
  return null;
}

export function PlayerOverlay({ remotionNodeId, playerFrameRef, currentFrame = 0 }: PlayerOverlayProps) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const hit = hitTestTrackItem(e.clientX, e.clientY);
    setSelectedTrackItem(hit);
  };

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
      {selectedTrackItemId && (
        <SelectionBox
          remotionNodeId={remotionNodeId}
          trackItemId={selectedTrackItemId}
          playerFrameRef={playerFrameRef}
          currentFrame={currentFrame}
        />
      )}
    </div>
  );
}
