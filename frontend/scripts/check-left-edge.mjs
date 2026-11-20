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
import { collectVars, expandVars, readLength, splitTop, tokens } from './lib/css-values.mjs';

// Design: no accent bar down the left edge of a callout, note, quote, card or the current
// item of a list. Set a block apart with a label, a fill or space. A 1px neutral divider, a
// tree's guide line and an all-sides inset ring are fine.
//
// This reads every stylesheet under src and fails on these ways of painting an edge, however
// the edge is written:
//   1. border-left / border-inline-start / border-inline (shorthand, -width, -color), and the
//      left value of a border-width, border-color or border-style list: 2px or more, a width
//      the check can't read, or a coloured (non-neutral) colour;
//   2. a box-shadow with an inset part whose x offset is positive and not soft or a 1px
//      neutral line, or an outer `-Npx 0 0` shadow of 2px or more that paints a bar outside;
//   3. any element (not only ::before / ::after) that is absolutely positioned at the left
//      (left or inset-inline-start from -4px to 2px, or an inset shorthand), tall, 4px or
//      narrower and painted. A 1px neutral stripe (a tree's guide line) is fine. A stripe whose
//      width can't be read (an undefined var, a calc it can't resolve) fails too. A width relative to its box (a %, or a calc with a % term) is a fill and passes; vw and vh are read at a reference viewport of 1440 x 900 (0.2vw is about 3px, a stripe). Declarations of one
//      selector are merged in order across the sheet's rules, and a modifier of that selector
//      (`.x--on .x__edge`, `.x__edge:hover`) is judged with its base's geometry;
//   4. a background (linear-gradient to right or 90deg) with a non-neutral band of 2px or more
//      at the left, such as `red 0 3px, transparent 3px`.
// var() is resolved through every custom property the stylesheets define (all definitions); a
// colour var is neutral only if every definition is neutral, and one with no definition and no
// fallback is a value the check can't read, which fails. CSS nesting is not read, so it fails.
// Reference viewport: vw, vh, vmin and vmax in a stripe's width are read at 1440 x 900. A width
// with a % (or a calc containing one) scales with its box and is read as a fill, so a % stripe
// is a known limit. The left range is -4px to 2px: -4px is the old reach (the pin card's edge
// sat at -1px, a bar can hang outside by up to its own 4px width), 2px adds a small inset.
// Known limits: the colour of an edge set from TSX through var() is not seen (the agent colour
// is set inline in a few components, so var(--agent-color, #888) reads its CSS fallback); the
// inline-style rule (check-inline-styles.mjs) reads only object literals written directly in
// style={{ ... }}. No dataflow is tried. Not read: a background-size band, outline,
// border-image, filter drop-shadow, a stripe made with right/max-width, an unpositioned
// element's left, and the cascade between a later declaration and an earlier one in a rule.
// A shape that only looks like an edge (a corner glyph, a CSS triangle) goes on ALLOWED, by
// file, selector, property and value, with a reason. Inline styles are
// check-inline-styles.mjs's side. There is no baseline: the check starts at zero.

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** A match that is not an edge. By file (under src), the rule's exact selector, and the declaration. */
export const ALLOWED = [
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--tl::before', decl: 'border-left-width: 2px', why: 'the chat panel resize handle corner: an L-shaped grip, not an edge' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--bl::before', decl: 'border-left-width: 2px', why: 'the chat panel resize handle corner: an L-shaped grip, not an edge' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--corner::before', decl: 'border-left: 2px solid', why: 'the chat panel resize handle corner: an L-shaped grip, not an edge' },
  { file: 'styles/moodboard-studio.css', selector: 'body.app-slava-restraint .moodboard-advanced__toggle::before', decl: 'border-left: 4px solid currentColor', why: 'the disclosure chevron: a CSS triangle drawn with a border, not an edge' },
];

