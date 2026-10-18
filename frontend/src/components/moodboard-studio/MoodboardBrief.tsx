import { useState } from 'react';
import type { MoodboardBrief, MoodboardPinnedColors } from '../../types';
import { BRIEF_LIMITS } from './briefLimits';

// The person's side of a board's brief (design-canvas gap 14): Direction,
// Avoid and pinned colours, plus the brief generators get and its optional
// hand-written override. The backend composes the brief
// (services/moodboard_brief.py); this file only shows and edits it.

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(value: string): string | null {
  const match = HEX_RE.exec(value.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return `#${digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits}`;
}

export function BriefPanel({
  brief,
  override,
  saving,
  busy,
  onEdit,
  onKeep,
  onRegenerate,
}: {
  brief: MoodboardBrief | null;
  override: { text: string } | null;
  saving: boolean;
  busy: boolean;
  onEdit: (text: string) => void;
  onKeep: () => void;
  onRegenerate: () => void;
}) {
  const stale = Boolean(override && brief?.override.active && brief.override.stale);
  return (
    <div className="moodboard-brief">
      <div className="moodboard-brief__head">
        <span className="moodboard-swatches__label">Brief sent to generators</span>
        <span className="moodboard-brief__source">{override?.text.trim() ? 'Written by you' : 'Generated'}</span>
      </div>
      {stale && (
        <div className="moodboard-brief__stale" role="status">
          <span>Board changed since you edited this.</span>
          <button type="button" onClick={onKeep} disabled={busy}>Keep</button>
          <button type="button" onClick={onRegenerate} disabled={busy}>Regenerate</button>
        </div>
      )}
      {override ? (
        <>
          <label className="moodboard-field">
            <span>Your brief</span>
            <textarea rows={5} value={override.text} maxLength={BRIEF_LIMITS.override}
              onChange={(event) => onEdit(event.target.value)} />
          </label>
          {!stale && (
            <button type="button" className="moodboard-brief__action" onClick={onRegenerate} disabled={busy}>
              Use the generated brief
            </button>
          )}
        </>
      ) : (
        <>
          <p className="moodboard-brief__text">
            {brief?.styleBrief || (saving ? 'Saving…' : 'Analyze to build the brief.')}
          </p>
          <button
            type="button"
            className="moodboard-brief__action"
            onClick={() => onEdit(brief?.generatedStyleBrief ?? '')}
            disabled={busy}
          >
            Write your own
          </button>
        </>
      )}
      {brief && (
        <dl className="moodboard-brief__extras">
          <dt>Negative prompt</dt>
          <dd>{brief.negativePrompt}</dd>
          {brief.avoidPrompt && (
            <>
              <dt>Added to the prompt for GPT Image, Nano Banana and Krea 2</dt>
              <dd>{brief.avoidPrompt}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

export function BriefFields({
  direction,
  avoid,
  pinnedColors,
  onChange,
}: {
  direction: string;
  avoid: string[];
  pinnedColors: MoodboardPinnedColors;
  onChange: (fields: { direction?: string; avoid?: string[]; pinnedColors?: MoodboardPinnedColors }) => void;
}) {
  const [avoidText, setAvoidText] = useState('');
  const avoidFull = avoid.length >= BRIEF_LIMITS.avoidItems;
  const addAvoid = () => {
    const items = avoidText.split(',').map((item) => item.trim().slice(0, BRIEF_LIMITS.avoidItem)).filter(Boolean);
    const known = new Set(avoid.map((item) => item.toLowerCase()));
    const next = [...avoid];
    for (const item of items) {
      if (next.length >= BRIEF_LIMITS.avoidItems) break;
      if (!known.has(item.toLowerCase())) { next.push(item); known.add(item.toLowerCase()); }
    }
    if (next.length !== avoid.length) onChange({ avoid: next });
    setAvoidText('');
  };
  return (
    <section className="moodboard-analysis moodboard-direction">
      <div className="moodboard-analysis__head">
        <div>
          <span className="moodboard-analysis__label">Direction</span>
          <span className="moodboard-analysis__hint">
            Yours to set. Analyzing again keeps it.
          </span>
        </div>
      </div>
      <div className="moodboard-analysis__body">
        <label className="moodboard-field">
          <span>What the board is for</span>
          <textarea
            rows={2}
            value={direction}
            maxLength={BRIEF_LIMITS.direction}
            placeholder="Say what you want, e.g. warm editorial product shots with soft daylight."
            onChange={(event) => onChange({ direction: event.target.value })}
          />
        </label>
        <div className="moodboard-field">
          <span>Avoid</span>
          {avoid.length > 0 && (
            <ul className="moodboard-chips" aria-label="Avoid list">
              {avoid.map((item) => (
                <li key={item} className="moodboard-chip">
                  <span>{item}</span>
                  <button type="button" aria-label={`Remove ${item}`}
                    onClick={() => onChange({ avoid: avoid.filter((other) => other !== item) })}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="moodboard-inline">
            <input
              value={avoidText}
              aria-label="Add to the avoid list"
              disabled={avoidFull}
              placeholder={avoidFull ? `The list holds ${BRIEF_LIMITS.avoidItems} items. Remove one to add another.`
                : 'Something to keep out, e.g. neon signage'}
              onChange={(event) => setAvoidText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addAvoid(); } }}
            />
            <button type="button" onClick={addAvoid} disabled={avoidFull || !avoidText.trim()}>Add</button>
          </div>
        </div>
        <PinnedColorRow
          label="Colors that must appear"
          colors={pinnedColors.include}
          other={pinnedColors.exclude}
          onChange={(include) => onChange({ pinnedColors: { ...pinnedColors, include } })}
        />
        <PinnedColorRow
          label="Colors to keep out"
          colors={pinnedColors.exclude}
          other={pinnedColors.include}
          onChange={(exclude) => onChange({ pinnedColors: { ...pinnedColors, exclude } })}
        />
      </div>
    </section>
  );
}

function PinnedColorRow({
  label,
  colors,
  other,
  onChange,
}: {
  label: string;
  colors: string[];
  other: string[];
  onChange: (colors: string[]) => void;
}) {
  const [value, setValue] = useState('');
  const hex = normalizeHex(value);
  const conflict = Boolean(hex && other.includes(hex));
  const full = colors.length >= BRIEF_LIMITS.pinned;
  const add = () => {
    if (!hex || conflict || full || colors.includes(hex)) return;
    onChange([...colors, hex]);
    setValue('');
  };
  return (
    <div className="moodboard-field">
      <span>{label}</span>
      {colors.length > 0 && (
        <ul className="moodboard-chips" aria-label={label}>
          {colors.map((color) => (
            <li key={color} className="moodboard-chip">
              <span className="moodboard-chip__swatch" style={{ backgroundColor: color }} />
              <span>{color}</span>
              <button type="button" aria-label={`Remove ${color}`}
                onClick={() => onChange(colors.filter((other) => other !== color))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="moodboard-inline">
        <input type="color" aria-label={`${label}: pick`} value={hex ?? '#000000'}
          onChange={(event) => setValue(event.target.value)} />
        <input aria-label={`${label}: hex`} value={value} placeholder="#rrggbb, or pick one" onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" onClick={add} disabled={!hex || conflict || full || colors.includes(hex)}>Add</button>
      </div>
      {conflict && <span className="moodboard-inline__error">That color is in the other list.</span>}
      {full && <span className="moodboard-inline__error">This list holds {BRIEF_LIMITS.pinned} colors. Remove one to add another.</span>}
    </div>
  );
}

