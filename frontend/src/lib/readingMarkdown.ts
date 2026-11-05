/**
 * A small, safe reader for the markdown Gemini writes in a board reading
 * (lib/boardReading.ts). Nebula has no markdown renderer and adds no package
 * for this: the reading uses headings, paragraphs, lists, bold, italics and
 * code, and that is all this understands. It makes plain data, never HTML:
 * the component draws it as React elements, so raw HTML shows as the text it
 * is, a link keeps only its words (nothing leaves Nebula), and an image keeps
 * only its alt text (nothing is loaded).
 *
 * The file names the model was sent (`tile-<id>.<ext>`, plain or in code,
 * with or without `images/`) come out as `cite` pieces, for the #N chips.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'cite'; file: string; raw: string };

export type Block =
  | { t: 'heading'; c: Inline[] }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'rule' };

const CITE = /(?:images\/)?(tile-[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif))/gi;
const CITE_WHOLE = /^(?:images\/)?(tile-[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif))$/i;
const MAX_DEPTH = 4;

/** Text with every citation split out. */
function textWithCites(text: string, out: Inline[]): void {
  let last = 0;
  for (const match of text.matchAll(CITE)) {
    const at = match.index ?? 0;
    if (at > last) push(out, { t: 'text', v: text.slice(last, at) });
    out.push({ t: 'cite', file: match[1].toLowerCase(), raw: match[0] });
    last = at + match[0].length;
  }
  if (last < text.length) push(out, { t: 'text', v: text.slice(last) });
}

function push(out: Inline[], piece: Inline): void {
  const prev = out[out.length - 1];
  if (piece.t === 'text' && prev?.t === 'text') prev.v += piece.v;
  else out.push(piece);
}

interface Rule { re: RegExp; make: (match: RegExpExecArray, depth: number) => Inline[] }

const RULES: Rule[] = [
  // Code: its text as is. A code span that is only a file name is a citation.
  { re: /`([^`\n]+)`/, make: (m) => {
    const whole = CITE_WHOLE.exec(m[1].trim());
    return whole ? [{ t: 'cite', file: whole[1].toLowerCase(), raw: m[0] }] : [{ t: 'code', v: m[1] }];
  } },
  // An image: only its alt text; nothing is loaded.
  { re: /!\[([^\]\n]*)\]\([^)\n]*\)/, make: (m, depth) => parseInline(m[1], depth + 1) },
  // A link: only its words; nothing leaves Nebula.
  { re: /\[([^\]\n]+)\]\([^)\n]*\)/, make: (m, depth) => parseInline(m[1], depth + 1) },
  // An autolink or a tag: shown as the text it is, minus the brackets of a link.
  { re: /<(https?:\/\/[^>\s]+)>/, make: (m) => [{ t: 'text', v: m[1] }] },
  { re: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/, make: (m, depth) => [{ t: 'strong', c: parseInline(m[1], depth + 1) }] },
  { re: /__(?=\S)([\s\S]+?)(?<=\S)__/, make: (m, depth) => [{ t: 'strong', c: parseInline(m[1], depth + 1) }] },
  { re: /(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/, make: (m, depth) => [{ t: 'em', c: parseInline(m[1], depth + 1) }] },
];

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    textWithCites(src, out);
    return out;
  }
  let rest = src;
  while (rest) {
    let best: { at: number; match: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of RULES) {
      const match = rule.re.exec(rest);
      if (match && (best === null || match.index < best.at)) best = { at: match.index, match, rule };
    }
    if (!best) {
      textWithCites(rest, out);
      break;
    }
    if (best.at > 0) textWithCites(rest.slice(0, best.at), out);
    for (const piece of best.rule.make(best.match, depth)) push(out, piece);
    rest = rest.slice(best.at + best.match[0].length);
  }
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE_LINE = /^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** The reading's blocks, in order. */
export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ t: 'paragraph', c: parseInline(paragraph.join(' ').trim()) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ t: 'list', ordered: list.ordered, items: list.items.map((item) => parseInline(item.trim())) });
    list = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (FENCE.test(raw)) {
        blocks.push({ t: 'paragraph', c: [{ t: 'code', v: fence.join('\n') }] });
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (FENCE.test(raw)) {
      flushParagraph();
      flushList();
      fence = [];
      continue;
    }
    const line = raw.replace(/^\s{0,3}>\s?/, '');
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (RULE_LINE.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ t: 'rule' });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ t: 'heading', c: parseInline(heading[1]) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const current = list as { ordered: boolean; items: string[] } | null;
      if (current && current.ordered !== isOrdered && !/^\s/.test(line)) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((bullet ?? ordered)![1]);
      continue;
    }
    const open = list as { ordered: boolean; items: string[] } | null;
    if (open && /^\s+/.test(raw)) {
      open.items[open.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (fence) blocks.push({ t: 'paragraph', c: [{ t: 'code', v: (fence as string[]).join('\n') }] });
  flushParagraph();
  flushList();
  return blocks;
}
