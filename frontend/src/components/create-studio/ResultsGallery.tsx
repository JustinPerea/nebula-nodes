import { useState } from 'react';
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
  onSaveToFolder?: (url: string) => void;
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
  const openLightbox = (nodeId: string) => {
    const idx = viewable.findIndex((v) => v.nodeId === nodeId);
    if (idx >= 0) setLightboxIndex(idx);
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
    <div className="results-gallery">
      <div className="results-gallery__bar">
        {/* Tab toggle */}
        <div className="results-gallery__tabs">
          <button
            type="button"
            className={`results-gallery__tab${tab === 'session' ? ' is-active' : ''}`}
            onClick={() => switchTab('session')}
          >
            Session
          </button>
          <button
            type="button"
            className={`results-gallery__tab${tab === 'canvas' ? ' is-active' : ''}`}
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
            onClick={() => setShowSelectedOnly((v) => !v)}
          >
            {showSelectedOnly ? `Selected (${selectedIds.size}) · Show all` : 'Show selected'}
          </button>
        )}

        {/* Count + layout toggle (right side) */}
        <span className="results-gallery__count">
          {items.length} result{items.length === 1 ? '' : 's'}
        </span>
        <div className="results-gallery__layout">
          <button
            type="button"
            className={layout === 'grid' ? 'is-active' : ''}
            onClick={() => setLayout('grid')}
          >
            Grid
          </button>
          <button
            type="button"
            className={layout === 'list' ? 'is-active' : ''}
            onClick={() => setLayout('list')}
          >
            List
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="results-gallery__empty">{emptyMessage}</div>
      ) : (
        <div className={`results-gallery__items results-gallery__items--${layout}`}>
          {items.map((it) => (
            <ResultCard
              key={it.nodeId}
              node={it.node}
              onOpenInCanvas={() => onOpenInCanvas(it.nodeId)}
              onUseAsInput={onUseAsInput}
              onDelete={() => onDelete(it.nodeId)}
              onReveal={onReveal}
              onSaveToFolder={onSaveToFolder}
              onZoom={() => openLightbox(it.nodeId)}
            />
          ))}
        </div>
      )}

      {lightboxIndex !== null && viewable.length > 0 && (
        <Lightbox
          items={viewable.map((v) => v.media)}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  );
}
