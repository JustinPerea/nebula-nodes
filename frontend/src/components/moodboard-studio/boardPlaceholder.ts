/**
 * Placeholder tiles on the Board view (GM, #210 r4 answer 1 and r5): a spot
 * held for a tile still on its way. Today that is a file uploading; a pasted
 * link being fetched (its own PR) will use the same shape, labelled with its
 * host, which is why the label is a typed source and not a string.
 */

/** What a placeholder is waiting for, which says what its label reads. */
export type PlaceholderSource =
  | { kind: 'file'; name: string }
  | { kind: 'link'; host: string };

/** A spot held on the board: where it sits and its size, in board pixels.
 *  Drawn, counted by placement, never moved or saved. `filled` is the image
 *  that has just taken the spot: it fades in over the placeholder on the
 *  board's spring, and the placeholder goes once it has. */
export interface BoardPlaceholder {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source: PlaceholderSource;
  filled?: string;
}

/** The most characters (grapheme clusters) a label shows before its ellipsis. */
export const PLACEHOLDER_LABEL_MAX = 32;

/** `text` cut to `max` grapheme clusters with an ellipsis, never inside a
 *  cluster (an emoji, a flag, a letter and its accents stay whole). */
export function clipGraphemes(text: string, max = PLACEHOLDER_LABEL_MAX): string {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => {
    segment: (input: string) => Iterable<{ segment: string }> } }).Segmenter;
  const clusters = Segmenter ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment)
    : Array.from(text);
  return clusters.length <= max ? text : `${clusters.slice(0, max - 1).join('')}…`;
}

/** The label in a placeholder's top-left corner: the file's name, or a link's host. */
export function placeholderLabel(source: PlaceholderSource): string {
  return clipGraphemes(source.kind === 'file' ? source.name : source.host);
}
