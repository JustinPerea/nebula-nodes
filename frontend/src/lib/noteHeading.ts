/**
 * GM r29 item 1 and GM r30 item 1 (PR #200 fix round 20): the note dialog's
 * heading names its node, "Note for agents on “Text Input”". A name too long
 * for one line is cut inside the quotes, by grapheme (never inside an emoji,
 * a flag or a syllable), with no space before the "…" and the closing quote
 * kept outside the cut: "Note for agents on “A lighthouse prompt with…”".
 * The full name stays in the tooltip.
 */
const SEGMENTER = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** The characters of `text` as a person sees them (extended grapheme clusters). */
export function graphemesOf(text: string): string[] {
  return SEGMENTER ? Array.from(SEGMENTER.segment(text), (part) => part.segment) : Array.from(text);
}

/** The heading for a node's title, whole, or cut to its first `keep` graphemes. */
export function noteHeading(title: string, keep?: number, graphemes: string[] = graphemesOf(title)): string {
  if (keep === undefined || keep >= graphemes.length) return `Note for agents on “${title}”`;
  return `Note for agents on “${graphemes.slice(0, Math.max(0, keep)).join('').trimEnd()}…”`;
}

/** The longest heading for `title` that fits `available` px, as `width`
 * measures a candidate: the whole name when it fits, else the longest cut. */
export function fitNoteHeading(title: string, available: number, width: (text: string) => number): string {
  const whole = noteHeading(title);
  if (width(whole) <= available) return whole;
  const graphemes = graphemesOf(title);
  let low = 0;
  let high = graphemes.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (width(noteHeading(title, mid, graphemes)) <= available) low = mid; else high = mid - 1;
  }
  return noteHeading(title, low, graphemes);
}
