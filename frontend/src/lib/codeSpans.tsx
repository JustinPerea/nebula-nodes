import type { ReactNode } from 'react';
import { curlApostrophes } from './errorCopy';

/**
 * Design: a `…` span in a chat or error line is inline code (the mono face, no line break inside),
 * without its backticks. Only a matched pair of single backticks on one line counts: an unmatched
 * backtick, an empty pair and a run of two or more backticks stay as typed. The inner text is
 * text, never markup. Text with no span is returned as the same string. A match that holds or sits
 * inside a “…” run, a GNU-style `quote', and an escaped (\`) backtick stay as typed.
 */
const SPAN = /(?<![`\\])`([^`\n]+)`(?!`)/g;
/** A GNU-style quote opens with a backtick and closes with a straight apostrophe (`my a.png'), so it is not a span: the first apostrophe in the inner text is not followed by a letter (`don't` and `echo 'x'` are spans). */
const GNU_OPEN = /^[^']*'(?![\p{L}])/u;

export const CODE_SPAN_CLASS = 'code-span';

/** The “…” runs of a line: a name the person chose sits inside one, and a span never starts inside it or reaches across it. */
function quotedRuns(text: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let from = text.indexOf('“');
  while (from !== -1) {
    const found = text.indexOf('”', from + 1);
    // A line that was cut short leaves its “ open: the run goes to the end of the line.
    const to = found === -1 ? text.length : found;
    runs.push([from, to]);
    from = text.indexOf('“', to + 1);
  }
  return runs;
}

function splitCodeSpans(text: string): ReactNode {
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

/** An opening bracket or quote right before a span, and a closing bracket, quote, comma or full stop right after it. */
const OPENERS = /[([{“‘"']+$/;
/** A straight or curly apostrophe closes a span only when whitespace, punctuation or the end of the text follows it: "`x`'s" glues nothing, so the "s" is never split from the "'". */
const CLOSER_RUN = /^[)\]}”’"',.]+/;
function closerOf(text: string): string {
  const run = text.match(CLOSER_RUN)?.[0] ?? '';
  // A letter or digit right after the run means its last apostrophe belongs to that word ('s, 'd, n't).
  return /['’]$/.test(run) && /^[\p{L}\p{N}]/u.test(text.slice(run.length)) ? run.replace(/['’]+$/, '') : run;
}
export const CODE_GLUE_CLASS = 'code-glue';
export const CODE_GLUE_OPEN_CLASS = 'code-glue__open';
export const CODE_GLUE_CLOSE_CLASS = 'code-glue__close';

/**
 * Punctuation that touches a span stays on the span's line: the span is an inline-block, so a line may break
 * before and after it, which left "(" at the end of one line and the span at the start of the next. The touching
 * punctuation and the span go in one group (CSS: `.code-glue`, an inline-flex box no wider than its line; the
 * punctuation is its own element, because text directly inside a flex box becomes anonymous items). The span
 * shrinks to fit beside the punctuation, so a span as wide as the line wraps inside itself and keeps its "(" on
 * its first line and its ")" on its last. Text with no touching punctuation is returned as it was.
 */
function glueToSpans(parts: ReactNode): ReactNode {
  if (!Array.isArray(parts)) return parts;
  const isSpan = (part: ReactNode) => part !== undefined && typeof part !== 'string';
  const items: ReactNode[] = [...parts];
  const out: ReactNode[] = [];
  items.forEach((part, index) => {
    if (typeof part === 'string') {
      // The text a neighbouring span already took its closer from is cut at the closer.
      const before = isSpan(items[index - 1]) ? closerOf(part) : '';
      let rest = part.slice(before.length);
      const after = isSpan(items[index + 1]) ? rest.match(OPENERS)?.[0] ?? '' : '';
      rest = rest.slice(0, rest.length - after.length);
      if (rest) out.push(rest);
      return;
    }
    const prev = items[index - 1];
    const next = items[index + 1];
    let opener = '';
    if (typeof prev === 'string') {
      const rest = isSpan(items[index - 2]) ? prev.slice(closerOf(prev).length) : prev;
      opener = rest.match(OPENERS)?.[0] ?? '';
    }
    const closer = typeof next === 'string' ? closerOf(next) : '';
    if (!opener && !closer) { out.push(part); return; }
    const key = (part as { key?: string | null }).key ?? index;
    out.push(<span key={`glue-${key}`} className={CODE_GLUE_CLASS}>
        {opener ? <span className={CODE_GLUE_OPEN_CLASS}>{opener}</span> : null}
        {part}
        {closer ? <span className={CODE_GLUE_CLOSE_CLASS}>{closer}</span> : null}
      </span>);
  });
  return out;
}

export function withCodeSpans(text: string): ReactNode {
  return glueToSpans(splitCodeSpans(text));
}

const MASK = '\uE000';
/**
 * A line in `code` mode: code spans are found first, on the words as they came, and only the prose between them is curled,
 * so a span (`cmd's`) is never changed whichever way curlApostrophes would have paired the backticks.
 */
export function curledWithCodeSpans(text: string): ReactNode {
  const node = splitCodeSpans(text);
  if (typeof node === 'string') return curlApostrophes(node);
  if (!Array.isArray(node)) return node;
  // The prose is curled as one text with each span masked by a placeholder, so a '…' quote that crosses a span
  // stays protected as one quote. The placeholder is a private-use character; text that holds it is curled piece by piece.
  if (text.includes(MASK)) return glueToSpans(node.map((part) => (typeof part === 'string' ? curlApostrophes(part) : part)));
  const spans = node.filter((part) => typeof part !== 'string');
  const prose = curlApostrophes(node.map((part) => (typeof part === 'string' ? part : MASK)).join('')).split(MASK);
  const out: ReactNode[] = [];
  prose.forEach((piece, index) => {
    if (piece) out.push(piece);
    if (index < spans.length) out.push(spans[index]);
  });
  return glueToSpans(out);
}
