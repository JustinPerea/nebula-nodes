import { useEffect, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { galleryItemsFromSession, galleryItemsFromCanvas, firstViewableMedia, type GenerationRecord, type ViewableMedia } from '../../lib/createGallery';
import { ResultCard } from './ResultCard';
import { Lightbox } from './Lightbox';

export interface ResultsGalleryProps {
  records: GenerationRecord[];
  nodes: Node<NodeData>[];
  selectedIds: Set<string>;
  defaultTab?: 'session' | 'canvas';
  onOpenInCanvas: (nodeId: string) => void;
  onUseAsInput: (url: string) => void;
  onDelete: (nodeId: string) => void;
  onReveal?: (url: string) => void;
  onSaveToFolder?: (url: string) => Promise<{ savedPath: string }>;
}

export function ResultsGallery({
  records,
  nodes,
  selectedIds,
  defaultTab,
  onOpenInCanvas,
  onUseAsInput,
  onDelete,
  onReveal,
  onSaveToFolder,
}: ResultsGalleryProps) {
  const [tab, setTab] = useState<'session' | 'canvas'>(defaultTab ?? 'session');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [showSelectedOnly, setShowSelectedOnly] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const restoreFallback = useRef(false);
  useEffect(() => {
    if (lightboxIndex !== null || !restoreFallback.current) return;
    restoreFallback.current = false;
    // usePanelFocus restores the exact opener first. If that output was
    // replaced while fullscreen was open, return to the stable results area.
    if (document.activeElement === document.body) {
      const target = resultsRef.current ?? galleryRef.current?.querySelector<HTMLButtonElement>('.results-gallery__tab.is-active');
      target?.focus({ preventScroll: true });
    }
  }, [lightboxIndex]);

  const items =
    tab === 'session'
      ? galleryItemsFromSession(records, nodes)
      : galleryItemsFromCanvas(nodes, showSelectedOnly && selectedIds.size > 0 ? selectedIds : undefined);

  // Zoomable media in the same order as the cards, so a clicked card maps to a
  // lightbox index and ←/→ steps through exactly what's on screen.
  const viewable: { nodeId: string; media: ViewableMedia }[] = [];
  for (const it of items) {
    const media = firstViewableMedia(it.node);
    if (media) viewable.push({ nodeId: it.nodeId, media });
  }
  const viewableCount = viewable.length;
  // Discard a now-empty viewer before committing the new results, so later
  // media cannot reopen it. This guarded update settles on the next render.
  if (viewableCount === 0 && lightboxIndex !== null) {
    setLightboxIndex(null);
  }
  const openLightbox = (nodeId: string) => {
    const idx = viewable.findIndex((v) => v.nodeId === nodeId);
    if (idx >= 0) {
      restoreFallback.current = true;
      setLightboxIndex(idx);
    }
  };
  const closeLightbox = () => {
    restoreFallback.current = true;
    setLightboxIndex(null);
  };
  const switchTab = (next: 'session' | 'canvas') => {
    setLightboxIndex(null); // viewable set changes with the tab — don't keep a stale index open
    setTab(next);
  };

  const emptyMessage =
    tab === 'session'
      ? 'No generations this session.'
      : 'No results on the canvas yet.';

  return (
    <div ref={galleryRef} className="results-gallery">
      <div className="results-gallery__bar">
        {/* Tab toggle */}
        <div className="results-gallery__tabs" role="group" aria-label="Result source">
          <button
            type="button"
            className={`results-gallery__tab${tab === 'session' ? ' is-active' : ''}`}
            aria-pressed={tab === 'session'}
            onClick={() => switchTab('session')}
          >
            Session
          </button>
          <button
            type="button"
            className={`results-gallery__tab${tab === 'canvas' ? ' is-active' : ''}`}
            aria-pressed={tab === 'canvas'}
            onClick={() => switchTab('canvas')}
          >
            Canvas
          </button>
        </div>

        {/* Canvas selected-only toggle (only when canvas tab is active and there are selected nodes) */}
        {tab === 'canvas' && selectedIds.size > 0 && (
          <button
            type="button"
            className="results-gallery__selected-toggle"
            aria-pressed={showSelectedOnly}
            onClick={() => setShowSelectedOnly((v) => !v)}
          >
            {showSelectedOnly ? `Selected (${selectedIds.size}) · Show all` : 'Show selected'}
          </button>
        )}

        {/* Count + layout toggle (right side) */}
        <div className="results-gallery__display">
          <span className="results-gallery__count" role="status">
            {items.length} result{items.length === 1 ? '' : 's'}
          </span>
          <div className="results-gallery__layout" role="group" aria-label="Result layout">
            <button
              type="button"
              className={layout === 'grid' ? 'is-active' : ''}
              aria-pressed={layout === 'grid'}
              onClick={() => setLayout('grid')}
            >
              Grid
            </button>
            <button
              type="button"
              className={layout === 'list' ? 'is-active' : ''}
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
            >
              List
            </button>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="results-gallery__empty">{emptyMessage}</div>
      ) : (
        <div ref={resultsRef} className={`results-gallery__items results-gallery__items--${layout}`} role="region" aria-label="Create results" tabIndex={0}>
          <div className={`results-gallery__cards results-gallery__cards--${layout}`}>
            {items.map((it) => (
              <ResultCard
                key={it.nodeId}
                node={it.node}
                prompt={it.prompt}
                onOpenInCanvas={() => onOpenInCanvas(it.nodeId)}
                onUseAsInput={onUseAsInput}
                onDelete={() => onDelete(it.nodeId)}
                onReveal={onReveal}
                onSaveToFolder={onSaveToFolder}
                onZoom={() => openLightbox(it.nodeId)}
              />
            ))}
          </div>
        </div>
      )}

      {lightboxIndex !== null && viewable.length > 0 && (
        <Lightbox
          items={viewable.map((v) => v.media)}
          index={lightboxIndex}
          onClose={closeLightbox}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  );
}
