import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectCssFiles,
  compact,
  computeLineStarts,
  lineForOffset,
  parseDeclarations,
  parseRules,
  stripComments,
} from './lib/css-scan.mjs';

// Design: no accent bar down the left edge of a callout, note, quote, card or the
// current item of a list. Set a block apart with a label, a fill or space. A 1px
// neutral divider, a tree's guide line and an all-sides inset ring are fine.
//
// This reads every stylesheet under src and fails on three ways of painting an edge:
//   1. border-left / border-inline-start (and -width / -color) of 2px or more, or with a
//      coloured (non-neutral) colour;
//   2. a box-shadow with an inset part whose x offset is positive (`inset 4px 0 0 ...`),
//      alone or in a list;
//   3. a ::before / ::after with position: absolute, left: 0 (or inset-inline-start: 0), a
//      width of 4px or less, a background, and taller than wide (top and bottom both set, a
//      percentage height, or a px height past the width; a 4px x 4px dot is not a stripe);
// A shape that only looks like an edge (a corner glyph, a CSS triangle) goes on ALLOWED, by
// file and exact selector, with a reason. Inline styles are check-inline-styles.mjs's side. There is no baseline: the check starts at zero.

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** A match that is not an edge. By file (under src) and the rule's exact selector. */
export const ALLOWED = [
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--tl::before', why: 'the chat panel resize handle corner: an L-shaped grip, not an edge' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--bl::before', why: 'the chat panel resize handle corner: an L-shaped grip, not an edge' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--corner::before', why: 'the chat panel resize handle corner: an L-shaped grip, not an edge' },
  { file: 'styles/moodboard-studio.css', selector: 'body.app-slava-restraint .moodboard-advanced__toggle::before', why: 'the disclosure chevron: a CSS triangle drawn with a border, not an edge' },
];

const SIDES = ['border-left', 'border-inline-start'];
const MAX_NEUTRAL_WIDTH_PX = 1;
const MAX_STRIPE_PX = 4;

function main() {
  const files = collectCssFiles(SRC);
  const hits = [];
  for (const file of files) {
    hits.push(...findLeftEdges(readFileSync(file, 'utf8'), relative(SRC, file)));
  }
  const problems = hits.filter((hit) => !isAllowed(hit));
  const stale = ALLOWED.filter((entry) => !hits.some((hit) => sameEntry(entry, hit)));

  if (problems.length > 0 || stale.length > 0) {
    if (problems.length > 0) {
      console.error('Left-edge accent found. Set the block apart with a label, a fill or space, not a coloured or thick edge down its left side.');
      for (const hit of problems) {
        console.error(`  src/${hit.file}:${hit.line} ${hit.selector} { ${hit.decl} }  (${hit.reason})`);
      }
    }
    for (const entry of stale) {
      console.error(`Stale allow-list entry (matches nothing): src/${entry.file} ${entry.selector}. Remove it from ALLOWED in scripts/check-left-edge.mjs.`);
    }
    process.exit(1);
  }
  console.log(`Left-edge guard passed (${files.length} stylesheets scanned, ${hits.length} allowed shapes).`);
}

const sameEntry = (entry, hit) => entry.file === hit.file && entry.selector === hit.selector;
export const isAllowed = (hit) => ALLOWED.some((entry) => sameEntry(entry, hit));

/** Every rule in one stylesheet that paints a left edge: { file, line, selector, decl, reason }. */
export function findLeftEdges(source, file) {
  const css = stripComments(source);
  const lineStarts = computeLineStarts(css);
  const hits = [];
  for (const rule of parseRules(css)) {
    const selector = compact(rule.selector);
    const declarations = parseDeclarations(rule.body, rule.bodyStart);
    const add = (declaration, reason) => hits.push({
      file,
      line: lineForOffset(lineStarts, declaration.offset),
      selector,
      decl: `${declaration.prop}: ${compact(declaration.value)}`,
      reason,
    });

    for (const declaration of declarations) {
      const reason = edgeReason(declaration.prop, declaration.value);
      if (reason) add(declaration, reason);
    }

    if (isPseudoElementSelector(selector) && isStripe(declarations)) {
      const background = declarations.find((d) => isBackgroundProp(d.prop) && paintsBackground(d.value));
      add(background, 'a pseudo-element stripe: absolute, flush left, 4px or narrower, with a background');
    }
  }
  return hits;
}

function edgeReason(prop, rawValue) {
  const value = stripImportant(rawValue);
  for (const side of SIDES) {
    if (prop === side) return borderShorthandReason(value);
    if (prop === `${side}-width`) {
      const width = lengthPx(value);
      return width === null || width > MAX_NEUTRAL_WIDTH_PX ? `${side}-width of ${value}: a left edge thicker than 1px` : null;
    }
    if (prop === `${side}-color`) {
      return isNeutralColor(value) ? null : `${side}-color ${value}: a coloured left edge`;
    }
  }
  if (prop === 'box-shadow') return insetLeftShadow(value) ? 'an inset box-shadow with a positive x offset paints a bar inside the left edge' : null;
  return null;
}