const MAX_NEUTRAL_WIDTH_PX = 1;
const MAX_STRIPE_PX = 4;
const LEFT_SIDES = ['border-left', 'border-inline-start', 'border-inline'];
const STYLE_WORD = /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i;
const NUMERIC = /^([+-]?(\d|\.\d)|(calc|min|max|clamp)\()/i;

function main() {
  const files = collectCssFiles(SRC);
  const sources = files.map((file) => readFileSync(file, 'utf8'));
  const vars = collectVars(sources);
  const hits = [];
  files.forEach((file, index) => hits.push(...findLeftEdges(sources[index], relative(SRC, file), vars)));
  const problems = hits.filter((hit) => !isAllowed(hit));
  const stale = staleAllowed(hits);

  if (problems.length > 0 || stale.length > 0) {
    if (problems.length > 0) {
      console.error('Left-edge accent found. Set the block apart with a label, a fill or space, not a coloured or thick edge down its left side.');
      for (const hit of problems) {
        console.error(`  src/${hit.file}:${hit.line} ${hit.selector} { ${hit.decl} }  (${hit.reason})`);
      }
    }
    for (const entry of stale) {
      console.error(`Stale allow-list entry (matches nothing): src/${entry.file} ${entry.selector} { ${entry.decl} }. Remove it from ALLOWED in scripts/check-left-edge.mjs.`);
    }
    process.exit(1);
  }
  console.log(`Left-edge guard passed (${files.length} stylesheets scanned, ${hits.length} allowed shapes).`);
}

const sameEntry = (entry, hit) => entry.file === hit.file && entry.selector === hit.selector && entry.decl === hit.decl;
export const isAllowed = (hit) => ALLOWED.some((entry) => sameEntry(entry, hit));
/** The ALLOWED entries no hit matches: a fixed or changed rule leaves the list. */
export const staleAllowed = (hits) => ALLOWED.filter((entry) => !hits.some((hit) => sameEntry(entry, hit)));

/** Every declaration in one stylesheet that paints a left edge: { file, line, selector, decl, reason }. */
export function findLeftEdges(source, file, vars = collectVars([source])) {
  const css = stripComments(source);
  const lineStarts = computeLineStarts(css);
  const hits = [];
  const addAt = (selector, offset, decl, reason) => hits.push({ file, line: lineForOffset(lineStarts, offset), selector, decl, reason });
  const entries = [];
  for (const rule of parseRules(css)) {
    const selector = compact(rule.selector);
    if (rule.nested) {
      addAt(selector, rule.bodyStart, '{ ... }', "nested CSS isn't read by this check; write each rule on its own");
      continue;
    }
    const declarations = parseDeclarations(rule.body, rule.bodyStart);
    const addDecl = (declaration, reason) => addAt(selector, declaration.offset, `${declaration.prop}: ${compact(declaration.value)}`, reason);
    for (const declaration of declarations) {
      const reason = edgeReason(declaration, declarations, vars);
      if (reason) addDecl(declaration, reason);
    }
    entries.push({ selector, declarations: declarations.map((declaration) => ({ ...declaration, selector })) });
  }
  // A stripe is judged on the declarations of its selector merged across rules, in order.
  const reported = new Set();
  for (const [, declarations] of mergedBySelector(entries)) {
    const stripe = stripeReason(declarations, vars);
    if (!stripe || reported.has(stripe.declaration.offset)) continue;
    reported.add(stripe.declaration.offset);
    const { declaration } = stripe;
    addAt(declaration.selector, declaration.offset, `${declaration.prop}: ${compact(declaration.value)}`, stripe.reason);
  }
  return hits;
}

// ---- selectors --------------------------------------------------------------------------

/** One selector split into its ancestors, its last compound's simple selectors and its pseudo-element. */
function parseSubject(selector) {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(char)) cut = i;
  }
  const ancestors = selector.slice(0, cut + 1).replace(/\s*([>+~])\s*/g, ' $1 ').trim();
  let last = selector.slice(cut + 1);
  let pseudo = '';
  const pe = /(::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter))$/i.exec(last);
  if (pe) {
    pseudo = pe[1].toLowerCase().replace(/^:(?!:)/, '::');
    last = last.slice(0, pe.index);
  }
  const simples = new Set(last.match(/\.[\w-]+|#[\w-]+|\[[^\]]*\]|:{1,2}[\w-]+(?:\([^)]*\))?|^[\w-]+|\*/g) ?? []);
  return { ancestors, simples, pseudo };
}

/** Whether `modifier` is the base selector with more on it: more simple selectors, or an ancestor. */
function isModifierOf(modifier, base) {
  if (modifier.pseudo !== base.pseudo || base.simples.size === 0) return false;
  for (const simple of base.simples) if (!modifier.simples.has(simple)) return false;
  if (base.ancestors !== '' && base.ancestors !== modifier.ancestors) return false;
  return modifier.simples.size > base.simples.size || (modifier.ancestors !== '' && base.ancestors === '');
}

/**
 * selector -> its declarations from every rule of the sheet, in order (a selector list gives each
 * of its selectors the rule's declarations), plus those of a base selector it modifies, when the
 * base positions an element absolutely.
 */
function mergedBySelector(entries) {
  const groups = new Map();
  for (const entry of entries) {
    for (const part of splitTop(entry.selector)) {
      const selector = part.trim();
      if (!selector) continue;
      if (!groups.has(selector)) groups.set(selector, []);
      groups.get(selector).push(...entry.declarations);
    }
  }
  const carriers = [...groups].filter(([, declarations]) => declarations.some((declaration) => declaration.prop === 'position' && /absolute/i.test(declaration.value)));
  if (carriers.length === 0) return groups;
  const carrierSubjects = carriers.map(([selector, declarations]) => ({ selector, declarations, subject: parseSubject(selector) }));
  const merged = new Map();
  for (const [selector, declarations] of groups) {
    const subject = parseSubject(selector);
    const bases = carrierSubjects.filter((carrier) => carrier.selector !== selector && isModifierOf(subject, carrier.subject));
    if (bases.length === 0) {
      merged.set(selector, declarations);
      continue;
    }
    const all = new Map();
    for (const declaration of [...declarations, ...bases.flatMap((base) => base.declarations)]) all.set(declaration.offset, declaration);
    merged.set(selector, [...all.values()].sort((a, b) => a.offset - b.offset));
  }
  return merged;
}

// ---- values -----------------------------------------------------------------------------

function stripImportant(value) {
  return value.replace(/\s*!important\s*$/i, '').trim();
}

/** The texts a value can take once var() is resolved, or null when a var() can't be read. */
function expansions(value, vars, keepUnresolved = false) {
  return expandVars(stripImportant(value), vars, new Set(), keepUnresolved);
}

const UNREADABLE_VAR = "uses a var() with no definition: a value this check can't read";

/** The first reason any resolved text of the value gives, or the unreadable-var reason. */
function reasonOfExpansions(value, vars, check, keepUnresolved = false) {
  const texts = expansions(value, vars, keepUnresolved);
  if (!texts) return `${stripImportant(value)} ${UNREADABLE_VAR}`;
  for (const text of texts) {
    const reason = check(text);
    if (reason) return reason;
  }
  return null;
}

/**
 * Neutral means low chroma, not a list of greys. A resolved colour is neutral when its OKLCH
 * chroma is below NEUTRAL_CHROMA (a muted green-grey divider passes, an agent blue or the orange
 * accent does not); transparent, white, black, currentcolor and the CSS-wide keywords are neutral
 * at any alpha. A var() is neutral only when every definition of it is (or its fallback, when it
 * has none); a var() with neither is not. A color-mix() is neutral when every colour in it is.
 * A colour this reader can't parse is not neutral. A name never decides.
 */
export function isNeutralColor(value, vars = new Map()) {
  const texts = expansions(value, vars);
  return texts !== null && texts.every(isNeutralLiteral);
}

// OKLCH, not HSL saturation: HSL saturation says a dark olive and a pale blue-grey are as
// "coloured" as a pure blue (it is relative to lightness), while OKLCH chroma is perceptual, so
// one threshold separates a tinted divider from a hue that reads as colour. #536047 is about
// 0.04; #5b9dff is about 0.16.
export const NEUTRAL_CHROMA = 0.05;

function isNeutralLiteral(value) {
  const v = stripImportant(value).toLowerCase().trim();
  if (/^(none|transparent|inherit|currentcolor|unset|initial|revert|white|black|gr[ae]y)$/.test(v)) return true;
  const mix = /^color-mix\((.*)\)$/.exec(v);
  if (mix) return mixIsNeutral(mix[1]);
  const rgb = parseColor(v);
  return rgb !== null && oklchChroma(rgb) < NEUTRAL_CHROMA;
}

/** color-mix(in <space> [hue method], <colour> [pct], <colour> [pct]): neutral when each colour is. */
function mixIsNeutral(args) {
  const [space, ...parts] = splitTop(args);
  if (!/^\s*in\s/.test(space ?? '') || parts.length < 2) return false;
  return parts.every((part) => {
    const colour = part.trim().replace(/\s+[\d.]+%$/, '').replace(/^[\d.]+%\s+/, '');
    return isNeutralLiteral(colour);
  });
}

/** A hex, rgb()/rgba() or hsl()/hsla() colour as [r, g, b] in 0..255 (alpha dropped), or null. */
export function parseColor(v) {
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
  if (parts.length < 3) return null;
  if (fn[1].startsWith('rgb')) {
    const channels = parts.map((c) => (c.endsWith('%') ? (Number.parseFloat(c) / 100) * 255 : Number.parseFloat(c)));
    return channels.every(Number.isFinite) ? channels : null;
  }
  const hue = hueDegrees(parts[0]);
  const sat = Number.parseFloat(parts[1]) / 100;
  const light = Number.parseFloat(parts[2]) / 100;
  if (![hue, sat, light].every(Number.isFinite)) return null;
  const k = (n) => (((n + hue / 30) % 12) + 12) % 12;
  const a = sat * Math.min(light, 1 - light);
  return [0, 8, 4].map((n) => 255 * (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
}

/** A hue as degrees in 0..360: a bare number is degrees, and deg, grad, rad and turn are read. */
function hueDegrees(text) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/.exec(text);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const degrees = { deg: n, grad: n * 0.9, rad: (n * 180) / Math.PI, turn: n * 360 }[m[2] ?? 'deg'];
  return ((degrees % 360) + 360) % 360;
}

/** OKLCH chroma of an sRGB colour (0..255 channels). */
function oklchChroma([r, g, b]) {
  const lin = (c) => {
    const x = Math.min(Math.max(c / 255, 0), 1);
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [r, g, b].map(lin);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return Math.hypot(a, bb);
}

const cantRead = (what, value) => `${what} ${value}: a width this check can't read; use a literal px`;

// ---- borders ----------------------------------------------------------------------------

function edgeReason(declaration, declarations, vars) {
  const { prop } = declaration;
  const value = stripImportant(declaration.value);
  for (const side of LEFT_SIDES) {
    if (prop === side) return borderShorthandReason(side, value, vars);
    if (prop === `${side}-width`) return widthReason(`${side}-width`, tokens(value)[0] ?? '', vars);
    if (prop === `${side}-color`) return colourReason(`${side}-color`, tokens(value)[0] ?? '', vars);
  }
  if (prop === 'border-width' || prop === 'border-color') return listReason(prop, value, declarations, vars);
  if (prop === 'box-shadow') return shadowReason(value, vars);
  if (prop === 'background' || prop === 'background-image') return gradientReason(value, vars);
  for (const side of LEFT_SIDES) {
    if (prop === `${side}-style`) return styleOnlyReason(side, value, declarations, vars);
  }
  return null;
}

/** A border width token: thicker than 1px, or one the check can't read. */
function widthReason(label, token, vars) {
  return reasonOfExpansions(token, vars, (text) => {
    const width = readLength(text);
    if (width === null) return cantRead(label, text);
    return width > MAX_NEUTRAL_WIDTH_PX ? `${label} of ${text}: a left edge thicker than 1px` : null;
  });
}

function colourReason(label, token, vars) {
  return reasonOfExpansions(token, vars, (text) => (isNeutralLiteral(text) ? null : `${label} ${text}: a coloured left edge`));
}

/** One border shorthand text (var() already resolved): its width in px, null if unreadable, 0 for none, and its colours. */
function parseBorder(text) {
  const parts = tokens(text);
  if (parts.length === 0 || parts.some((part) => /^(none|hidden|initial|unset|inherit|revert)$/i.test(part))) return { none: true, width: 0, colours: [] };
  let width;
  let hasStyle = false;
  const colours = [];
  for (const part of parts) {
    if (STYLE_WORD.test(part)) hasStyle = true;
    else if (/^(thin|medium|thick)$/i.test(part) || NUMERIC.test(part)) width = readLength(part);
    else colours.push(part);
  }
  // A style with no width is medium, 3px; no style and no width is no border.
  if (width === undefined) width = hasStyle ? 3 : 0;
  return { none: false, width, colours };
}

function borderShorthandReason(side, value, vars) {
  return reasonOfExpansions(value, vars, (text) => {
    const border = parseBorder(text);
    if (border.width === null) return cantRead(side, text);
    if (border.width === 0) return null;
    if (border.width > MAX_NEUTRAL_WIDTH_PX) return `a left border of ${border.width}px: thicker than 1px`;
    const colour = border.colours.find((part) => !isNeutralLiteral(part));
    return colour ? `a coloured left border (${colour})` : null;
  });
}

/** A left border style with no width in its rule is medium, 3px, in currentColor. */
function styleOnlyReason(side, value, declarations, vars) {
  const style = tokens(value)[0] ?? '';
  if (/^(none|hidden|initial|unset|inherit|revert)$/i.test(style)) return null;
  if (!STYLE_WORD.test(style)) return null;
  if (declaredLeftWidth(declarations, vars) !== undefined) return null;
  return `${side}-style ${style} with no width is a 3px left border`;
}

/** The left and right entries of a one to four value list (top right bottom left). */
function leftAndRight(list) {
  const [top, right = top, , left = right] = list;
  return { left, right };
}

/** What the rule says its left border width is, when it says: a number, or undefined. The last declaration wins. */
function declaredLeftWidth(declarations, vars) {
  let width;
  for (const { prop, value } of declarations) {
    const texts = expansions(value, vars);
    const text = texts?.[0];
    if (text === undefined) continue;
    if (prop === 'border' || prop === 'border-left' || prop === 'border-inline-start') {
      const border = parseBorder(text);
      width = border.width ?? undefined;
    } else if (prop === 'border-left-width' || prop === 'border-inline-start-width') {
      width = readLength(tokens(text)[0] ?? '') ?? undefined;
    } else if (prop === 'border-width') {
      width = readLength(leftAndRight(tokens(text)).left ?? '') ?? undefined;
    }
  }
  return width;
}

/** The left value of the rule's last border-style (or border-left-style), when it is none or hidden. */
function leftStyleIsNone(declarations, vars) {
  let none = false;
  for (const { prop, value } of declarations) {
    const text = expansions(value, vars)?.[0];
    if (text === undefined) continue;
    if (prop === 'border-style') none = /^(none|hidden)$/i.test(leftAndRight(tokens(text)).left ?? '');
    else if (prop === 'border-left-style' || prop === 'border-inline-start-style') none = /^(none|hidden)$/i.test(text.trim());
    else if (prop === 'border' || prop === 'border-left' || prop === 'border-inline-start') none = parseBorder(text).none;
  }
  return none;
}

/** border-width and border-color lists: the left value against the right one. */
function listReason(prop, value, declarations, vars) {
  if (leftStyleIsNone(declarations, vars)) return null;
  // One value, or a left that repeats the right as written, is a frame on every side, not an edge.
  const written = leftAndRight(tokens(value));
  if (written.left === undefined || written.left === written.right) return null;
  return reasonOfExpansions(value, vars, (text) => {
    const { left, right } = leftAndRight(tokens(text));
    if (left === undefined || left === right) return null;
    if (prop === 'border-width') {
      const l = readLength(left);
      const r = readLength(right);
      if (l === null || r === null) return cantRead('border-width', text);
      return l >= 2 && l !== r ? `the left value of border-width ${text} (${l}px) differs from the right: a left edge` : null;
    }
    if (isNeutralLiteral(left)) return null;
    if (declaredLeftWidth(declarations, vars) === 0) return null;
    return `the left value of border-color ${text} is coloured and differs from the right: a coloured left edge`;
  });
}

// ---- gradients -------------------------------------------------------------------------

const RIGHTWARD = /^(to\s+right|90(\.0+)?deg|0?\.25turn|100grad|1\.5707\d*rad)$/i;

/** The balanced argument text of each linear-gradient( ... ) in a value. */
function gradientArgs(text) {
  const out = [];
  for (const match of text.matchAll(/linear-gradient\(/gi)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(splitTop(text.slice(open + 1, i)).map((part) => part.trim()));
          break;
        }
      }
    }
  }
  return out;
}

/** The colour bands of a gradient's stops, in px along its line: [{ start, end, colours }]. A position in % or one it can't read stops the walk. */
function gradientBands(stops) {
  const bands = [];
  let cursor = 0;
  let pending = [];
  for (const stop of stops) {
    const parts = tokens(stop);
    const isPosition = (part) => /^[+-]?[\d.]/.test(part) || /^(calc|min|max|clamp)\(/i.test(part);
    const colour = parts.filter((part) => !isPosition(part)).join(' ');
    if (!colour) continue;
    const positions = parts.filter(isPosition).map((part) => (part.endsWith('%') ? null : readLength(part)));
    if (positions.some((px) => px === null)) return bands;
    if (positions.length === 0) {
      pending.push(colour);
      continue;
    }
    const [first, second] = positions;
    const start = second === undefined ? cursor : first;
    const end = second === undefined ? first : second;
    bands.push({ start: pending.length ? cursor : start, end, colours: [...pending, colour] });
    pending = [];
    cursor = end;
  }
  return bands;
}

/** A background with a coloured band of 2px or more at the left of a rightward linear-gradient. */
function gradientReason(value, vars) {
  return reasonOfExpansions(value, vars, (text) => {
    for (const args of gradientArgs(text)) {
      const [first, ...rest] = args;
      const direction = /^(to\s|[-+\d.]+(deg|turn|grad|rad)$)/i.test(first ?? '') ? first : null;
      if (direction === null || !RIGHTWARD.test(direction.trim())) continue;
      for (const band of gradientBands(rest)) {
        if (band.start > 2) break;
        if (band.end - band.start >= 2 && band.colours.some((colour) => !isNeutralLiteral(colour))) {
          return `a background gradient paints a ${band.end - band.start}px coloured band at the left`;
        }
      }
    }
    return null;
  }, true);
}

// ---- shadows ----------------------------------------------------------------------------

function shadowReason(value, vars) {
  return reasonOfExpansions(value, vars, (text) => {
    for (const shadow of splitTop(text)) {
      const reason = oneShadowReason(shadow);
      if (reason) return reason;
    }
    return null;
  }, true);
}

/**
 * One shadow: [inset] x y [blur [spread]] [colour], the colour first or last. A colour the
 * check can't resolve (an agent's var) is left as it is; an offset it can't read fails.
 */
function oneShadowReason(shadow) {
  const parts = tokens(shadow);
  const inset = parts.some((part) => part.toLowerCase() === 'inset');
  const rest = parts.filter((part) => part.toLowerCase() !== 'inset');
  // An unresolved var() first, with a colour after the lengths, is the x offset; otherwise it is the colour.
  const colourLast = rest.length > 1 && !NUMERIC.test(rest[rest.length - 1]);
  const first = rest.findIndex((part, index) => NUMERIC.test(part) || (index === 0 && colourLast && /^var\(/i.test(part)));
  if (first === -1) return null;
  const run = [];
  for (let i = first; i < rest.length && run.length < 4 && (NUMERIC.test(rest[i]) || (i === first && /^var\(/i.test(rest[i]))); i += 1) run.push(rest[i]);
  const lengths = run.map(readLength);
  const colours = rest.filter((part) => !run.includes(part));
  const [x, y = 0, blur = 0] = lengths;
  if (lengths.length < 2 && x !== null) return null;
  if (x === null) return `a box-shadow x offset this check can't read (${compact(shadow)}): use a literal px`;
  if (inset) {
    if (x <= 0) return null;
    if (blur === null) return `an inset box-shadow blur this check can't read (${compact(shadow)})`;
    // A soft inset shadow (blur wider than its x offset) is a glow, not an edge.
    if (blur > x) return null;
    if (x <= MAX_NEUTRAL_WIDTH_PX && colours.every(isNeutralLiteral)) return null;
    return 'an inset box-shadow with a positive x offset paints a bar inside the left edge';
  }
  if (x <= -2) {
    if (y === null || blur === null) return `a box-shadow this check can't read (${compact(shadow)}): use literal px`;
    if (y === 0 && blur === 0) return 'an outer box-shadow of -2px or more with no blur paints a bar outside the left edge';
  }
  return null;
}

// ---- stripes ----------------------------------------------------------------------------

/** top, right, bottom, left of an inset shorthand text. */
function insetSides(text) {
  const [top, right = top, bottom = top, left = right] = tokens(text);
  return { top, right, bottom, left };
}

const MAX_STRIPE_INSET_PX = 2;
const inStripeLeft = (token) => {
  const px = token === undefined ? null : readLength(token);
  return px !== null && px <= MAX_STRIPE_INSET_PX && px >= -MAX_STRIPE_PX;
};
/** vw, vh, vmin and vmax read at the reference viewport, so 0.2vw is 2.88px. */
const VIEWPORT_W = 1440;
const VIEWPORT_H = 900;
function viewportToPx(text) {
  const unit = { vw: VIEWPORT_W, vh: VIEWPORT_H, vmin: Math.min(VIEWPORT_W, VIEWPORT_H), vmax: Math.max(VIEWPORT_W, VIEWPORT_H) };
  return text.replace(/([+-]?(?:\d+\.?\d*|\.\d+))[dsl]?(vw|vh|vmin|vmax)\b/gi, (_, n, u) => `${(Number(n) * unit[u.toLowerCase()]) / 100}px`);
}
const FILL_WIDTH = /^(auto|100%|inherit|initial|unset|revert|fit-content|min-content|max-content|stretch)$/i;
const isSet = (token) => token !== undefined && !/^auto$/i.test(token.trim());

/**
 * Any element drawn as a stripe down the left: absolute, at the left (left or inset-inline-start
 * -4px to 2px, or an inset shorthand), tall (top and bottom set, inset-block, a % height, or a px
 * height past its width), 4px or narrower, and painted. A 1px neutral one is a guide line. When
 * all of that holds and the width can't be read (an undefined var, a calc with no % term it can't resolve), it fails. A % width, or a calc with a % term, is a fill and passes; vw and vh are px at 1440 x 900.
 * `declarations` are the merged declarations of one selector, later ones winning.
 */
function stripeReason(declarations, vars) {
  const last = new Map();
  for (const declaration of declarations) last.set(declaration.prop, declaration);
  const values = (prop) => {
    const declaration = last.get(prop);
    return declaration ? expansions(declaration.value, vars) ?? [] : [];
  };
  if (!values('position').some((text) => /^absolute$/i.test(text.trim()))) return null;

  const atLeft = values('left').some((text) => inStripeLeft(text.trim()))
    || values('inset-inline-start').some((text) => inStripeLeft(text.trim()))
    || values('inset-inline').some((text) => inStripeLeft(tokens(text)[0]))
    || values('inset').some((text) => inStripeLeft(insetSides(text).left));
  if (!atLeft) return null;

  // Every width this rule can take: a px it reads, a fill keyword or 100%, or one it can't read.
  // A value with a % anywhere in it is a fill, even through a var() with no definition.
  const widthTexts = ['width', 'inline-size']
    .filter((prop) => last.has(prop) && !last.get(prop).value.includes('%'))
    .map((prop) => expansions(last.get(prop).value, vars));
  const widthPx = [];
  let unreadable = false;
  for (const texts of widthTexts) {
    if (texts === null) unreadable = true;
    else {
      for (const text of texts) {
        // Relative to its box (a %, or a calc with a % term) is a fill, never "a few px" by design.
        if (text.includes('%')) continue;
        const px = readLength(viewportToPx(text.trim()));
        if (px !== null) widthPx.push(px);
        else if (!FILL_WIDTH.test(text.trim())) unreadable = true;
      }
    }
  }
  const narrow = widthPx.filter((px) => px > 0 && px <= MAX_STRIPE_PX);
  if (narrow.length === 0 && !unreadable) return null;
  const width = narrow.length > 0 ? Math.max(...narrow) : MAX_STRIPE_PX;

  const topAndBottom = (isSet(last.get('top')?.value) && isSet(last.get('bottom')?.value))
    || values('inset-block').some((text) => tokens(text).every(isSet))
    || (values('inset-block-start').some(isSet) && values('inset-block-end').some(isSet))
    || values('inset').some((text) => {
      const { top, bottom } = insetSides(text);
      return isSet(top) && isSet(bottom);
    });
  const heights = [...values('height'), ...values('block-size')].map((text) => text.trim());
  const tall = topAndBottom || heights.some((text) => /^[\d.]+%$/.test(text) || (readLength(text) ?? 0) > width);
  if (!tall) return null;

  const painted = ['background', 'background-color', 'background-image']
    .map((prop) => last.get(prop))
    .filter((declaration) => declaration && (expansions(declaration.value, vars) ?? [declaration.value]).some((text) => !/^(none|transparent|initial|unset|inherit)$/i.test(text.trim())));
  if (painted.length === 0) return null;
  if (narrow.length === 0) return { declaration: painted[0], reason: "a stripe whose width this check can't read: absolute, flush left, tall and painted; use a literal px" };
  // A 1px stripe in a neutral colour is a guide line, like a tree's.
  if (width <= MAX_NEUTRAL_WIDTH_PX && painted.every((declaration) => declaration.prop !== 'background-image' && isNeutralColor(declaration.value, vars))) return null;
  return { declaration: painted[0], reason: 'a stripe down the left: absolute, flush left, tall, 4px or narrower, with a background' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
