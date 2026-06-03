import { useState } from 'react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { galleryItemsFromSession, type GenerationRecord } from '../../lib/createGallery';
import { ResultCard } from './ResultCard';

export interface ResultsGalleryProps {
  records: GenerationRecord[];
  nodes: Node<NodeData>[];
  onOpenInCanvas: (nodeId: string) => void;
  onUseAsInput: (url: string) => void;
  onDelete: (nodeId: string) => void;
}

export function ResultsGallery({ records, nodes, onOpenInCanvas, onUseAsInput, onDelete }: ResultsGalleryProps) {
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const items = galleryItemsFromSession(records, nodes);
  if (items.length === 0) return null;
  return (
    <div className="results-gallery">
      <div className="results-gallery__bar">
        <span className="results-gallery__count">{items.length} result{items.length === 1 ? '' : 's'}</span>
        <div className="results-gallery__layout">
          <button type="button" className={layout === 'grid' ? 'is-active' : ''} onClick={() => setLayout('grid')}>Grid</button>
          <button type="button" className={layout === 'list' ? 'is-active' : ''} onClick={() => setLayout('list')}>List</button>
        </div>
      </div>
      <div className={`results-gallery__items results-gallery__items--${layout}`}>
        {items.map((it) => (
          <ResultCard key={it.nodeId} node={it.node}
            onOpenInCanvas={() => onOpenInCanvas(it.nodeId)}
            onUseAsInput={onUseAsInput}
            onDelete={() => onDelete(it.nodeId)} />
        ))}
      </div>
    </div>
  );
}
