import type { Actor, Box, Correction, ExtractionRecord, Region } from './types'

export const ROLES = [
  'header', 'navigation', 'hero', 'heading', 'text_block', 'image', 'button', 'control', 'card', 'list',
  'logo', 'illustration', 'footer', 'background', 'other',
] as const

export const WEIGHTS = ['light', 'regular', 'medium', 'bold'] as const

export const FAKE_MODEL = 'fake-reader'

/** "text_block" as a person reads it. */
export const words = (value: string): string => value.replace(/_/g, ' ')

/** The items of an id-keyed map in the order the read gave them. */
export function inOrder<T extends { order: number }>(items: Record<string, T> | undefined): Array<[string, T]> {
  return Object.entries(items ?? {}).sort((a, b) => a[1].order - b[1].order)
}

const percent = (fraction: number) => `${Math.round(fraction * 100000) / 1000}%`

/** Where a box sits inside the rendering's frame, as percentages of it. */
export function boxPosition(box: Box): { left: string; top: string; width: string; height: string } {
  return { left: percent(box[0]), top: percent(box[1]), width: percent(box[2]), height: percent(box[3]) }
}

/** Regions largest first, so a small box (a logo inside a bar) is drawn on top and can be hovered. */
export function drawOrder(regions: Record<string, Region>): Array<[string, Region]> {
  return Object.entries(regions).sort((a, b) => b[1].box[2] * b[1].box[3] - a[1].box[2] * a[1].box[3])
}

export type OriginTag = 'code' | 'Claude' | 'fake reader' | 'you' | 'agent'

/** The tag for a value a read set: Claude, or "fake reader" when the server's development reader answered. */
export function modelTag(model: string | undefined): OriginTag {
  return model === FAKE_MODEL ? 'fake reader' : 'Claude'
}

const ACTOR_TAG: Record<Actor, OriginTag> = { person: 'you', agent: 'agent' }

/** Whether a correction's path is this path, below it or above it. */
const touches = (correction: string, path: string) =>
  correction === path || correction.startsWith(`${path}.`) || path.startsWith(`${correction}.`)

/**
 * Who set the value at `path`: the actor of the last correction that touches it, else `base`
 * ("code" for what code measured, "Claude"/"fake reader" for what a read set).
 */
export function originAt(corrections: readonly Correction[], path: string, base: OriginTag): OriginTag {
  for (let i = corrections.length - 1; i >= 0; i -= 1) {
    if (touches(corrections[i].path, path)) return ACTOR_TAG[corrections[i].actor] ?? base
  }
  return base
}

/** The tag for a show: its own origin, unless a correction changed its statement or evidence. */
export function showOrigin(record: ExtractionRecord, id: string, origin: 'model' | Actor): OriginTag {
  const base: OriginTag = origin === 'model' ? modelTag(record.structure.read?.model) : ACTOR_TAG[origin]
  return originAt(record.corrections, `shows.${id}`, base)
}

/** An evidence id is a palette entry (P3) or a region id (r2). */
export const isPaletteId = (id: string) => /^P\d+$/.test(id)

/** An axis value from -1 to 1 as the fill of a bar that starts at the middle. */
export function axisFill(value: number): { left: string; width: string } {
  const v = Math.max(-1, Math.min(1, value))
  return { left: `${v < 0 ? 50 + v * 50 : 50}%`, width: `${Math.abs(v) * 50}%` }
}
