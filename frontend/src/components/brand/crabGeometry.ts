/**
 * Nebula Nodes brand mark — NN-45 Crab (M1) halftone geometry.
 *
 * Single source of truth for the Crab dot engine, shared by the static
 * `CrabMark` and the animated `CrabMarkAnimated`. Both render the *same*
 * dot field — the animated version just mutates the dots' SVG attributes
 * on a RAF loop.
 *
 * Ported from the Claude Design handoff bundle (Nebula Nodes locked
 * direction: NN-45 Crab × crab-true palette).
 */

import {
  buildNebulaDots,
  NEBULA_VIEWBOX,
  paletteColor,
  type NebulaDot,
  type PaletteStop,
} from './nebulaHalftoneEngine';

export type { PaletteStop };
export type CrabDot = NebulaDot;
export { paletteColor };

/** crab-true: pale-blue interior → teal → warm-orange filaments → deep
 *  red-brown void. Sampled from the M1 reference, not invented. */
export const CRAB_TRUE: PaletteStop[] = [
  { t: 0.0, rgb: [180, 240, 250] },
  { t: 0.32, rgb: [120, 220, 200] },
  { t: 0.62, rgb: [240, 150, 90] },
  { t: 1.0, rgb: [120, 50, 30] },
];

/**
 * Crab mask — density (0..1) at a point in the 200×200 design space.
 * shell (the supernova remnant's expanding shell) + interior glow +
 * radial filaments + a few off-center brightness patches.
 */
export function crabMask(x: number, y: number, a: number): number {
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

export function buildCrabDots(
  palette: PaletteStop[] = CRAB_TRUE,
  step = 6,
): CrabDot[] {
  return buildNebulaDots({ mask: crabMask, palette, step });
}

export const CRAB_VIEWBOX = NEBULA_VIEWBOX;
