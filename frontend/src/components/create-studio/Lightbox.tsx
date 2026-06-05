import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ViewableMedia } from '../../lib/createGallery';

export interface LightboxProps {
  items: ViewableMedia[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

/**
 * Fullscreen media viewer. Renders into document.body via a portal so it sits
 * above the canvas and every panel. Closes on Esc / backdrop click / the X;
 * ←/→ (and the edge arrows) move through the gallery's viewable items.
 */
export function Lightbox({ items, index, onClose, onIndexChange }: LightboxProps) {
  const count = items.length;
  const safeIndex = Math.max(0, Math.min(index, count - 1));
  const current = items[safeIndex];

  const goPrev = useCallback(() => {
    if (safeIndex > 0) onIndexChange(safeIndex - 1);
  }, [safeIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (safeIndex < count - 1) onIndexChange(safeIndex + 1);
  }, [safeIndex, count, onIndexChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('lightbox-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('lightbox-open');
    };
  }, [onClose, goPrev, goNext]);

  if (!current) return null;

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button type="button" className="lightbox__close" onClick={onClose} aria-label="Close (Esc)">
        <X size={22} strokeWidth={1.75} />
      </button>

      {safeIndex > 0 && (
        <button
          type="button"
          className="lightbox__nav lightbox__nav--prev"
          onClick={(e) => { e.stopPropagation(); goPrev(); }}
          aria-label="Previous"
        >
          <ChevronLeft size={28} strokeWidth={1.75} />
        </button>
      )}

      <div className="lightbox__stage" onClick={(e) => e.stopPropagation()}>
        {current.kind === 'video' ? (
          <video className="lightbox__media" src={current.url} controls autoPlay loop playsInline />
        ) : (
          <img className="lightbox__media" src={current.url} alt="" />
        )}
      </div>

      {safeIndex < count - 1 && (
        <button
          type="button"
          className="lightbox__nav lightbox__nav--next"
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          aria-label="Next"
        >
          <ChevronRight size={28} strokeWidth={1.75} />
        </button>
      )}

      {count > 1 && <div className="lightbox__counter">{safeIndex + 1} / {count}</div>}
    </div>,
    document.body,
  );
}
