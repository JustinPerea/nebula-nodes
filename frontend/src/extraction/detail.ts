import type { RecordDetail } from './api'

/** A record as the page opened it: the folder and the id. Ids are image hashes, so the same image in two
 * folders has one id; only the pair says which record an answer is for. */
export interface Opened {
  folder: string
  id: string
}

/** The detail to show after an answer arrives: it replaces the current one only when the record it was
 * asked for (`from`, captured when the read or correction started) is still the one open (`now`). A read or
 * a correction can finish after the person has opened another record, or the same id in another folder,
 * and its answer must not take that record's place. */
export function acceptDetail(current: RecordDetail | null, next: RecordDetail, from: Opened, now: Opened | null): RecordDetail | null {
  const same = now !== null && from.folder === now.folder && from.id === now.id
  return same && next.record.id === from.id ? next : current
}
