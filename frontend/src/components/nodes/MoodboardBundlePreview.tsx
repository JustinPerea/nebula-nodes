import { useMemo } from 'react';
import { storedImageView } from '../../lib/storedImage';
import {
  moodboardLeftOut,
  moodboardMeta,
  moodboardStatus,
  parseMoodboardBundle,
  type MoodboardBundleClash,
  type MoodboardBundleView,
} from '../../lib/moodboardBundle';
import { thumbnailLoading } from '../../lib/structuredValue';
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
 * run sent. `full` (the Inspector) shows more images, the whole brief and
 * which colours were left out or may clash, with why; a card only counts them.
 */
export function MoodboardBundlePreview({ value, variant = 'card' }: { value: unknown; variant?: StructuredVariant }) {
  const bundle = useMemo(() => parseMoodboardBundle(value), [value]);
  if (!bundle) return null;
  const limits = LIMITS[variant];
  // Only Nebula's own files are drawn (lib/storedImage.ts): a run saved
  // before Q98 may name an old board's link to another site.
  const drawable = bundle.thumbnails.flatMap((url) => storedImageView(url).src ?? []);
  const shown = drawable.slice(0, limits.thumbnails);
  const more = drawable.length - shown.length;
  const status = moodboardStatus(bundle);

  return (
    <div className={`structured-preview structured-preview--moodboard structured-preview--${variant}`}
      role="group" aria-label={`Moodboard ${bundle.name}`}>
      <div className="structured-preview__head">
        <span className="structured-preview__title" title={bundle.name}>{bundle.name}</span>
        <span className="structured-preview__meta">{moodboardMeta(bundle)}</span>
      </div>

      {shown.length > 0 && (
        <div className={`structured-preview__thumbs structured-preview__thumbs--${Math.min(shown.length, 4)}`}>
          {shown.map((url, index) => (
            <span key={url} className="structured-preview__thumb">
              <OverviewImage src={url} alt={`Board image ${index + 1}`}
                loading={thumbnailLoading(variant)} draggable={false} />
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

      {variant === 'full' && bundle.clashChecked && <BundleClashes bundle={bundle} limit={limits.swatches} />}

      {bundle.styleBrief ? (
        <ExpandableBlock lines={4} contentKey={bundle.styleBrief} longHint={bundle.styleBrief.length > 220}
          collapsible={variant === 'card'} className="structured-preview__brief-block"
          label={`brief of ${bundle.name}`}>
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

/** The colours the brief left out or flagged, as rows of chips with the
 *  reasons listed under each (the Studio's "Left out of the brief", "May
 *  clash" and "Pinned, so it still goes" lists, read-only). */
function BundleClashes({ bundle, limit }: { bundle: MoodboardBundleView; limit: number }) {
  const flagged = bundle.clashMode === 'flag';
  const groups = [
    { label: 'Left out', reasonsLabel: 'Why these are left out', items: moodboardLeftOut(bundle) },
    { label: flagged ? 'Flagged' : 'May clash', reasonsLabel: flagged ? 'Why these are flagged' : 'Why these may clash',
      items: bundle.mayClash },
    { label: 'Pinned', reasonsLabel: 'Why these pinned colors clash', items: bundle.pinnedClashes },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0 && bundle.paletteClashes.length === 0) return null;
  return (
    <div className="structured-preview__clashes">
      {groups.map((group) => {
        const lines = group.items.map(clashLine);
        // As many reasons as chips, so no chip's reason is hover-only.
        const shown = lines.slice(0, limit);
        return (
          <div key={group.label} className="structured-preview__clash-group">
            <SwatchRow label={group.label} colors={group.items.map((item) => item.hex ?? '')} titles={lines} limit={limit} />
            <ul className="structured-preview__list structured-preview__reasons" aria-label={group.reasonsLabel}>
              {shown.map((line, index) => (
                <li key={`${line}-${index}`} className="structured-preview__item structured-preview__reason">{line}</li>
              ))}
              {lines.length > shown.length && (
                <li className="structured-preview__item structured-preview__item--more">+{lines.length - shown.length} more</li>
              )}
            </ul>
          </div>
        );
      })}
      {bundle.paletteClashes.map((item, index) => (
        <p key={index} className="structured-preview__note">Whole palette: {item.reasons.join(' · ')}</p>
      ))}
    </div>
  );
}

/** "#a6392d accent: Avoid: red flowers · Direction: silver", as the Studio
 *  reads a clash (hex, palette/accent, every reason). */
function clashLine(item: MoodboardBundleClash): string {
  const head = item.role ? `${item.hex} ${item.role}` : `${item.hex}`;
  return item.reasons.length ? `${head}: ${item.reasons.join(' · ')}` : head;
}

/** One row of colour chips, the Studio's swatch look at card size. `titles`
 *  (one per colour) replace the hex as each chip's tooltip. */
export function SwatchRow({ label, colors, titles, limit }: {
  label: string;
  colors: string[];
  titles?: string[];
  limit: number;
}) {
  if (colors.length === 0) return null;
  const shown = colors.slice(0, limit);
  return (
    <div className="structured-preview__swatch-row">
      <span className="moodboard-swatches__label structured-preview__swatch-label">{label}</span>
      <div className="moodboard-palette structured-preview__swatches" role="list" aria-label={label}>
        {shown.map((hex, index) => (
          <span key={`${hex}-${index}`} role="listitem" title={titles?.[index] ?? hex}
            className="moodboard-palette__swatch structured-preview__swatch" style={{ backgroundColor: hex }} />
        ))}
        {colors.length > shown.length && (
          <span className="structured-preview__swatch-more">+{colors.length - shown.length}</span>
        )}
      </div>
    </div>
  );
}
