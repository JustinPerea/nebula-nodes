import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { CommonsMedia } from './CommonsMedia';
import { analysisBadge } from '../../lib/commonsFormat';
import type { SearchRow } from '../../lib/commonsTypes';

interface Props {
  rows: SearchRow[];
  selectedId: string | null;
  loading: boolean;
  emptyHint: string;
  onOpen: (row: SearchRow) => void;
  onDropFiles: (files: File[]) => void;
  /** PR #204 round 11: adding is locked (a tab that isn't connected as you). A drop is taken
   * (so the browser doesn't open the file) and does nothing: no highlight, nothing sent. */
  dropLocked?: boolean;
  /** References an agent proposes to change (open asset proposals of kind commons). */
  proposed?: ReadonlySet<string>;
}

function columnCount(grid: HTMLElement | null): number {
  if (!grid) return 1;
  const template = getComputedStyle(grid).gridTemplateColumns;
  return Math.max(1, template.split(' ').filter(Boolean).length);
}

interface TileBadge {
  key: string;
  className: string;
  /** What the badge shows (the CSS sets it in capitals). */
  text: string;
  /** How the tile's name reads it, as written, never the capitals Chrome
   *  would take from the CSS ("NOT ANALYZED"; #208 review 4, N2). */
  label: string;
}

/** The tile's badges, in the order they show. */
function tileBadges(row: SearchRow, proposed?: ReadonlySet<string>): TileBadge[] {
  const badges: TileBadge[] = [];
  if (row.analysis_state !== 'ready') {
    const badge = analysisBadge(row.analysis_state, row.last_error_kind);
    badges.push({ key: 'analysis', className: `commons-badge--${badge.modifier}`, text: badge.label, label: badge.label });
  }
  if (row.role !== 'neutral') {
    badges.push({ key: 'role', className: `commons-badge--role-${row.role}`, text: row.role, label: row.role });
  }
  if (row.in_inbox) badges.push({ key: 'inbox', className: 'commons-badge--inbox', text: 'inbox', label: 'inbox' });
  if (proposed?.has(row.id)) {
    badges.push({ key: 'proposal', className: 'commons-badge--proposal', text: 'proposal', label: 'An agent proposes changes' });
  }
  if (row.media === 'video') badges.push({ key: 'video', className: '', text: 'video', label: 'video' });
  if (row.comment_count > 0) {
    badges.push({ key: 'count', className: 'commons-badge--count', text: `${row.comment_count} ✎`,
      label: `${row.comment_count} comments` });
  }
  return badges;
}

/** The tile's accessible name: its caption, then each badge as written. */
function tileName(caption: string, badges: TileBadge[]): string {
  return [caption, ...badges.map((badge) => badge.label)].filter(Boolean).join(', ');
}

export function CommonsGrid({ rows, selectedId, loading, emptyHint, onOpen, onDropFiles, dropLocked = false, proposed }: Props) {
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
    if (dropLocked) return;
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) onDropFiles(files);
  };

  return (
    <div
      className={`commons-grid-wrap${dragging ? ' commons-grid-wrap--dragging' : ''}`}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault();
          if (dropLocked) { event.dataTransfer.dropEffect = 'none'; return; }
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {rows.length === 0 ? (
        emptyHint || loading ? <p className="commons-empty">{loading ? 'Searching…' : emptyHint}</p> : null
      ) : (
        <div ref={gridRef} className="commons-grid" role="listbox" aria-label="Commons results" onKeyDown={onKeyDown}>
          {rows.map((row, index) => {
            const caption = row.summary ?? row.collection;
            const badges = tileBadges(row, proposed);
            return (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={row.id === selectedId}
                aria-label={tileName(caption, badges)}
                data-commons-tile
                tabIndex={index === activeIndex ? 0 : -1}
                className={`commons-tile${row.id === selectedId ? ' commons-tile--selected' : ''}`}
                title={caption}
                onFocus={() => setFocusIndex(index)}
                onClick={() => onOpen(row)}
              >
                {row.media === 'video' ? (
                  <CommonsMedia inControl video className="commons-tile__media" path={`/api/commons/blobs/${row.blob_key}`} muted preload="metadata" />
                ) : (
                  <CommonsMedia inControl className="commons-tile__media" path={`/api/commons/blobs/${row.blob_key}`} alt={row.summary ?? ''} loading="lazy" />
                )}
                <span className="commons-tile__badges">
                  {badges.map((badge) => (
                    <span key={badge.key} className={badge.className ? `commons-badge ${badge.className}` : 'commons-badge'}
                      aria-label={badge.label === badge.text ? undefined : badge.label}>
                      {badge.text}
                    </span>
                  ))}
                </span>
                <span className="commons-tile__caption">{caption}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