function borderShorthandReason(value) {
  const parts = tokens(value);
  if (parts.length === 0 || /^(none|initial|unset|inherit|revert)$/i.test(value)) return null;
  let width = 0;
  const colourParts = [];
  for (const part of parts) {
    if (/^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(part)) continue;
    const px = lengthPx(part);
    if (px !== null || /^(var|calc|min|max|clamp)\(/i.test(part) && looksLikeWidth(part)) {
      width = px === null ? Infinity : px;
    } else {
      colourParts.push(part);
    }
  }
  if (width === 0) return null;
  if (width > MAX_NEUTRAL_WIDTH_PX) return `a left border of ${Number.isFinite(width) ? `${width}px` : 'a width this check cannot read; use a literal px'}: thicker than 1px`;
  if (colourParts.length > 0 && !isNeutralColor(colourParts.join(' '))) return `a coloured left border (${colourParts.join(' ')})`;
  return null;
}

/** A var()/calc() in a border shorthand is a width when it names one; otherwise it is the colour. */
function looksLikeWidth(token) {
  return /^(calc|min|max|clamp)\(/i.test(token) || /(width|rail|weight|thick|size|w)\b/i.test(token.replace(/^var\(\s*/, ''));
}

/**
 * Neutral, the way check-slava-css-scope reads it (none, 0, transparent, inherit,
 * currentcolor, unset, initial, or a border with no colour at all), plus the greys the
 * app's dividers use: a hex, rgb() or hsl() with no hue, and a var() of a divider token
 * (--sr-edge, --sr-edge-strong, --mb-board-edge-strong, ...), never one that names an
 * agent, accent, status or colour.
 */
export function isNeutralColor(value) {
  const v = stripImportant(value).trim().toLowerCase();
  if (/^(none|transparent|inherit|currentcolor|unset|initial|revert)$/.test(v)) return true;
  if (/^(white|black|gr[ae]y)$/.test(v)) return true;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) return hexIsGrey(hex);
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(v);
  if (fn) return fn[1].startsWith('rgb') ? rgbIsGrey(fn[2]) : hslIsGrey(fn[2]);
  const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/.exec(v);
  if (variable) {
    const [, name, fallback] = variable;
    if (/(agent|accent|author|status|warn|error|danger|success|color|colour|pin)/.test(name)) return false;
    if (!/(edge|hairline|divider|rule|ink)/.test(name)) return false;
    return fallback === undefined || isNeutralColor(fallback);
  }
  return false;
}

function hexIsGrey(hex) {
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => full.slice(i, i + 2));
  return r === g && g === b;
}

function rgbIsGrey(args) {
  const channels = args.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((c) => Number.parseFloat(c));
  return channels.length === 3 && channels.every(Number.isFinite) && channels[0] === channels[1] && channels[1] === channels[2];
}

function hslIsGrey(args) {
  const saturation = args.split(/[\s,/]+/).filter(Boolean)[1];
  return saturation !== undefined && Number.parseFloat(saturation) === 0;
}

/** True when any part of the shadow list is an inset with a positive x offset. */
function insetLeftShadow(value) {
  return splitTop(value).some((shadow) => {
    const parts = tokens(shadow);
    if (!parts.some((part) => part.toLowerCase() === 'inset')) return false;
    const x = parts.map(lengthPx).find((px) => px !== null);
    return x !== undefined && x > 0;
  });
}

function isPseudoElementSelector(selector) {
  return splitTop(selector).some((part) => /::?(before|after)\s*$/i.test(part.trim()));
}

const isBackgroundProp = (prop) => prop === 'background' || prop === 'background-color';
const paintsBackground = (value) => !/^(none|transparent|initial|unset|inherit)$/i.test(stripImportant(value).trim());

function isStripe(declarations) {
  const get = (...props) => declarations.find((d) => props.includes(d.prop));
  const position = get('position');
  const left = get('left', 'inset-inline-start');
  const width = get('width', 'inline-size');
  if (!position || stripImportant(position.value).toLowerCase() !== 'absolute') return false;
  if (!left || lengthPx(stripImportant(left.value)) !== 0) return false;
  const px = width ? lengthPx(stripImportant(width.value)) : null;
  if (px === null || px > MAX_STRIPE_PX) return false;
  if (!declarations.some((d) => isBackgroundProp(d.prop) && paintsBackground(d.value))) return false;
  // A stripe is taller than it is wide: top and bottom both set, a percentage height, or a px height past its width.
  if (get('top') && get('bottom')) return true;
  const height = get('height', 'block-size');
  if (!height) return false;
  const h = stripImportant(height.value);
  if (/^-?[\d.]+%$/.test(h)) return true;
  const hp = lengthPx(h);
  return hp !== null && hp > px;
}

function stripImportant(value) {
  return value.replace(/\s*!important\s*$/i, '').trim();
}

/** A px length, or null when the token is not a readable length (a var(), a keyword, a colour). */
function lengthPx(token) {
  const t = token.trim().toLowerCase();
  if (t === 'thin') return 1;
  if (t === 'medium') return 3;
  if (t === 'thick') return 5;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 0) return 0;
  if (m[2] === 'px') return n;
  if (m[2] === 'rem' || m[2] === 'em') return n * 16;
  if (m[2] === 'pt') return (n * 4) / 3;
  return null;
}

/** Split on whitespace outside parentheses. */
function tokens(value) {
  return splitOutside(value.trim(), /\s/);
}

/** Split on commas outside parentheses. */
function splitTop(value) {
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
