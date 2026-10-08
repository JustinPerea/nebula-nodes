import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { galleryItemsFromSession, galleryItemsFromCanvas, firstViewableMedia, type GenerationRecord, type ViewableMedia } from '../../lib/createGallery';
import { ResultCard } from './ResultCard';
import { Lightbox } from './Lightbox';
import { resultContextForNode, type ResultContext } from '../../lib/resultContext';
import type { RunRecord } from '../../lib/runHistory';
import { ResultComparison, type ComparisonResult } from './ResultComparison';

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
  history?: readonly RunRecord[];
  onReuseSettings?: (context: ResultContext) => void;
  emptyState?: ReactNode;
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
  history = [],
  onReuseSettings,
  emptyState,
}: ResultsGalleryProps) {
  const [tab, setTab] = useState<'session' | 'canvas'>(defaultTab ?? 'session');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [showSelectedOnly, setShowSelectedOnly] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);
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
  const toggleComparison = (result: ComparisonResult) => {
    setComparison((current) => current.some((item) => item.key === result.key)
      ? current.filter((item) => item.key !== result.key)
      : current.length < 2 ? [...current, structuredClone(result)] : current);
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

      {comparison.length > 0 && <div className="results-gallery__comparison" aria-label="Comparison selection">
        <span>{comparison.length} of 2 selected</span>
        {comparison.map((item, index) => <button key={item.key} type="button"
          aria-label={`Remove result ${index + 1} from comparison`}
          title={`${item.context.modelName} · ${item.context.prompt || 'Unrecorded prompt'}`}
          onClick={() => setComparison((current) => current.filter((result) => result.key !== item.key))}>
          {item.media.kind === 'image' ? <img src={item.media.url} alt="" /> : <span aria-hidden="true">Video</span>}
          Result {index + 1} ×
        </button>)}
        <button type="button" disabled={comparison.length !== 2} data-result-comparison-fallback
          onClick={() => setComparisonOpen(true)}>Compare selected</button>
        <button type="button" onClick={() => setComparison([])}>Clear</button>
      </div>}

      {items.length === 0 ? (
        <div className="results-gallery__empty">{emptyState ?? emptyMessage}</div>
      ) : (
        <div ref={resultsRef} className={`results-gallery__items results-gallery__items--${layout}`} role="region" aria-label="Create results" tabIndex={0}>
          <div className={`results-gallery__cards results-gallery__cards--${layout}`}>
            {items.map((it) => {
              const context = it.node ? resultContextForNode(it.node, history) : undefined;
              const media = firstViewableMedia(it.node);
              const candidate = context && media ? { key: context.key, nodeId: it.nodeId, context, media } : undefined;
              const selected = candidate && comparison.some((item) => item.key === candidate.key);
              return (
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
                context={context}
                onReuseSettings={context && onReuseSettings ? () => onReuseSettings(context) : undefined}
                onCompare={candidate ? () => toggleComparison(candidate) : undefined}
                compareSelected={!!selected}
                compareDisabled={comparison.length === 2 && !selected}
              />
              );
            })}
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
      {comparisonOpen && comparison.length === 2 && <ResultComparison
        items={comparison as [ComparisonResult, ComparisonResult]}
        onClose={() => setComparisonOpen(false)} onReuseSettings={onReuseSettings} />}
    </div>
  );
}
