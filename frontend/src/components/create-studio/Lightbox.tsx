import { useEffect, useCallback, useRef } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ViewableMedia } from '../../lib/createGallery';
import { usePanelFocus } from '../../hooks/usePanelFocus';
import { keyBlockedByModal } from '../../lib/canvasShortcutScope';
import { ModalPortal } from '../ModalPortal';
import { useNoticeClearance } from '../../hooks/useNoticeClearance';

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
  const visible = Boolean(current);
  const panelRef = useRef<HTMLDivElement>(null);
  // Review 6 MEDIUM-3: the media and its counter stop above the notice band.
  const clearance = useNoticeClearance();
  usePanelFocus(visible, panelRef, onClose, { initialFocus: '.lightbox__close', trap: true });
  useEffect(() => {
    // A boundary navigation button may disappear after moving to the first
    // or last item. Keep focus in the viewer when that control is removed.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      panel.querySelector<HTMLButtonElement>('.lightbox__close')?.focus({ preventScroll: true });
    }
  }, [safeIndex]);

  const goPrev = useCallback(() => {
    if (safeIndex > 0) onIndexChange(safeIndex - 1);
  }, [safeIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (safeIndex < count - 1) onIndexChange(safeIndex + 1);
  }, [safeIndex, count, onIndexChange]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !panelRef.current?.contains(e.target as globalThis.Node)) return;
      // A modal dialog over the lightbox owns the keys (review 8, L-d).
      if (keyBlockedByModal(panelRef.current)) return;
      // Keep the native video player's arrow-key controls intact.
      if (e.target instanceof HTMLVideoElement) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('lightbox-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('lightbox-open');
    };
  }, [visible, goPrev, goNext]);

  if (!current) return null;

  return (
    <ModalPortal>
    <div ref={panelRef} className="lightbox" style={clearance} role="dialog" aria-modal="true" aria-label="Result preview" tabIndex={-1} onClick={onClose}>
      <button type="button" className="lightbox__close" onClick={(event) => { event.stopPropagation(); onClose(); }} aria-label="Close (Esc)">
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
          <video className="lightbox__media" src={current.url} controls autoPlay loop playsInline tabIndex={0} />
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
    </div>
    </ModalPortal>
  );
}
