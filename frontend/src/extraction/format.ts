import { writtenDateTime } from '../lib/writtenDateTime'
import type { SourceKind } from './types'

const CAME_IN: Record<SourceKind, string> = { drop: 'Dropped', paste: 'Pasted', file: 'Chosen' }

export function cameIn(kind: SourceKind): string {
  return CAME_IN[kind] ?? 'Added'
}

export function statusLabel(status: string): string {
  return status === 'approved' ? 'Approved' : 'Proposal'
}

/** "November 20, 3:00 AM": the app's one written form for a moment (lib/writtenDateTime). */
export function readTime(iso: string): string {
  return writtenDateTime(iso)
}

export function recordCount(count: number): string {
  return count === 1 ? '1 record' : `${count} records`
}
