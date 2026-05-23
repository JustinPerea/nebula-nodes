import type { PointerEvent } from 'react';
import { useUIStore } from '../../store/uiStore';
import { SelectionBox } from './SelectionBox';

interface PlayerOverlayProps {
  remotionNodeId: string;
}

function hitTestTrackItem(x: number, y: number): string | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const id = el.closest('[data-track-item-id]')?.getAttribute('data-track-item-id');
    if (id) return id;
  }
  return null;
}

export function PlayerOverlay({ remotionNodeId }: PlayerOverlayProps) {
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
        />
      )}
    </div>
  );
}
