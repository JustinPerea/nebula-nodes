/**
 * Shared halftone dot engine for Nebula Nodes marks.
 *
 * Each nebula variant supplies a mask (density 0..1 in 200×200 space) and a
 * radial palette; this module rasterizes circles on a fixed grid — same
 * pipeline as NN-45 Crab (M1).
 */

export type PaletteStop = { t: number; rgb: [number, number, number] };

export type NebulaDot = {
  x: number;
  y: number;
  r: number;
  op: number;
  fill: string;
  t: number;
  angle: number;
  radius: number;
};

export type NebulaMask = (x: number, y: number, angle: number) => number;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const lerpColor = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
) =>
  `rgb(${(lerp(a[0], b[0], t) | 0)},${(lerp(a[1], b[1], t) | 0)},${(lerp(a[2], b[2], t) | 0)})`;

/** Multi-stop gradient sampler. t is clamped to [0,1]. */
export function paletteColor(palette: PaletteStop[], tInput: number): string {
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

export type ColorTFn = (
  radius: number,
  x: number,
  y: number,
  angle: number,
) => number;

export type BuildNebulaDotsOpts = {
  mask: NebulaMask;
  palette: PaletteStop[];
  /** Palette sample 0..1. Defaults to radius / maxR. */
  colorT?: ColorTFn;
  step?: number;
  minDot?: number;
  maxDot?: number;
  rimFalloff?: number;
  maxR?: number;
};

const DEFAULTS = {
  step: 6,
  minDot: 0.35,
  maxDot: 3.1,
  rimFalloff: 0.5,
  maxR: 92,
};

export function buildNebulaDots(opts: BuildNebulaDotsOpts): NebulaDot[] {
  const {
    mask,
    palette,
    colorT,
    step = DEFAULTS.step,
    minDot = DEFAULTS.minDot,
    maxDot = DEFAULTS.maxDot,
    rimFalloff = DEFAULTS.rimFalloff,
    maxR = DEFAULTS.maxR,
  } = opts;
  const cx = 100;
  const cy = 100;
  const dots: NebulaDot[] = [];
  for (let y = 4; y < 200; y += step) {
    for (let x = 4; x < 200; x += step) {
      const dx = x - cx;
      const dy = y - cy;
      const radius = Math.sqrt(dx * dx + dy * dy);
      if (radius > maxR) continue;
      const angle = Math.atan2(dy, dx);
      const t = colorT
        ? colorT(radius, x, y, angle)
        : radius / maxR;
      const intensity = Math.max(0, Math.min(1, mask(x, y, angle)));
      if (intensity < 0.06) continue;
      const r =
        (minDot + intensity * (maxDot - minDot)) * (1 - t * rimFalloff);
      if (r < 0.4) continue;
      dots.push({
        x,
        y,
        r,
        op: 0.45 + intensity * 0.55,
        fill: paletteColor(palette, t),
        t,
        angle,
        radius,
      });
    }
  }
  return dots;
}

/** Tight viewBox crops dead gutter in the 200×200 space. */
export const NEBULA_VIEWBOX = {
  tight: '22 22 156 156',
  loose: '0 0 200 200',
} as const;
