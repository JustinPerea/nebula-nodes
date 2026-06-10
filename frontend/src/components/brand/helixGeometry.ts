/**
 * Helix Nebula (NGC 7293) — built inside-out.
 *
 * Phase 1: blue core — pale cyan center + thick dark-cobalt ring
 * (matches reference: light pupil, not dark center fading to light edge).
 */

import {
  paletteColor,
  type ColorTFn,
  type NebulaDot,
  type PaletteStop,
} from './nebulaHalftoneEngine';

export type { NebulaDot as HelixDot, PaletteStop };

const CX = 100;
const CY = 100;

/** Outer edge of the blue core zone (before orange iris in phase 2). */
const CORE_R = 34;

/**
 * Pale center → cobalt ring → soft blue edge.
 * Color t peaks in the thick dark ring, not at the boundary.
 */
export const HELIX_CORE: PaletteStop[] = [
  { t: 0.0, rgb: [250, 254, 255] },
  { t: 0.15, rgb: [220, 244, 252] },
  { t: 0.55, rgb: [72, 130, 210] },
  { t: 0.72, rgb: [48, 98, 178] },
  { t: 1.0, rgb: [150, 200, 235] },
];

export const HELIX_TRUE = HELIX_CORE;

/**
 * Density: small bright core + dominant thick circular band at mid-radius.
 */
export function helixMask(x: number, y: number, _a: number): number {
  const dx = x - CX;
  const dy = y - CY;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > CORE_R) return 0;

  const paleCore = Math.exp(-(r * r) / (2 * 4 * 4)) * 0.62;
  const darkRing = Math.exp(-((r - 18) * (r - 18)) / (2 * 10 * 10)) * 1;
  const outerSoft = Math.exp(-((r - 28) * (r - 28)) / (2 * 7 * 7)) * 0.38;
  const edge = 1 - Math.pow(Math.max(0, (r - 31) / 3), 2);

  return Math.min(1, Math.max(paleCore, darkRing, outerSoft) * edge);
}

/**
 * Lightest at center; darkest on the thick cobalt ring (~r 18).
 */
export const helixColorT: ColorTFn = (r) => {
  if (r < 7) {
    return 0.01 + (r / 7) * 0.06;
  }
  if (r < 29) {
    const ringPeak = Math.exp(-((r - 18) * (r - 18)) / (2 * 8.5 * 8.5));
    return 0.5 + ringPeak * 0.22;
  }
  return 0.22 + ((CORE_R - r) / (CORE_R - 29)) * 0.12;
};

/** Max dot radius on a square grid — 2r ≤ step so neighbors never overlap. */
function helixDotRadius(step: number, intensity: number): number {
  const minR = step * 0.14;
  const maxR = step * 0.46;
  return minR + intensity * (maxR - minR);
}

export function buildHelixDots(
  palette: PaletteStop[] = HELIX_CORE,
  step = 5,
): NebulaDot[] {
  const dots: NebulaDot[] = [];
  for (let y = 4; y < 200; y += step) {
    for (let x = 4; x < 200; x += step) {
      const dx = x - CX;
      const dy = y - CY;
      const radius = Math.sqrt(dx * dx + dy * dy);
      if (radius > CORE_R) continue;
      const angle = Math.atan2(dy, dx);
      const intensity = Math.max(0, Math.min(1, helixMask(x, y, angle)));
      if (intensity < 0.05) continue;
      const t = helixColorT(radius, x, y, angle);
      const dotR = helixDotRadius(step, intensity);
      if (dotR < step * 0.12) continue;
      dots.push({
        x,
        y,
        r: dotR,
        op: radius < 7 ? 0.55 + intensity * 0.35 : 0.62 + intensity * 0.36,
        fill: paletteColor(palette, t),
        t,
        angle,
        radius,
      });
    }
  }
  return dots;
}

export const HELIX_VIEWBOX = {
  tight: '62 62 76 76',
  loose: '0 0 200 200',
} as const;
