import type { RecordDetail } from './api'

/** The detail to show after an answer for `next` arrives: it replaces the current one only when its
 * record is still the selected one. A read or a correction can finish after the person has opened
 * another record, and its answer must not take that record's place. */
export function acceptDetail(current: RecordDetail | null, next: RecordDetail, selectedId: string | null): RecordDetail | null {
  return next.record.id === selectedId ? next : current
}
