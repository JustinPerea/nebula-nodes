import { useState } from 'react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { galleryItemsFromSession, galleryItemsFromCanvas, type GenerationRecord } from '../../lib/createGallery';
import { ResultCard } from './ResultCard';

export interface ResultsGalleryProps {
  records: GenerationRecord[];
  nodes: Node<NodeData>[];
  selectedIds: Set<string>;
  defaultTab?: 'session' | 'canvas';
  onOpenInCanvas: (nodeId: string) => void;
  onUseAsInput: (url: string) => void;
  onDelete: (nodeId: string) => void;
}

export function ResultsGallery({
  records,
  nodes,
  selectedIds,
  defaultTab,
  onOpenInCanvas,
  onUseAsInput,
  onDelete,
}: ResultsGalleryProps) {
  const [tab, setTab] = useState<'session' | 'canvas'>(defaultTab ?? 'session');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [showSelectedOnly, setShowSelectedOnly] = useState(true);

  const items =
    tab === 'session'
      ? galleryItemsFromSession(records, nodes)
      : galleryItemsFromCanvas(nodes, showSelectedOnly && selectedIds.size > 0 ? selectedIds : undefined);

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
            onClick={() => setTab('session')}
          >
            Session
          </button>
          <button
            type="button"
            className={`results-gallery__tab${tab === 'canvas' ? ' is-active' : ''}`}
            onClick={() => setTab('canvas')}
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
