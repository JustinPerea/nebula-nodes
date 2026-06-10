import '../../styles/brand.css';
import {
  buildHelixDots,
  HELIX_TRUE,
  HELIX_VIEWBOX,
  type PaletteStop,
} from './helixGeometry';

/**
 * Nebula Nodes brand mark — Helix Nebula (NGC 7293), static.
 *
 * Halftone density rendering of the “Eye of God” planetary nebula. Exploratory
 * variant alongside NN-45 Crab — same engine, different mask + palette.
 */

type HelixMarkProps = {
  size?: number;
  palette?: PaletteStop[];
  tight?: boolean;
  step?: number;
  className?: string;
  title?: string;
};

export function HelixMark({
  size = 200,
  palette = HELIX_TRUE,
  tight = true,
  step = 5,
  className,
  title,
}: HelixMarkProps) {
  const dots = buildHelixDots(palette, step);
  const viewBox = tight ? HELIX_VIEWBOX.tight : HELIX_VIEWBOX.loose;
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

export { HELIX_TRUE };
