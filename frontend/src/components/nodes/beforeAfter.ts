/** Clamp a before/after divider position to [0, 100]; NaN falls back to 50. Pure. */
export function clampPercent(n: number): number {
  if (Number.isNaN(n)) return 50;
  return Math.max(0, Math.min(100, n));
}
