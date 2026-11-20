import { stripComments } from './css-scan.mjs';

// The value reader the left-edge checks share (scripts/check-left-edge.mjs and the stylesheet
// ratchet in tests/noLeftBar.ratchet.test.ts): the custom properties a stylesheet defines,
// var() resolved through them, and a length read down to px (calc() of readable terms too).
// A value it can't read is null, never a guess from a property's name.

/** Split on whitespace outside parentheses. */
export function tokens(value) {
  return splitOutside(value.trim(), /\s/);
}

/** Split on commas outside parentheses. */
export function splitTop(value) {
  return splitOutside(value, /,/, true);
}

function splitOutside(value, separator, keepEmpty = false) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && separator.test(char)) {
      if (current || keepEmpty) out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current || keepEmpty) out.push(current);
  return out;
}

/** Custom property name -> every value any of the given stylesheets gives it (all definitions, any selector). */
export function collectVars(sources) {
  const vars = new Map();
  for (const source of sources) {
    for (const match of stripComments(source).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
      const value = match[2].replace(/\s*!important\s*$/i, '').trim();
      vars.set(match[1], [...(vars.get(match[1]) ?? []), value]);
    }
  }
  return vars;
}

// Every definition of every var in a value multiplies: two vars with 10 definitions each give 100
// texts. The cap stops a runaway product, not a real theme; cycles are cut by `seen`.
const MAX_EXPANSIONS = 4096;

/**
 * Every value a text can take once its var() calls are replaced by the custom property's
 * definitions (all of them), or its fallback when the property has no definition. null when a
 * var() has neither (the check can't read it) or the properties refer to each other in a loop.
 * With keepUnresolved, such a var() stays in the text as it was and the rest is still resolved
 * (a colour the check doesn't need to read, in a shadow).
 */
export function expandVars(value, vars, seen = new Set(), keepUnresolved = false) {
  const at = value.search(/var\(/i);
  if (at === -1) return [value];
  const open = at + 3;
  let depth = 0;
  let close = -1;
  for (let i = open; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1;
    if (value[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  const [rawName, ...rest] = splitTop(value.slice(open + 1, close));
  const name = rawName.trim();
  const fallback = rest.length > 0 ? rest.join(',').trim() : undefined;
  const definitions = vars.get(name);
  const sources = seen.has(name) ? null : definitions && definitions.length > 0 ? definitions : fallback !== undefined ? [fallback] : null;
  if (!sources) {
    if (!keepUnresolved) return null;
    const tail = expandVars(value.slice(close + 1), vars, seen, true);
    return tail && tail.map((text) => value.slice(0, close + 1) + text);
  }
  const out = [];
  for (const source of sources) {
    const inner = expandVars(source, vars, new Set([...seen, name]), keepUnresolved);
    if (!inner) return null;
    for (const text of inner) {
      const whole = expandVars(value.slice(0, at) + text + value.slice(close + 1), vars, seen, keepUnresolved);
      if (!whole) return null;
      out.push(...whole);
      if (out.length > MAX_EXPANSIONS) return null;
    }
  }
  return out;
}

/**
 * A length in px, or null when the check can't read it (a unit that depends on the viewport or
 * the font, a var(), a keyword that is not a width). thin, medium and thick are 1, 3 and 5.
 * calc(), min(), max() and clamp() of readable lengths are read.
 */
export function readLength(token) {
  const t = token.trim().toLowerCase();
  if (t === 'thin') return 1;
  if (t === 'medium') return 3;
  if (t === 'thick') return 5;
  if (/^(calc|min|max|clamp)\(/.test(t)) return calcPx(t);
  const parsed = parseNumber(t);
  return parsed && parsed.length ? parsed.value : parsed && parsed.value === 0 ? 0 : null;
}

/** A number with an optional unit as { value (px when it has a unit), length }, or null. */
function parseNumber(text) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt)?$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!m[2]) return { value: n, length: false };
  if (m[2] === 'px') return { value: n, length: true };
  if (m[2] === 'rem' || m[2] === 'em') return { value: n * 16, length: true };
  return { value: (n * 4) / 3, length: true };
}

function calcPx(text) {
  const parser = calcParser(text);
  if (!parser) return null;
  const result = parser();
  return result && result.length ? result.value : result && result.value === 0 ? 0 : null;
}

/** A tiny calc() evaluator: + - * / over px-ish lengths and numbers, parentheses, min, max, clamp. */
function calcParser(text) {
  const parts = text.match(/(?:calc|min|max|clamp)\(|[()+*/,]|-(?=\s)|[+-]?(?:\d+\.?\d*|\.\d+)[a-z%]*|\S+/gi);
  if (!parts) return null;
  let i = 0;
  const peek = () => parts[i];
  const take = () => parts[i++];
  const fail = Symbol('unreadable');
  const expr = () => {
    let left = term();
    while (left !== fail && (peek() === '+' || peek() === '-')) {
      const op = take();
      const right = term();
      if (right === fail || left.length !== right.length) return fail;
      left = { value: op === '+' ? left.value + right.value : left.value - right.value, length: left.length };
    }
    return left;
  };
  const term = () => {
    let left = factor();
    while (left !== fail && (peek() === '*' || peek() === '/')) {
      const op = take();
      const right = factor();
      if (right === fail) return fail;
      if (op === '*') {
        if (left.length && right.length) return fail;
        left = { value: left.value * right.value, length: left.length || right.length };
      } else {
        if (right.length || right.value === 0) return fail;
        left = { value: left.value / right.value, length: left.length };
      }
    }
    return left;
  };
  const args = () => {
    const out = [expr()];
    while (peek() === ',') {
      take();
      out.push(expr());
    }
    return take() === ')' && out.every((value) => value !== fail) ? out : null;
  };
  const factor = () => {
    const part = take();
    if (part === undefined) return fail;
    const lower = part.toLowerCase();
    if (lower === '(' || lower === 'calc(') {
      const inner = expr();
      return take() === ')' ? inner : fail;
    }
    if (lower === 'min(' || lower === 'max(' || lower === 'clamp(') {
      const list = args();
      if (!list || list.some((x) => x.length !== list[0].length)) return fail;
      const values = list.map((x) => x.value);
      if (lower === 'clamp(') return values.length === 3 ? { value: Math.min(Math.max(values[1], values[0]), values[2]), length: list[0].length } : fail;
      return { value: lower === 'min(' ? Math.min(...values) : Math.max(...values), length: list[0].length };
    }
    const parsed = parseNumber(lower);
    return parsed ?? fail;
  };
  return () => {
    const result = expr();
    return result === fail || i !== parts.length ? null : result;
  };
}
