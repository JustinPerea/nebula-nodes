import { useId } from 'react';
import type { MoodboardAnalysis, MoodboardClash, MoodboardColor } from '../../types';
import { formatShare, hasSources, sourcesLabel } from './colorSources';

/** The board's palette or accents: each colour with its share of the board
 *  and the images it comes from, the full list on hover or focus. An
 *  analysis saved before sources existed shows the colours alone.
 *  `leftOut` (the brief's, gap 18) dims the colours generators don't get,
 *  with the reason in the tooltip. The backend decides; this only shows. */
export function BoardSwatches({ label, role, analysis, leftOut }: {
  label: string;
  role: MoodboardColor['role'];
  analysis: MoodboardAnalysis;
  leftOut?: MoodboardClash[];
}) {
  // A saved analysis is stored JSON (an agent can create a board with one), so
  // a list may be missing: show nothing rather than fail the whole Studio.
  const hexes = (role === 'dominant' ? analysis.palette : analysis.accents) ?? [];
  if (hexes.length === 0) return null;
  const colors = (analysis.colors ?? []).filter((color) => color.role === role);
  const briefRole = role === 'dominant' ? 'palette' : 'accent';
  const reasons = new Map((leftOut ?? []).filter((item) => item.hex && item.role === briefRole)
    .map((item) => [item.hex!.toLowerCase(), item.reason]));
  return (
    <div className="moodboard-swatches">
      <span className="moodboard-swatches__label">{label}</span>
      {colors.length > 0 ? (
        <ul className="moodboard-colors" aria-label={label}>
          {colors.map((color) => <BoardColor key={color.hex} color={color} leftOut={reasons.get(color.hex.toLowerCase())} />)}
        </ul>
      ) : (
        <div className="moodboard-palette" role="list" aria-label={label}>
          {hexes.map((hex) => {
            const reason = reasons.get(hex.toLowerCase());
            return (
              <span key={hex} role="listitem"
                className={`moodboard-palette__swatch${reason !== undefined ? ' moodboard-color--left-out' : ''}`}
                style={{ backgroundColor: hex }}
                title={reason !== undefined ? `${hex} · ${leftOutTitle(reason)}` : hex} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function leftOutTitle(reason: string): string {
  return reason ? `Left out of the brief: ${reason}` : 'Left out of the brief';
}

function BoardColor({ color, leftOut }: { color: MoodboardColor; leftOut?: string }) {
  const detailId = useId();
  const sources = color.sources;
  const isLeftOut = leftOut !== undefined;
  return (
    <li className={`moodboard-color${isLeftOut ? ' moodboard-color--left-out' : ''}`}
      title={isLeftOut ? leftOutTitle(leftOut) : undefined}
      tabIndex={sources?.length ? 0 : undefined}
      aria-describedby={sources?.length ? detailId : undefined}>
      <span className="moodboard-color__swatch" style={{ backgroundColor: color.hex }} aria-hidden="true" />
      <span className="moodboard-color__hex">{color.hex}</span>
      <span className="moodboard-color__share">{formatShare(color.share)}</span>
      {isLeftOut && <span className="moodboard-color__flag">Left out</span>}
      {sources?.length ? (
        <>
          <span className="moodboard-color__sources">{sourcesLabel(color)}</span>
          <span className="moodboard-color__detail" id={detailId} role="tooltip">
            {sources.map((source) => (
              <span key={source.number} className="moodboard-color__detail-row">
                <span>Image #{source.number}</span>
                <span>{formatShare(source.share)} of the image</span>
                <span>{formatShare(source.contribution)} of the board</span>
              </span>
            ))}
          </span>
        </>
      ) : null}
    </li>
  );
}

/** The note under the board swatches for an analysis without sources. */
export function SourcesOutdated({ analysis }: { analysis: MoodboardAnalysis }) {
  if (hasSources(analysis) || ((analysis.palette ?? []).length === 0 && (analysis.accents ?? []).length === 0)) return null;
  return (
    <div className="moodboard-colors__hint">Analyze again to see which images each color comes from.</div>
  );
}

/** One image's own colours, for its card: small swatches with their share
 *  of the image. Nothing until the board is analyzed, or for an image the
 *  analysis couldn't read. A set-aside image shows its colours too (analysis
 *  version 5 on); an older analysis has none for it. */
export function ImageColors({ analysis, imageId }: { analysis: MoodboardAnalysis | null; imageId: string }) {
  const item = analysis?.images?.find((image) => image.id === imageId);
  const colors = item?.colors ?? [];
  if (colors.length === 0) return null;
  return (
    <ul className="moodboard-image-colors" aria-label="Colors in this image">
      {colors.map((color) => (
        <li key={`${color.hex}-${color.accent ? 'a' : 'd'}`}
          className={`moodboard-image-colors__item${color.accent ? ' moodboard-image-colors__item--accent' : ''}`}
          title={`${color.hex} · ${formatShare(color.share)} of this image${color.accent ? ' · accent' : ''}`}>
          <span className="moodboard-image-colors__swatch" style={{ backgroundColor: color.hex }} aria-hidden="true" />
          <span>{formatShare(color.share)}</span>
        </li>
      ))}
    </ul>
  );
}
