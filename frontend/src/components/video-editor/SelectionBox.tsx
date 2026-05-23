import { useEffect, useState } from 'react';

interface SelectionBoxProps {
  remotionNodeId: string;
  trackItemId: string;
}

interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Reads the selected layer's bounding rect each render and draws an outline.
 * Plan 2.3.a only renders the outline; body drag lands in 2.3.b/T5; handles
 * land in 2.3.b/c.
 *
 * The rect is recomputed on every render. Parents pass a key or state change
 * (e.g., the player's current frame) to force re-renders when the underlying
 * transform animates. Plan 2.3.a doesn't animate selections; 2.3.c will.
 */
export function SelectionBox({ remotionNodeId: _remotionNodeId, trackItemId }: SelectionBoxProps) {
  const [rect, setRect] = useState<ScreenRect | null>(null);

  useEffect(() => {
    const el = document.querySelector(`[data-track-item-id="${trackItemId}"]`);
    if (!el) {
      setRect((prev) => (prev === null ? prev : null));
      return;
    }
    const r = el.getBoundingClientRect();
    setRect((prev) => {
      if (
        prev !== null &&
        prev.left === r.left &&
        prev.top === r.top &&
        prev.width === r.width &&
        prev.height === r.height
      ) {
        return prev; // no change — skip re-render to break potential tight loops
      }
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
  });

  if (!rect) return null;

  return (
    <div
      className="remotion-selection-box"
      style={{
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        pointerEvents: 'none',
      }}
    >
      <div className="remotion-selection-box__body" />
    </div>
  );
}
