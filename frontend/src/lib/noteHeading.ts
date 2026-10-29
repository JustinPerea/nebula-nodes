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

/** GM r31 nit (PR #200 fix round 21): how far back a cut may step to the
 * start of the word it lands in. */
export const WORD_STEP_BACK = 8;
const WORDS = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
// Scripts written without spaces between words, and Hangul (CJK stays as it
// is, GM r31): a cut there stays a grapheme cut.
const UNSPACED = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

/**
 * Where a cut after `keep` graphemes should end (GM r31 nit): in a script
 * that puts spaces between words, a cut inside a word steps back to that
 * word's start when it is at most WORD_STEP_BACK graphemes back and a space
 * comes before it, so the heading reads "A lighthouse prompt…”", not "…
 * prompt wit…”". A longer word, a name of one word, CJK and emoji keep the
 * grapheme cut. Word boundaries come from Intl.Segmenter ('word').
 */
export function wordCut(title: string, keep: number, graphemes: string[] = graphemesOf(title)): number {
  if (!WORDS || keep <= 0 || keep >= graphemes.length) return keep;
  let offset = 0;
  const starts: number[] = [];
  for (const g of graphemes) { starts.push(offset); offset += g.length; }
  const cutAt = starts[keep];
  let before: { segment: string; isWordLike?: boolean } | null = null;
  for (const part of WORDS.segment(title)) {
    const end = part.index + part.segment.length;
    if (part.index < cutAt && cutAt < end) {
      // Inside this segment: a word of a spaced script, with a space before it.
      if (!part.isWordLike || UNSPACED.test(part.segment) || !before || !/^\s+$/u.test(before.segment)) return keep;
      const wordStart = starts.findIndex((at) => at >= part.index);
      return wordStart > 0 && keep - wordStart <= WORD_STEP_BACK ? wordStart : keep;
    }
    if (part.index >= cutAt) break;
    before = part;
  }
  return keep;
}

/** The longest heading for `title` that fits `available` px, as `width`
 * measures a candidate: the whole name when it fits, else the longest cut,
 * stepped back to a word's start when that is near (wordCut). */
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
  return noteHeading(title, wordCut(title, low, graphemes), graphemes);
}
