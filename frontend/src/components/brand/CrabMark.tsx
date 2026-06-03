import '../../styles/brand.css';

/**
 * Nebula Nodes brand mark — NN-45 Crab (M1).
 *
 * Halftone density rendering of the Crab supernova remnant. Ported from the
 * Claude Design handoff bundle (Nebula Nodes Brand Guide, locked direction).
 *
 * Brand-surface usage only. Product UI keeps the single Slava accent
 * (#FF5A1F) — see the empty-canvas splash for the one in-product surface
 * that gets the gradient.
 */

const CRAB_TRUE: PaletteStop[] = [
  { t: 0.0, rgb: [180, 240, 250] },
  { t: 0.32, rgb: [120, 220, 200] },
  { t: 0.62, rgb: [240, 150, 90] },
  { t: 1.0, rgb: [120, 50, 30] },
];

export type PaletteStop = { t: number; rgb: [number, number, number] };

type CrabMarkProps = {
  size?: number;
  palette?: PaletteStop[];
  tight?: boolean;
  step?: number;
  className?: string;
  title?: string;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpColor = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
) =>
  `rgb(${(lerp(a[0], b[0], t) | 0)},${(lerp(a[1], b[1], t) | 0)},${(lerp(a[2], b[2], t) | 0)})`;

function paletteColor(palette: PaletteStop[], tInput: number): string {
  const t = Math.max(0, Math.min(1, tInput));
  for (let i = 0; i < palette.length - 1; i++) {
    const a = palette[i];
    const b = palette[i + 1];
    if (t >= a.t && t <= b.t) {
      return lerpColor(a.rgb, b.rgb, (t - a.t) / (b.t - a.t));
    }
  }
  return t < palette[0].t
    ? `rgb(${palette[0].rgb.join(',')})`
    : `rgb(${palette[palette.length - 1].rgb.join(',')})`;
}

function crabMask(x: number, y: number, _t: number, a: number): number {
  const dx = x - 100;
  const dy = y - 100;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > 92) return 0;
  const targetR = 56 + Math.cos(a * 2 + 0.4) * 9 + Math.sin(a * 5 + 1.2) * 3;
  const shellWidth = 16;
  const shell =
    Math.exp(-((r - targetR) * (r - targetR)) / (shellWidth * shellWidth)) *
    0.9;
  const interior = Math.exp((-r * r) / (2 * 34 * 34)) * 0.55;
  const angFreq = 11;
  const filIntensity = Math.pow(Math.abs(Math.cos(a * angFreq * 0.5)), 8);
  const filMask =
    filIntensity *
    Math.max(0, Math.min(1, (r - 16) / 18)) *
    Math.max(0, 1 - Math.abs(r - targetR) / 30) *
    0.55;
  const patch =
    Math.exp((-((dx + 28) * (dx + 28) + (dy + 18) * (dy + 18))) / 200) * 0.35 +
    Math.exp((-((dx - 22) * (dx - 22) + (dy - 30) * (dy - 30))) / 200) * 0.35 +
    Math.exp((-((dx + 12) * (dx + 12) + (dy - 34) * (dy - 34))) / 220) * 0.3;
  return Math.max(shell + filMask, interior, patch);
}

type Dot = { x: number; y: number; r: number; op: number; fill: string };

function buildDots(
  palette: PaletteStop[],
  step: number,
  hotCoreT: number,
  fadeEndT: number,
  minDot: number,
  maxDot: number,
  rimFalloff: number,
  maxR: number,
): Dot[] {
  const cx = 100;
  const cy = 100;
  const dots: Dot[] = [];
  for (let y = 4; y < 200; y += step) {
    for (let x = 4; x < 200; x += step) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > maxR) continue;
      const angle = Math.atan2(dy, dx);
      const t = r / maxR;
      const intensity = Math.max(0, Math.min(1, crabMask(x, y, t, angle)));
      if (intensity < 0.06) continue;
      const sz = (minDot + intensity * (maxDot - minDot)) * (1 - t * rimFalloff);
      if (sz < 0.4) continue;
      const fill = paletteColor(palette, t);
      const op = 0.45 + intensity * 0.55;
      // hotCoreT / fadeEndT are accepted for parity with the source engine
      // but the palette function already covers full t — they're no-ops here.
      void hotCoreT;
      void fadeEndT;
      dots.push({ x, y, r: sz, op, fill });
    }
  }
  return dots;
}

export function CrabMark({
  size = 200,
  palette = CRAB_TRUE,
  tight = true,
  step = 6,
  className,
  title,
}: CrabMarkProps) {
  const dots = buildDots(palette, step, 0.18, 0.55, 0.35, 3.1, 0.5, 92);
  const viewBox = tight ? '22 22 156 156' : '0 0 200 200';
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
