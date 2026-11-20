import type { ReactNode } from 'react';

/**
 * Design: a `…` span in a chat or error line is inline code (the mono face, no line break inside),
 * without its backticks. Only a matched pair of single backticks on one line counts: an unmatched
 * backtick, an empty pair and a run of two or more backticks stay as typed. The inner text is
 * text, never markup. Text with no span is returned as the same string.
 */
const SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;

export const CODE_SPAN_CLASS = 'code-span';

export function withCodeSpans(text: string): ReactNode {
  if (!text.includes('`')) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(SPAN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(<code key={at} className={CODE_SPAN_CLASS}>{match[1]}</code>);
    last = at + match[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
