import '../../styles/brand.css';
import {
  buildCrabDots,
  CRAB_TRUE,
  CRAB_VIEWBOX,
  type PaletteStop,
} from './crabGeometry';

/**
 * Nebula Nodes brand mark — NN-45 Crab (M1), static.
 *
 * Halftone density rendering of the Crab supernova remnant. The dot engine
 * lives in `crabGeometry.ts` so the static and animated marks share one
 * silhouette. For the animated variant (7 motion modes) see
 * `CrabMarkAnimated`.
 *
 * Brand-surface usage only. Product UI keeps the single Slava accent
 * (#FF5A1F) — see the empty-canvas splash for the one in-product surface
 * that gets the gradient (and, now, the breathe animation).
 */

type CrabMarkProps = {
  size?: number;
  palette?: PaletteStop[];
  tight?: boolean;
  step?: number;
  className?: string;
  title?: string;
};

export function CrabMark({
  size = 200,
  palette = CRAB_TRUE,
  tight = true,
  step = 6,
  className,
  title,
}: CrabMarkProps) {
  const dots = buildCrabDots(palette, step);
  const viewBox = tight ? CRAB_VIEWBOX.tight : CRAB_VIEWBOX.loose;
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      className={['nn-crabmark', className].filter(Boolean).join(' ')}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={d.x}
          cy={d.y}
          r={d.r}
          fill={d.fill}
          opacity={d.op}
        />
      ))}
    </svg>
  );
}

export { CRAB_TRUE };
export type { PaletteStop };
