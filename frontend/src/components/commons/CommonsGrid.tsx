import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { CommonsMedia } from './CommonsMedia';
import { STATE_LABELS } from '../../lib/commonsFormat';
import type { SearchRow } from '../../lib/commonsTypes';

interface Props {
  rows: SearchRow[];
  selectedId: string | null;
  loading: boolean;
  emptyHint: string;
  onOpen: (row: SearchRow) => void;
  onDropFiles: (files: File[]) => void;
}

function columnCount(grid: HTMLElement | null): number {
  if (!grid) return 1;
  const template = getComputedStyle(grid).gridTemplateColumns;
  return Math.max(1, template.split(' ').filter(Boolean).length);
}

export function CommonsGrid({ rows, selectedId, loading, emptyHint, onOpen, onDropFiles }: Props) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const activeIndex = Math.min(focusIndex, Math.max(0, rows.length - 1));

  const focusTile = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setFocusIndex(next);
    gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-commons-tile]')[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const cols = columnCount(gridRef.current);
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (event.key in moves) {
      event.preventDefault();
      focusTile(activeIndex + moves[event.key]);
    } else if (event.key === 'Enter' && rows[activeIndex]) {
      event.preventDefault();
      onOpen(rows[activeIndex]);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) onDropFiles(files);
  };

  return (
    <div
      className={`commons-grid-wrap${dragging ? ' commons-grid-wrap--dragging' : ''}`}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {rows.length === 0 ? (
        <p className="commons-empty">{loading ? 'Searching…' : emptyHint}</p>
      ) : (
        <div ref={gridRef} className="commons-grid" role="listbox" aria-label="Commons results" onKeyDown={onKeyDown}>
          {rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={row.id === selectedId}
              data-commons-tile
              tabIndex={index === activeIndex ? 0 : -1}
              className={`commons-tile${row.id === selectedId ? ' commons-tile--selected' : ''}`}
              title={row.summary ?? row.collection}
              onFocus={() => setFocusIndex(index)}
              onClick={() => onOpen(row)}
            >
              {row.media === 'video' ? (
                <CommonsMedia video className="commons-tile__media" path={`/api/commons/blobs/${row.blob_key}`} muted preload="metadata" />
              ) : (
                <CommonsMedia className="commons-tile__media" path={`/api/commons/blobs/${row.blob_key}`} alt={row.summary ?? ''} loading="lazy" />
              )}
              <span className="commons-tile__badges">
                {row.analysis_state !== 'ready' && (
                  <span className={`commons-badge commons-badge--${row.analysis_state}`}>{STATE_LABELS[row.analysis_state]}</span>
                )}
                {row.role !== 'neutral' && <span className={`commons-badge commons-badge--role-${row.role}`}>{row.role}</span>}
                {row.in_inbox && <span className="commons-badge commons-badge--inbox">inbox</span>}
                {row.media === 'video' && <span className="commons-badge">video</span>}
                {row.comment_count > 0 && (
                  <span className="commons-badge commons-badge--count" aria-label={`${row.comment_count} comments`}>
                    {row.comment_count} ✎
                  </span>
                )}
              </span>
              <span className="commons-tile__caption">{row.summary ?? row.collection}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
