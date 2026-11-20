import type { Actor, Box, Correction, ExtractionRecord, Region, TextRun } from './types'

export const ROLES = [
  'header', 'navigation', 'hero', 'heading', 'text_block', 'image', 'button', 'control', 'card', 'list',
  'logo', 'illustration', 'footer', 'background', 'other',
] as const

export const WEIGHTS = ['light', 'regular', 'medium', 'bold'] as const

/** What a person reads for each region role and weight, typed over the lists so a new value without a label fails tsc. */
export const ROLE_LABELS: Record<(typeof ROLES)[number], string> = {
  header: 'Header', navigation: 'Navigation', hero: 'Hero', heading: 'Heading', text_block: 'Text block', image: 'Image',
  button: 'Button', control: 'Control', card: 'Card', list: 'List', logo: 'Logo', illustration: 'Illustration',
  footer: 'Footer', background: 'Background', other: 'Other',
}
export const WEIGHT_LABELS: Record<(typeof WEIGHTS)[number], string> = {
  light: 'Light', regular: 'Regular', medium: 'Medium', bold: 'Bold',
}

/** A stored value's label from one of the maps above; a value the page doesn't know reads as sentence-case words. */
export function valueLabel(labels: Record<string, string>, value: string): string {
  if (Object.prototype.hasOwnProperty.call(labels, value)) return labels[value]
  const plain = words(value)
  return plain.charAt(0).toUpperCase() + plain.slice(1)
}

export const FAKE_MODEL = 'fake-reader'

/** "text_block" as a person reads it. */
export const words = (value: string): string => value.replace(/_/g, ' ')

/** The items of an id-keyed map in the order the read gave them. */
export function inOrder<T extends { order: number }>(items: Record<string, T> | undefined): Array<[string, T]> {
  return Object.entries(items ?? {}).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
}

/** A box is four finite numbers. A region or run without one can't be drawn, so the page leaves it out. */
export const validBox = (box: unknown): box is Box =>
  Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === 'number' && Number.isFinite(n))

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The regions that can be drawn and listed: an object with a valid box and text for role and label. */
export function usableRegions(regions: Record<string, Region> | undefined): Record<string, Region> {
  const out: Record<string, Region> = {}
  for (const [id, region] of Object.entries(regions ?? {})) {
    if (isObject(region) && validBox(region.box) && typeof region.role === 'string' && typeof region.label === 'string') out[id] = region
  }
  return out
}

/** The text runs that can be listed: an object with a valid box, its words and an estimated size. */
export function usableRuns(runs: Record<string, TextRun> | undefined): Record<string, TextRun> {
  const out: Record<string, TextRun> = {}
  for (const [id, run] of Object.entries(runs ?? {})) {
    if (isObject(run) && validBox(run.box) && typeof run.content === 'string' && typeof run.weight === 'string'
      && isObject(run.size_px) && Number.isFinite(run.size_px.value)) out[id] = run
  }
  return out
}

const percent = (fraction: number) => `${Math.round(fraction * 100000) / 1000}%`

/** Where a box sits inside the rendering's frame, as percentages of it. */
export function boxPosition(box: Box): { left: string; top: string; width: string; height: string } {
  return { left: percent(box[0]), top: percent(box[1]), width: percent(box[2]), height: percent(box[3]) }
}

/** Regions largest first, so a small box (a logo inside a bar) is drawn on top and can be hovered. */
export function drawOrder(regions: Record<string, Region>): Array<[string, Region]> {
  return Object.entries(usableRegions(regions)).sort((a, b) => b[1].box[2] * b[1].box[3] - a[1].box[2] * a[1].box[3])
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
