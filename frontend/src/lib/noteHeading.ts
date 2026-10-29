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

/** What comes before and after the name; the name between them is isolated
 * in a <bdi> where it's drawn (GM r33, review 18 LOW-1), so a Hebrew or Arabic
 * name keeps its "…" at its own end: “<bdi>name…</bdi>”. */
export const HEADING_START = 'Note for agents on “';
export const HEADING_END = '”';

// GM r33 (review 18 NIT-R21-1): the spaces and the separating punctuation a
// cut ends on go before the "…" ("Lighthouse…”", never "Lighthouse,…”").
// Closing brackets and quotes stay: they close something the name opened.
const CUT_TRAIL = /[\s,.;:!?·،؛、。，；：\p{Pd}\p{Ps}\p{Pi}"'«‹]+$/u;
const trimCut = (text: string) => text.replace(CUT_TRAIL, '');

/** The name as the heading shows it: whole, or its first `keep` graphemes
 * with the trailing spaces and punctuation dropped, then "…". Never a bare
 * "…" (GM r33, NIT-R21-2): a cut that would keep nothing visible keeps the
 * name's first visible grapheme. */
export function noteHeadingName(title: string, keep?: number, graphemes: string[] = graphemesOf(title)): string {
  if (keep === undefined || keep >= graphemes.length) return title;
  let kept = trimCut(graphemes.slice(0, Math.max(0, keep)).join(''));
  if (!kept) {
    const first = graphemes.findIndex((g) => trimCut(g) !== '');
    kept = first < 0 ? '' : graphemes.slice(0, first + 1).join('').trimStart();
  }
  return `${kept}…`;
}

/** The heading for a node's title, whole, or cut to its first `keep` graphemes. */
export function noteHeading(title: string, keep?: number, graphemes: string[] = graphemesOf(title)): string {
  return `${HEADING_START}${noteHeadingName(title, keep, graphemes)}${HEADING_END}`;
}

/** GM r31 nit, GM r32 (PR #200 fix rounds 21-22): the most graphemes of a
 * word a cut may drop to end on the space before it. */
export const WORD_STEP_BACK = 8;
const SPACE = /^\s+$/u;

/**
 * Where a cut after `keep` graphemes should end (GM r32, verbatim: "any name
 * with spaces between words steps back to the last space within 8
 * graphemes; scripts without spaces cut by grapheme. Key it on whether
 * there's a space before the cut, NOT on the script"). A cut inside a word
 * (the next grapheme isn't a space) ends at the last space before it when
 * that drops at most WORD_STEP_BACK graphemes of the word: "A lighthouse
 * prompt…”", Korean the same. No such space (Chinese, Japanese, Thai, one
 * long word, a space further back): the grapheme cut. The space itself goes
 * with the trailing-space trim, so none comes before the "…".
 */
export function wordCut(keep: number, graphemes: string[]): number {
  if (keep <= 0 || keep >= graphemes.length || SPACE.test(graphemes[keep])) return keep;
  for (let at = keep - 1; at > 0 && keep - (at + 1) <= WORD_STEP_BACK; at -= 1) {
    // Only to a space with something to show before it (never a bare "…").
    if (SPACE.test(graphemes[at])) return trimCut(graphemes.slice(0, at).join('')) ? at : keep;
  }
  return keep;
}

/** The longest heading for `title` that fits `available` px, as `width`
 * measures a candidate: the whole name when it fits, else the longest cut,
 * stepped back to the space before its word when that is near (wordCut). */
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
  return noteHeading(title, wordCut(low, graphemes), graphemes);
}
