import type { PaletteEntry } from './types'

/** Each color's width in percent: its share of the image, scaled so the bar always fills. */
export function segmentWidths(palette: readonly PaletteEntry[]): number[] {
  const total = palette.reduce((sum, entry) => sum + Math.max(0, entry.share), 0)
  if (total <= 0) return palette.map(() => 0)
  return palette.map((entry) => (Math.max(0, entry.share) / total) * 100)
}

/** A share as a whole-number percent, "<1%" for a sliver. */
export function sharePercent(share: number): string {
  const percent = share * 100
  if (percent > 0 && percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}
