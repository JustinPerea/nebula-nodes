import type { OriginTag } from './read'

/** Each source's words, once. A badge reads them in sentence case; a section label's suffix reads
 *  them in lower case after the dot, unless the source is a name ("Regions · Claude"). */
const SOURCES: Record<OriginTag, { words: string; name: boolean }> = {
  code: { words: 'Code', name: false },
  Claude: { words: 'Claude', name: true },
  'fake reader': { words: 'Fake reader', name: false },
  you: { words: 'You', name: false },
  agent: { words: 'Agent', name: false },
}

export function badgeWords(tag: OriginTag): string {
  return SOURCES[tag].words
}

export function suffixWords(tag: OriginTag): string {
  const source = SOURCES[tag]
  return source.name ? source.words : source.words.toLowerCase()
}
