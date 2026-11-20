import type { SourceKind } from './types'

const CAME_IN: Record<SourceKind, string> = { drop: 'Dropped', paste: 'Pasted', file: 'Chosen' }

export function cameIn(kind: SourceKind): string {
  return CAME_IN[kind] ?? 'Added'
}

export function statusLabel(status: string): string {
  return status === 'approved' ? 'Approved' : 'Proposal'
}

export function readTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function recordCount(count: number): string {
  return count === 1 ? '1 record' : `${count} records`
}
