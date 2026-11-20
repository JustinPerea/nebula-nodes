import type { ReactNode } from 'react';

/**
 * Design: a `…` span in a chat or error line is inline code (the mono face, no line break inside),
 * without its backticks. Only a matched pair of single backticks on one line counts: an unmatched
 * backtick, an empty pair and a run of two or more backticks stay as typed. The inner text is
 * text, never markup. Text with no span is returned as the same string. A match that holds or sits
 * inside a “…” run, a GNU-style `quote', and an escaped (\`) backtick stay as typed.
 */
const SPAN = /(?<![`\\])`([^`\n]+)`(?!`)/g;
/** A GNU-style quote opens with a backtick and closes with a straight apostrophe (`a'), so it is not a span. */
const GNU_OPEN = /^[\w./~-]+'(?![A-Za-z])/;

export const CODE_SPAN_CLASS = 'code-span';

/** The “…” runs of a line: a name the person chose sits inside one, and a span never starts inside it or reaches across it. */
function quotedRuns(text: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let from = text.indexOf('“');
  while (from !== -1) {
    const to = text.indexOf('”', from + 1);
    if (to === -1) break;
    runs.push([from, to]);
    from = text.indexOf('“', to + 1);
  }
  return runs;
}

export function withCodeSpans(text: string): ReactNode {
  if (!text.includes('`')) return text;
  const runs = quotedRuns(text);
  const out: ReactNode[] = [];
  let last = 0;
  const spans = new RegExp(SPAN);
  for (let match = spans.exec(text); match; match = spans.exec(text)) {
    const at = match.index;
    const inner = match[1];
    // A match that is refused gives its opening backtick back: the next one may open a real span.
    if (/[“”]/.test(inner) || runs.some(([from, to]) => at > from && at < to) || GNU_OPEN.test(inner) || inner.endsWith('\\')) {
      spans.lastIndex = at + 1;
      continue;
    }
    if (at > last) out.push(text.slice(last, at));
    out.push(<code key={at} className={CODE_SPAN_CLASS}>{inner}</code>);
    last = at + match[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
