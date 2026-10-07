import { useState } from 'react';
import { AXES, AXIS_LABELS, ROLES, type Axis, type Collection, type FilterState } from '../../lib/commonsTypes';

interface Props {
  filters: FilterState;
  collections: Collection[];
  onChange: (next: FilterState) => void;
}

const FULL: [number, number] = [-1, 1];

function AxisRange({ axis, range, onChange }: {
  axis: Axis;
  range: [number, number] | undefined;
  onChange: (range: [number, number] | undefined) => void;
}) {
  const [lowLabel, highLabel] = AXIS_LABELS[axis];
  const [lo, hi] = range ?? FULL;
  return (
    <div className={`commons-axis${range ? ' commons-axis--set' : ''}`}>
      <div className="commons-axis__head">
        <span>{lowLabel}</span>
        <span className="commons-axis__value">{range ? `${lo.toFixed(2)} … ${hi.toFixed(2)}` : 'any'}</span>
        <span>{highLabel}</span>
      </div>
      <div className="commons-axis__inputs">
        <input
          type="range" min={-1} max={1} step={0.05} value={lo}
          aria-label={`${lowLabel}–${highLabel} lower bound`}
          onChange={(event) => onChange([Math.min(Number(event.target.value), hi), hi])}
        />
        <input
          type="range" min={-1} max={1} step={0.05} value={hi}
          aria-label={`${lowLabel}–${highLabel} upper bound`}
          onChange={(event) => onChange([lo, Math.max(Number(event.target.value), lo)])}
        />
      </div>
      <button type="button" className="commons-link" disabled={!range} onClick={() => onChange(undefined)}>
        clear
      </button>
    </div>
  );
}

export function CommonsFilters({ filters, collections, onChange }: Props) {
  const [keywordDraft, setKeywordDraft] = useState('');
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });

  const setAxis = (axis: Axis, range: [number, number] | undefined) => {
    const axes = { ...filters.axes };
    if (range) axes[axis] = range;
    else delete axes[axis];
    set({ axes });
  };

  const addKeyword = () => {
    const keyword = keywordDraft.trim().toLowerCase();
    if (keyword && !filters.keywords.includes(keyword)) set({ keywords: [...filters.keywords, keyword] });
    setKeywordDraft('');
  };

  return (
    <aside className="commons-filters" aria-label="Commons filters">
      <label className="commons-field">
        Search
        <input
          type="search" value={filters.query} placeholder="calm grid, warm serif…"
          onChange={(event) => set({ query: event.target.value })}
        />
      </label>

      <fieldset className="commons-filters__group">
        <legend>Axes</legend>
        {AXES.map((axis) => (
          <AxisRange key={axis} axis={axis} range={filters.axes[axis]} onChange={(range) => setAxis(axis, range)} />
        ))}
      </fieldset>

      <fieldset className="commons-filters__group">
        <legend>Palette near</legend>
        <div className="commons-filters__row">
          <input
            aria-label="Palette hex" placeholder="#1f6feb" value={filters.paletteHex}
            onChange={(event) => set({ paletteHex: event.target.value.trim() })}
          />
          <label className="commons-field commons-field--inline">
            ΔE {filters.paletteDeltaE}
            <input
              type="range" min={1} max={10} step={1} value={filters.paletteDeltaE}
              onChange={(event) => set({ paletteDeltaE: Number(event.target.value) })}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="commons-filters__group">
        <legend>Keywords</legend>
        <div className="commons-chips">
          {filters.keywords.map((keyword) => (
            <span key={keyword} className="commons-chip">
              {keyword}
              <button
                type="button" aria-label={`Remove ${keyword}`}
                onClick={() => set({ keywords: filters.keywords.filter((k) => k !== keyword) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          aria-label="Add keyword" placeholder="Type and press Enter" value={keywordDraft}
          onChange={(event) => setKeywordDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addKeyword();
            }
          }}
        />
      </fieldset>

      <label className="commons-field">
        Collection
        <select value={filters.collection} onChange={(event) => set({ collection: event.target.value })}>
          <option value="">All collections</option>
          {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="commons-field">
        Media
        <select value={filters.media} onChange={(event) => set({ media: event.target.value as FilterState['media'] })}>
          <option value="">Any</option>
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
      </label>
      <label className="commons-field">
        Role
        <select value={filters.role} onChange={(event) => set({ role: event.target.value as FilterState['role'] })}>
          <option value="">Any (avoid hidden)</option>
          {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
      </label>
      <label className="commons-field">
        Made by
        <select value={filters.madeBy} onChange={(event) => set({ madeBy: event.target.value as FilterState['madeBy'] })}>
          <option value="">Anyone</option>
          <option value="human">Human</option>
          <option value="ai">AI</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      <label className="commons-check">
        <input type="checkbox" checked={filters.correctedOnly} onChange={(event) => set({ correctedOnly: event.target.checked })} />
        Corrected only
      </label>
      <label className="commons-check">
        <input type="checkbox" checked={filters.hasComments} onChange={(event) => set({ hasComments: event.target.checked })} />
        Has comments
      </label>
    </aside>
  );
}
