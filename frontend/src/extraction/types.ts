export interface PaletteEntry {
  index: number
  hex: string
  /** 0 to 1, the part of the image this color covers. */
  share: number
  is_accent: boolean
}

/** A box as fractions of the image: x, y, width, height. */
export type Box = [number, number, number, number]
export type Estimate = { value: number; estimate: true }

export interface Region {
  box: Box
  box_px: [number, number, number, number]
  role: string
  label: string
  order: number
}

export interface TextRun {
  region: string | null
  box: Box
  box_px: [number, number, number, number]
  content: string
  size_px: Estimate
  weight: string
  type_style: string
  order: number
}

export interface Gap {
  between: [string, string]
  axis: 'x' | 'y'
  px: number
  estimate: true
}

/** reader-1's own fields: each is a value with a short reason. */
export interface ReaderOne {
  summary: { value: string; why: string }
  type_style: { value: string; why: string }
  spacing_density: { value: string; why: string }
  layout: { value: string; why: string }
  composition_notes: { value: string; why: string }
  medium: { value: string; why: string }
  subject: { value: string; why: string }
  axes: Record<string, { value: number; why: string }>
  keywords: string[]
}

export interface ReadResult {
  origin: 'model'
  model: string
  prompt_version: string
  read_at: string
  reader_1: ReaderOne
  regions: Record<string, Region>
  text: Record<string, TextRun>
  spacing: { outer_margin_px: Estimate; gaps: Gap[] }
}

export interface RegionMeasure {
  box_px: number[]
  palette: PaletteEntry[]
  origin: 'code'
  from_model_box: true
}

export interface CodeGap {
  between: [string, string]
  axis: 'x' | 'y'
  px: number
  origin: 'code'
}

export type Actor = 'person' | 'agent'

export interface Correction {
  path: string
  op: 'set' | 'add' | 'remove'
  value: unknown
  actor: Actor
  at: string
  reason?: string
}

export interface Show {
  statement: string
  evidence: string[]
  origin: 'model' | Actor
  status: 'proposal'
  decision_ref: string | null
  order: number
}

export interface ReadRequest {
  actor: 'agent'
  at: string
  reason: string
}

export interface ExtractionRecord {
  id: string
  status: 'proposal' | 'approved'
  rendering: { width: number; height: number; sha256: string; phash: string }
  source: { kind: 'file' | 'paste' | 'drop'; name: string | null; size: number; read_at: string }
  structure: {
    measured: {
      palette: PaletteEntry[]
      value_range: { low: number; high: number } | null
      aspect: number
      lightness: number | null
      saturation: number | null
      /** Absent on records saved before the one lightness scale: lightness and saturation are then 0-255. */
      units?: { value_range: string; lightness: string; saturation: string }
      /** A map once a read has been made; an empty list or map before. */
      region_measures?: Record<string, RegionMeasure> | unknown[]
      region_gaps?: CodeGap[]
    }
    read: ReadResult | null
  }
  shows: Record<string, Show>
  corrections: Correction[]
  /** Absent on records saved before reads existed. */
  read_requests?: ReadRequest[]
}

/** One line of a folder's listing. A record that can't be read has only `id` and `error`. */
export interface RecordRow {
  id: string
  status?: string
  name?: string | null
  width?: number
  height?: number
  read_at?: string
  error?: string
}

export interface FolderListing {
  folder: string
  records: RecordRow[]
}

export type SourceKind = 'file' | 'paste' | 'drop'
