export interface PaletteEntry {
  index: number
  hex: string
  /** 0 to 1, the part of the image this color covers. */
  share: number
  is_accent: boolean
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
    }
    read: unknown
  }
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
