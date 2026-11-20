const ELLIPSIS = '…';

/** The text with trailing spaces and , ; : dropped, so nothing dangles before the ellipsis. */
const trimTail = (text: string) => text.replace(/[\s,;:]+$/, '');

/** Largest n in [lo, hi] for which ok(n) holds, assuming ok is true up to some point and false
 * after it. Returns lo - 1 when none does. */
function largest(lo: number, hi: number, ok: (n: number) => boolean): number {
  let low = lo;
  let high = hi;
  let best = lo - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ok(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * The text to show when it may not fit. `fits(candidate)` reports whether a candidate string fits
 * the space it is shown in. The whole text is returned when it fits; otherwise the longest prefix
 * that ends at a word boundary, trailing spaces and , ; : trimmed, followed by U+2026. A first
 * word too long for the space is cut by characters instead.
 */
export function cutToFit(input: string, fits: (candidate: string) => boolean): string {
  const text = input.trim();
  if (!text || fits(text)) return text;
  const withEllipsis = (prefix: string) => `${trimTail(prefix)}${ELLIPSIS}`;

  // Each word end before the last one is a place to cut.
  const ends: number[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end < text.length) ends.push(end);
  }
  const wordIndex = largest(0, ends.length - 1, (i) => fits(withEllipsis(text.slice(0, ends[i]))));
  if (wordIndex >= 0) return withEllipsis(text.slice(0, ends[wordIndex]));

  // Never end on half a surrogate pair: step back past a lone high surrogate.
  const prefix = (n: number) => {
    const code = text.charCodeAt(n - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
  };
  const chars = largest(1, text.length - 1, (n) => fits(withEllipsis(prefix(n))));
  return chars >= 1 && prefix(chars) ? withEllipsis(prefix(chars)) : ELLIPSIS;
}
