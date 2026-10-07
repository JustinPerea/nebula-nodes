import type { BatchPreview } from '../../hooks/useBatchPreview';
import '../../styles/batch-node.css';

export function BatchCarousel({ preview }: { preview: BatchPreview }) {
  if (!preview.count) return null;
  return (
    <div className="batch-carousel nodrag nopan nowheel" onMouseDown={(event) => event.stopPropagation()}>
      <div className="batch-carousel__controls">
        <button type="button" aria-label="Previous batch result"
          disabled={preview.running || preview.index === 0}
          onClick={(event) => { event.stopPropagation(); preview.select(preview.index - 1); }}>‹</button>
        <span className="batch-carousel__position" aria-live="polite" title={preview.lineage}>
          {preview.running
            ? `${preview.count} result${preview.count === 1 ? '' : 's'} · Running`
            : `${preview.index + 1} of ${preview.count} — ${preview.label}`}
        </span>
        <button type="button" aria-label="Next batch result"
          disabled={preview.running || preview.index >= preview.count - 1}
          onClick={(event) => { event.stopPropagation(); preview.select(preview.index + 1); }}>›</button>
      </div>
      <span className="batch-carousel__note">Browsing keeps the connected output unchanged.</span>
    </div>
  );
}
