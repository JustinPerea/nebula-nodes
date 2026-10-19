import type { MoodboardAnalysis, MoodboardColor } from '../../types';

/** A share (0 to 1) as a percentage, with a decimal or two for small ones. */
export function formatShare(share: number): string {
  const value = share * 100;
  if (!Number.isFinite(value)) return '?';
  if (value >= 10 || value === 0) return `${Math.round(value)}%`;
  return value >= 1 ? `${value.toFixed(1)}%` : `${value.toFixed(2)}%`;
}

/** "#3, #7 +2": the first two source images, then how many more. */
export function sourcesLabel(color: MoodboardColor, shown = 2): string {
  const sources = color.sources ?? [];
  const head = sources.slice(0, shown).map((source) => `#${source.number}`).join(', ');
  return sources.length > shown ? `${head} +${sources.length - shown}` : head;
}

/** Whether every board colour lists its sources (analysis version 4 on). */
export function hasSources(analysis: MoodboardAnalysis): boolean {
  const colors = analysis.colors ?? [];
  return colors.length > 0 && colors.every((color) => Array.isArray(color.sources));
}
