import { useMemo } from 'react';
import { backendAssetUrlSync } from '../../lib/backend';
import { moodboardMeta, moodboardStatus, parseMoodboardBundle } from '../../lib/moodboardBundle';
import { CopyValueButton, ExpandableBlock } from './ExpandableBlock';
import { OverviewImage } from './OverviewImage';
import '../../styles/moodboard-swatches.css';
import '../../styles/structured-preview.css';

export type StructuredVariant = 'card' | 'full';

const LIMITS = {
  card: { thumbnails: 4, swatches: 12 },
  full: { thumbnails: 12, swatches: 40 },
} as const;

/**
 * A Moodboard bundle as a generator gets it (handlers/moodboard.py): the
 * board's name and settings, a few of its images, the brief's palette and
 * accents (kept-out colours already gone), the style brief and what else the
 * run sent. `full` (the Inspector) shows more images and the whole brief.
 */
export function MoodboardBundlePreview({ value, variant = 'card' }: { value: unknown; variant?: StructuredVariant }) {
  const bundle = useMemo(() => parseMoodboardBundle(value), [value]);
  if (!bundle) return null;
  const limits = LIMITS[variant];
  const shown = bundle.thumbnails.slice(0, limits.thumbnails);
  const more = bundle.thumbnails.length - shown.length;
  const status = moodboardStatus(bundle);

  return (
    <div className={`structured-preview structured-preview--moodboard structured-preview--${variant}`}
      role="group" aria-label={`Moodboard ${bundle.name}`}>
      <div className="structured-preview__head">
        <span className="structured-preview__title">{bundle.name}</span>
        <span className="structured-preview__meta">{moodboardMeta(bundle)}</span>
      </div>

      {shown.length > 0 && (
        <div className={`structured-preview__thumbs structured-preview__thumbs--${Math.min(shown.length, 4)}`}>
          {shown.map((url, index) => (
            <span key={url} className="structured-preview__thumb">
              <OverviewImage src={backendAssetUrlSync(url)} alt={`Board image ${index + 1}`}
                loading="lazy" draggable={false} />
              {more > 0 && index === shown.length - 1 && (
                <span className="structured-preview__thumb-more" aria-label={`${more} more images`}>+{more}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {(bundle.palette.length > 0 || bundle.accents.length > 0) && (
        <div className="structured-preview__swatch-rows">
          <SwatchRow label="Palette" colors={bundle.palette} limit={limits.swatches} />
          <SwatchRow label="Accents" colors={bundle.accents} limit={limits.swatches} />
        </div>
      )}

      {bundle.styleBrief ? (
        <ExpandableBlock lines={4} contentKey={bundle.styleBrief} longHint={bundle.styleBrief.length > 220}
          collapsible={variant === 'card'} className="structured-preview__brief-block">
          <p className="structured-preview__brief">{bundle.styleBrief}</p>
        </ExpandableBlock>
      ) : (
        <p className="structured-preview__empty">Analyze the board to build its brief</p>
      )}

      <p className="structured-preview__status" role="status">
        {status.map((item) => <span key={item} className="structured-preview__status-item">{item}</span>)}
      </p>

      {variant === 'full' && bundle.styleBrief && (
        <div className="structured-preview__actions">
          <CopyValueButton text={() => bundle.styleBrief} label="Copy brief" />
        </div>
      )}
    </div>
  );
}

/** One row of colour chips, the Studio's swatch look at card size. */
export function SwatchRow({ label, colors, limit }: { label: string; colors: string[]; limit: number }) {
  if (colors.length === 0) return null;
  const shown = colors.slice(0, limit);
  return (
    <div className="structured-preview__swatch-row">
      <span className="moodboard-swatches__label structured-preview__swatch-label">{label}</span>
      <div className="moodboard-palette structured-preview__swatches" role="list" aria-label={label}>
        {shown.map((hex, index) => (
          <span key={`${hex}-${index}`} role="listitem" title={hex}
            className="moodboard-palette__swatch structured-preview__swatch" style={{ backgroundColor: hex }} />
        ))}
        {colors.length > shown.length && (
          <span className="structured-preview__swatch-more">+{colors.length - shown.length}</span>
        )}
      </div>
    </div>
  );
}
