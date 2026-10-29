// Review 11 LOW-1 and NIT-1 of PR #200: a capped field cuts only what was
// typed or pasted, where it went in (PromptDialog's `fit`).
/**
 * The edit from `previous` to `typed` (the caret at `end` in `typed`) with
 * only its inserted span cut, by whole code points, to the longest start that
 * `fits`; null when even none of it fits. A count can drop as a span grows
 * (an escape code counts nothing once whole), so past the longest start a
 * search finds, a few more are tried and the longest that fits wins
 * (review 11 NIT-1: never a cut inside an escape code that a longer start
 * keeps whole).
 */
export function fitEdit(previous: string, typed: string, end: number, fits: (text: string) => boolean): { text: string; caret: number } | null {
  const tail = typed.slice(end);
  let start = 0;
  const headRoom = Math.min(end, previous.length - tail.length);
  while (start < headRoom && previous[start] === typed[start]) start += 1;
  // Never split a surrogate pair at the edit's start.
  if (start > 0 && /[\uD800-\uDBFF]/.test(typed[start - 1])) start -= 1;
  const head = typed.slice(0, start);
  const points = Array.from(typed.slice(start, end));
  const build = (k: number) => head + points.slice(0, k).join('') + tail;
  if (!fits(build(0))) return null;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(build(mid))) low = mid; else high = mid - 1;
  }
  for (let k = low + 1; k <= Math.min(points.length, low + LOOK_PAST); k += 1) if (fits(build(k))) low = k;
  const kept = points.slice(0, low).join('');
  return { text: head + kept + tail, caret: head.length + kept.length };
}

/** How many code points past a search's answer are tried (the longest
 * terminal escape code a note can hold whole is shorter). */
const LOOK_PAST = 64;
