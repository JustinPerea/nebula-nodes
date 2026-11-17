/**
 * Design: no accent bar down the left edge. One reader for "does this declaration draw a bar on
 * the left edge", shared by the stylesheet ratchet (noLeftBar.ratchet.test.ts) and the cascade
 * helper (lineLook.leftBar). A width is decided by where its token sits in the value, never by a
 * custom property's name: a var() or calc() in the width position is a bar unless another token
 * in the same value already gives a width of 1px or less.
 */

/** Split on whitespace outside parentheses. */
export function tokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Split on commas outside parentheses. */
export function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const STYLE = /^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/i;
const FN = /^(var|calc|min|max|clamp)\(/i;
const clean = (value: string) => value.trim().replace(/\s*!important$/i, '').trim();

/** The px width a token gives, or null when it is not a width token. Infinity: a width that can't be read. */
function lengthOf(token: string): number | null {
  const t = token.toLowerCase();
  if (t === 'thin') return 1;
  if (t === 'medium') return 3;
  if (t === 'thick') return 5;
  if (/^(initial|unset|inherit|revert)$/.test(t)) return 0;
  const m = t.match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt|ch|vw|vh|%)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 0) return 0;
  if (m[2] === 'px') return n;
  if (m[2] === 'rem' || m[2] === 'em') return n * 16;
  if (m[2] === 'pt') return (n * 4) / 3;
  return Infinity;
}

/** The width of a lone width value (`border-left-width`, one `border-width` value). */
export function widthOf(value: string): number {
  const t = tokens(clean(value));
  if (t.length === 0) return 0;
  if (FN.test(t[0])) return Infinity;
  return lengthOf(t[0]) ?? 0;
}

/** The width a `border-left` shorthand gives, read by token position. */
export function shorthandWidth(value: string): number {
  const t = tokens(clean(value));
  if (t.some((token) => /^(none|hidden)$/i.test(token))) return 0;
  const lengths = t.map(lengthOf).filter((n): n is number => n !== null);
  if (lengths.length) return Math.max(...lengths);
  const fn = t.findIndex((token) => FN.test(token));
  const style = t.findIndex((token) => STYLE.test(token));
  if (fn !== -1 && (style === -1 || fn < style)) return Infinity;
  if (style !== -1) return 3;
  return 0;
}

/** The left value of a `border-width` of one to four values, and whether all four sides match (a full frame, not a bar). */
function leftOfWidths(value: string): { left: number; frame: boolean } {
  const t = tokens(clean(value));
  if (t.length === 0) return { left: 0, frame: true };
  const [top, right = top, bottom = top, left = right] = t;
  const w = [top, right, bottom, left].map((token) => (FN.test(token) ? Infinity : lengthOf(token) ?? 0));
  return { left: w[3], frame: [top, right, bottom, left].every((token) => token === left) };
}

/** An inset shadow with a horizontal offset of 2px or more and no vertical one (a bar painted inside the box). */
function shadowIsBar(shadow: string): boolean {
  const t = tokens(clean(shadow));
  if (!t.some((token) => token.toLowerCase() === 'inset')) return false;
  const nums = t.filter((token) => !FN.test(token)).map(lengthOf).filter((n): n is number => n !== null);
  return nums.length >= 2 && Math.abs(nums[0]) >= 2 && nums[1] === 0;
}

/** Custom property name -> every value any stylesheet gives it. */
export type Vars = Map<string, string[]>;
export function collectVars(sources: string[]): Vars {
  const vars: Vars = new Map();
  for (const source of sources) {
    for (const m of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
      vars.set(m[1], [...(vars.get(m[1]) ?? []), m[2].trim()]);
    }
  }
  return vars;
}

function shadowsAreBar(value: string, vars: Vars | undefined, seen: Set<string>): boolean {
  return splitTop(clean(value)).some((shadow) => {
    const ref = shadow.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
    if (ref) {
      if (!vars || seen.has(ref[1])) return false;
      return (vars.get(ref[1]) ?? []).some((def) => shadowsAreBar(def, vars, new Set([...seen, ref[1]])));
    }
    return shadowIsBar(shadow);
  });
}

/** Whether one declaration (property and value) draws a bar on the left edge. */
export function declIsBar(prop: string, value: string, vars?: Vars): boolean {
  const p = prop.trim().toLowerCase();
  if (p === 'border-left' || p === 'border-inline-start') return shorthandWidth(value) > 1;
  if (p === 'border-left-width' || p === 'border-inline-start-width') return widthOf(value) > 1;
  if (p === 'border-width') { const { left, frame } = leftOfWidths(value); return left > 1 && !frame; }
  if (p === 'box-shadow') return shadowsAreBar(value, vars, new Set());
  return false;
}
