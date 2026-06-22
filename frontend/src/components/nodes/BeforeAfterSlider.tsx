import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clampPercent } from './beforeAfter';

interface BeforeAfterSliderProps {
  beforeSrc: string;
  afterSrc: string;
  beforeAlt?: string;
  afterAlt?: string;
}

/**
 * Draggable before/after wipe. The "after" image fills the frame; the "before"
 * image is overlaid and clipped to the divider position. `nodrag` keeps the
 * wipe gesture from panning the React Flow canvas / dragging the node.
 */
export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeAlt = 'Before',
  afterAlt = 'After',
}: BeforeAfterSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [divider, setDivider] = useState(50);

  const updateFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    setDivider(clampPercent(((clientX - rect.left) / rect.width) * 100));
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    updateFromClientX(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) updateFromClientX(e.clientX);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      ref={containerRef}
      className="before-after nodrag"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      role="slider"
      aria-label="Before/after comparison"
      aria-valuenow={Math.round(divider)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <img className="before-after__img" src={afterSrc} alt={afterAlt} draggable={false} />
      <div className="before-after__before" style={{ clipPath: `inset(0 ${100 - divider}% 0 0)` }}>
        <img className="before-after__img" src={beforeSrc} alt={beforeAlt} draggable={false} />
      </div>
      <div className="before-after__divider" style={{ left: `${divider}%` }} aria-hidden="true">
        <span className="before-after__handle" />
      </div>
    </div>
  );
}
