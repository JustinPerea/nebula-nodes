import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectCssFiles,
  compact,
  bodyHasBrace,
  computeLineStarts,
  findMatchingBrace,
  findSelectorStart,
  lineForOffset,
  parseDeclarations,
  stripComments,
} from './lib/css-scan.mjs';
import { CALM_STATE, ERROR_STATE, NOT_GROUP, flattenNested, lastCompound } from './check-error-tokens.mjs';
import { ALLOWLIST, TS_ALLOWLIST } from './status-literals-allowlist.mjs';

// Design: a status is a token, not a colour. Something that went wrong is --sr-error, needs
// attention is --sr-warning, done is --sr-success, current or selected is --sr-accent, and a
// calm state is neutral ink. A hard-coded colour in a status rule is a second palette, and
// the colours here (a salmon error, an amber warning, a blue Save) did not match the first.
//
// This reads every stylesheet and .ts/.tsx file under src and fails on:
//   1. a status selector (the last compound holds error, fail, invalid, refused, warn, blocked,
//      denied, rejected, running, pass, done, ok, success, complete, ready, found, selected,
//      active, current, saved, unsaved, dirty, stale, outdated, paused, offline, pending,
//      loading, conflict, paid, expired or recording, or [aria-current], [aria-selected] or
//      [aria-pressed]; or an @keyframes whose name holds one) that writes a colour (color,
//      background, border, outline, fill, stroke, a shadow, accent-color, caret-color,
//      scrollbar-color, or a custom property named for a colour) with any chromatic literal.
//   2. var(--line-warning, <x>), -soft or -edge, where <x> is not another var(--sr-...).
//   3. a literal of a palette family (the accent, accent hover, warning, success, danger red)
//      outside a token definition. A token's own value is written once, as the token.
//   4. var(--sr-*, <chromatic literal>) anywhere but the exact danger pair on a destructive
//      control; and a chromatic fallback on a custom property declared nowhere.
//   5. the hue guard: a literal that is red, orange, yellow or green (hue 345-70 or 80-170,
//      saturation above 25%) in any selector, so a new pill painted amber is caught though its
//      name has no state word. Blue, cyan, violet and pink are not guarded (category, port and
//      agent colours; the palette has none).
// Chromatic means a channel spread above 12 (hex, rgb() and rgba() in comma or space syntax) or
// hsl() saturation above 5%; white, black and grey alphas pass. color-mix() and var() fallbacks
// are read like any value. In .ts/.tsx only a quoted 6- or 8-digit hex, rgb(), rgba(), hsl() or
// hsla() counts (a PR number like #203 is not a colour), comments are skipped, and rules 3 and 5
// apply.
// A rule whose every selector needs `body:not(.app-slava-restraint)` is the retired classic skin: it
// matches nothing, so it is not read.
// Exemptions: a `palette-exempt: <reason>` comment on the line above a declaration (or its rule's
// selector) or on the same line; and the entries of status-literals-allowlist.mjs, each with a
// reason, by file and selector. A `whole: true` file entry exempts the hue guard (rule 5) only;
// rules 1-4 still run on that file.

const SRC = join(process.cwd(), 'src');

const STATUS_NEW = /(?<![a-z0-9])(?:selected|active|current|saved|unsaved|dirty|stale|outdated|paused|offline|pending|loading|conflict|paid|expired|recording|pressed)(?![a-z0-9-])/i;
const STATUS_ARIA = /aria-(?:current|selected|pressed)/i;
const COLOUR_PROPS = /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?|border-image(?:-source)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|accent-color|caret-color|scrollbar-color|text-decoration(?:-color)?|column-rule(?:-color)?|stop-color|flood-color|lighting-color|-webkit-text-fill-color|-webkit-text-stroke(?:-color)?|filter|mask-image)$/;
const COLOUR_CUSTOM = /(?:color|colour|bg|background|border|edge|ink|fill|stroke|glow|shadow|tint|outline|ring|accent)/i;
const LINE_WARNING = /^--line-warning(?:-soft|-edge)?$/;

// The exact danger pair a destructive control reads (check-error-tokens allows it).
const DANGER_FALLBACKS = new Map([
  ['--sr-danger-ink', [255, 136, 125]],
  ['--sr-danger-fill', [255, 136, 125]],
  ['--sr-danger-ink-hover', [255, 154, 145]],
  ['--sr-danger-fill-hover', [255, 154, 145]],
]);
// The palette families a literal may not repeat (rgb values).
const FAMILIES = [
  ['the accent', [255, 90, 31]],
  ['the accent hover', [255, 107, 52]],
  ['the warning and error tone', [245, 197, 24]],
  ['the success tone', [110, 231, 183]],
  ['the danger red', [255, 136, 125]],
  ['the danger red hover', [255, 154, 145]],
  ['the danger red tint', [255, 70, 60]],
];
const NAMED = {
  red: [255, 0, 0],
  orange: [255, 165, 0],
  yellow: [255, 255, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  gold: [255, 215, 0],
  tomato: [255, 99, 71],
  crimson: [220, 20, 60],
  coral: [255, 127, 80],
  salmon: [250, 128, 114],
  orangered: [255, 69, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
};

function main() {
  const flag = process.argv.indexOf('--src');
  const root = flag === -1 ? SRC : process.argv[flag + 1];
  const css = collectCssFiles(root).map((file) => ({ file: relative(root, file), source: readFileSync(file, 'utf8') }));
  const ts = collectScripts(root).map((file) => ({ file: relative(root, file), source: readFileSync(file, 'utf8') }));
  const hits = findStatusLiteralHits({ css, ts });
  if (hits.length > 0) {
    console.error('A status is a token, not a colour (design). Use --sr-error, --sr-warning, --sr-success, --sr-accent or a neutral ink; a colour that is not a status goes in the allowlist (scripts/status-literals-allowlist.mjs) or under a `palette-exempt: <reason>` comment.');
    for (const hit of hits) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} { ${hit.decl} }  (rule ${hit.rules.join('+')}: ${hit.reason})`);
    process.exit(1);
  }
  console.log(`Status literal guard passed (${css.length} stylesheets, ${ts.length} scripts scanned).`);
}

function collectScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'test' || entry === '__golden__') continue;
      out.push(...collectScripts(path));
    } else if (/\.(?:ts|tsx)$/.test(entry) && !/\.(?:test|spec|d)\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Colour literals

function toHsl([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r / 255) h = ((g - b) / 255 / d) % 6;
  else if (max === g / 255) h = (b - r) / 255 / d + 2;
  else h = (r - g) / 255 / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const channel = (text) => (text.endsWith('%') ? (parseFloat(text) / 100) * 255 : parseFloat(text));

/**
 * Every colour literal in a value: { text, rgb, start, end }. `hexDigits` is the hex lengths that
 * count (CSS: 3, 4, 6, 8; script strings: 6, 8). Named colours are read only when `named` is set.
 */
export function literalsIn(value, { hex = [3, 4, 6, 8], named = false } = {}) {
  const found = [];
  const push = (text, start, rgb) => found.push({ text, start, end: start + text.length, rgb });
  for (const m of value.matchAll(/#([0-9a-f]+)(?![0-9a-z_-])/gi)) {
    const digits = m[1];
    if (!hex.includes(digits.length)) continue;
    const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
    push(m[0], m.index, [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)));
  }
  for (const m of value.matchAll(/rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)/gi)) {
    push(m[0], m.index, [channel(m[1]), channel(m[2]), channel(m[3])]);
  }
  for (const m of value.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%/gi)) {
    push(m[0], m.index, hslToRgb(parseFloat(m[1]) % 360, parseFloat(m[2]) / 100, parseFloat(m[3]) / 100));
  }
  if (named) {
    for (const m of value.matchAll(/(?<![\w-])(red|orange|yellow|lime|green|gold|tomato|crimson|coral|salmon|orangered|blue|cyan|magenta|purple|pink)(?![\w-])/gi)) {
      push(m[0], m.index, NAMED[m[1].toLowerCase()]);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Channel spread above 12 (hsl saturation above 5% reads the same once converted). */
export const isChromatic = ({ rgb }) => Math.max(...rgb) - Math.min(...rgb) > 12;

/** Red, orange, yellow or green with real saturation: the hues a status borrows. */
export function inGuardedHue({ rgb }) {
  const { h, s } = toHsl(rgb);
  if (s <= 0.25) return false;
  return h >= 345 || h <= 70 || (h >= 80 && h <= 170);
}

const sameRgb = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
const familyOf = (literal) => FAMILIES.find(([, rgb]) => sameRgb(literal.rgb, rgb))?.[0] ?? null;

// ---------------------------------------------------------------------------------------------
// var() calls

/** Every var(--name, fallback) in a value, with balanced parentheses: { name, fallback, start, end, fbStart, fbEnd }. */
export function varCalls(value) {
  const calls = [];
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    let depth = 1;
    let i = m.index + 4;
    while (i < value.length && depth > 0) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      i += 1;
    }
    const end = i;
    const fbStart = m[2] ? m.index + m[0].length : -1;
    calls.push({
      name: m[1],
      fallback: fbStart === -1 ? null : value.slice(fbStart, end - 1).trim(),
      start: m.index,
      end,
      fbStart,
      fbEnd: end - 1,
    });
  }
  return calls;
}

// ---------------------------------------------------------------------------------------------
// Stylesheets

/** Rules with their @keyframes name: parseRules drops the at-rule, and a keyframe name is a state word's home. */
function walkRules(css, base = 0, keyframes = null) {
  const rules = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open === -1) break;
    const close = findMatchingBrace(css, open);
    if (close === -1) break;
    const selectorStart = Math.max(cursor, findSelectorStart(css, open));
    const selector = css.slice(selectorStart, open).trim();
    const body = css.slice(open + 1, close);
    if (selector.startsWith('@')) {
      const name = /^@(?:-webkit-)?keyframes\s+([\w-]+)/i.exec(selector);
      rules.push(...walkRules(body, base + open + 1, name ? name[1] : keyframes));
    } else if (selector) {
      rules.push({ selector, body, bodyStart: base + open + 1, nested: bodyHasBrace(body), keyframes });
    }
    cursor = close + 1;
  }
  return rules;
}

/** The lines a `palette-exempt:` comment covers: its own last line and the next. */
function exemptLines(source) {
  const lines = new Set();
  const starts = computeLineStarts(source);
  for (const m of source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
    if (!/palette-exempt:\s*\S/.test(m[0])) continue;
    const endLine = lineForOffset(starts, m.index + m[0].length - 1);
    lines.add(endLine);
    lines.add(endLine + 1);
  }
  return lines;
}

const isStatusPart = (part) => {
  const plain = part
    .replace(NOT_GROUP, '')
    .replace(/:(?:is|where)\(((?:[^()]|\([^()]*\))*)\)/g, ' $1 ')
    .replace(/::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?/g, '');
  const state = lastCompound(plain.trim()).replace(/\.[\w-]*?__/g, '.');
  return ERROR_STATE.test(state) || CALM_STATE.test(state) || STATUS_NEW.test(state) || STATUS_ARIA.test(state);
};

const selectorMatches = (entry, selector) =>
  entry.selector instanceof RegExp ? entry.selector.test(selector) : selector.includes(entry.selector);

/**
 * How the allowlist covers this declaration: 'all' (a selector or prop entry exempts every rule),
 * 'hue' (a `whole: true` file entry exempts the hue guard, rule 5, only; design: rules 1-4 still
 * run on a themed file) or null.
 */
function allowed(entries, file, selector, prop) {
  let cover = null;
  for (const entry of entries) {
    if (entry.file !== file) continue;
    if (entry.whole) {
      cover = cover ?? 'hue';
      continue;
    }
    if (entry.prop && !(entry.prop instanceof RegExp ? entry.prop.test(prop) : prop.startsWith(entry.prop))) continue;
    if (entry.selector && !selectorMatches(entry, selector)) continue;
    if (entry.selector || entry.prop) return 'all';
  }
  return cover;
}

const stripStrings = (value) => value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/url\([^)]*\)/g, 'url()');

/**
 * Every violation across { css: [{ file, source }], ts: [{ file, source }] }:
 * { file, line, selector, decl, rules: [n...], reason }.
 */
export function findStatusLiteralHits({ css = [], ts = [] }, allowlist = ALLOWLIST, tsAllowlist = TS_ALLOWLIST) {
  const sheets = css.map(({ file, source }) => {
    const stripped = stripComments(source);
    const rules = walkRules(stripped).flatMap((rule) => flattenNested(rule));
    return { file, source, lineStarts: computeLineStarts(stripped), rules };
  });

  // Custom properties declared anywhere: in a stylesheet, or set from a script as a '--name' string.
  const defined = new Set();
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      for (const d of parseDeclarations(rule.body, rule.bodyStart)) if (d.prop.startsWith('--')) defined.add(d.prop);
    }
  }
  for (const { source } of ts) for (const m of source.matchAll(/['"`](--[\w-]+)['"`]/g)) defined.add(m[1]);
  for (const { source } of ts) for (const m of source.matchAll(/['"`]\s*(--[\w-]+)\s*:/g)) defined.add(m[1]);

  const hits = [];
  for (const sheet of sheets) {
    const exempt = exemptLines(sheet.source);
    for (const rule of sheet.rules) {
      const selector = compact(rule.selector);
      const statusText = rule.keyframes ?? null;
      const parts = selector.split(',').map((part) => part.trim());
      // Slava is the only skin (lib/skins.ts), so a rule every part of which needs the body
      // without .app-slava-restraint matches nothing.
      if (statusText === null && parts.every((part) => /body:not\(\s*\.app-slava-restraint\s*\)/.test(part))) continue;
      const status =
        statusText !== null
          ? statusText.split(/[-_]+/).some((word) => ERROR_STATE.test(word) || CALM_STATE.test(word) || STATUS_NEW.test(word))
          : parts.some(isStatusPart);
      const label = statusText !== null ? `@keyframes ${statusText} ${selector}` : selector;
      const braceLine = lineForOffset(sheet.lineStarts, rule.bodyStart - 1);
      const selectorLine = braceLine - (rule.selector.match(/\n/g)?.length ?? 0);
      const ruleExempt = exempt.has(selectorLine) || exempt.has(braceLine);
      for (const d of parseDeclarations(rule.body, rule.bodyStart)) {
        const line = lineForOffset(sheet.lineStarts, d.offset);
        if (ruleExempt || exempt.has(line)) continue;
        const cover = allowed(allowlist, sheet.file, label, d.prop);
        if (cover === 'all') continue;
        const value = compact(stripStrings(d.value));
        const colourBearing = COLOUR_PROPS.test(d.prop) || (d.prop.startsWith('--') && COLOUR_CUSTOM.test(d.prop));
        const found = scanValue(value, { namedColours: colourBearing, defined });
        for (const f of found) {
          const rules = [];
          const reasons = [];
          if (f.line2) {
            rules.push(2);
            reasons.push(f.line2);
          }
          if (f.chromatic && f.allowedDanger !== true) {
            if (status && colourBearing) {
              rules.push(1);
              reasons.push('a status rule paints a literal colour: read a --sr-* token');
            }
            if (f.family) {
              rules.push(3);
              reasons.push(`${f.family} is a token: write the token, not the literal`);
            }
            if (f.fallbackOf) {
              rules.push(4);
              reasons.push(`var(${f.fallbackOf}, <colour>): the fallback is a second palette; drop it`);
            }
            if (f.guarded && cover !== 'hue') {
              rules.push(5);
              reasons.push('red, orange, yellow and green mean a status: use a token, or allowlist it with a reason');
            }
          }
          if (rules.length > 0) {
            hits.push({ file: sheet.file, line, selector: label, decl: `${d.prop}: ${value}`, rules: [...new Set(rules)], reason: reasons[0], literal: f.text });
          }
        }
      }
    }
  }

  for (const { file, source } of ts) hits.push(...scanScript(file, source, tsAllowlist));
  return hits;
}

/** The checkable literals and var() fallbacks in one declaration value. */
function scanValue(value, { namedColours, defined }) {
  const out = [];
  const calls = varCalls(value);
  const covered = [];
  for (const call of calls) {
    if (call.fallback === null) continue;
    const literals = literalsIn(call.fallback, { named: namedColours }).filter(isChromatic);
    if (LINE_WARNING.test(call.name) && !/^var\(\s*--sr-/.test(call.fallback)) {
      out.push({
        text: `var(${call.name}, ${call.fallback})`,
        chromatic: false,
        line2: `${call.name} may fall back only to another var(--sr-...)`,
      });
      // The fallback's own literal is reported by this rule; do not report it again.
      covered.push([call.fbStart, call.fbEnd]);
      continue;
    }
    const danger = DANGER_FALLBACKS.get(call.name);
    if (danger && literals.length === 1 && sameRgb(literals[0].rgb, danger) && call.fallback === literals[0].text) {
      covered.push([call.fbStart, call.fbEnd]);
      continue;
    }
    if (call.name.startsWith('--sr-') || !defined.has(call.name)) {
      for (const lit of literals) {
        out.push({
          text: lit.text,
          chromatic: true,
          fallbackOf: call.name.startsWith('--sr-') ? call.name : `${call.name} (declared nowhere)`,
          family: familyOf(lit),
          guarded: inGuardedHue(lit),
        });
      }
      covered.push([call.fbStart, call.fbEnd]);
    }
  }
  for (const lit of literalsIn(value, { named: namedColours })) {
    if (covered.some(([a, b]) => lit.start >= a && lit.end <= b)) continue;
    if (!isChromatic(lit)) continue;
    out.push({ text: lit.text, chromatic: true, family: familyOf(lit), guarded: inGuardedHue(lit) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scripts

/** The quoted strings of a script, comments skipped: { text, line }. */
function stringsOf(source) {
  const out = [];
  const starts = computeLineStarts(source);
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i += 1;
        if (c !== '`' && source[i] === '\n') break;
        i += 1;
      }
      out.push({ text: source.slice(start + 1, i), line: lineForOffset(starts, start) });
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

function scanScript(file, source, allowlist) {
  if (allowlist.some((entry) => entry.file === file)) return [];
  const exempt = exemptLines(source);
  const lines = source.split('\n');
  const hits = [];
  for (const { text, line } of stringsOf(source)) {
    if (!/#[0-9a-f]{6}|rgba?\(|hsla?\(/i.test(text)) continue;
    for (const lit of literalsIn(text, { hex: [6, 8] })) {
      if (!isChromatic(lit)) continue;
      const at = line + (text.slice(0, lit.start).match(/\n/g)?.length ?? 0);
      if (exempt.has(at)) continue;
      const rules = [];
      const family = familyOf(lit);
      if (family) rules.push(3);
      if (inGuardedHue(lit)) rules.push(5);
      if (rules.length === 0) continue;
      hits.push({
        file,
        line: at,
        selector: '(script)',
        decl: lines[at - 1]?.trim().slice(0, 120) ?? lit.text,
        rules,
        reason: family
          ? `${family} is a token: read it with readToken (src/lib/readToken.ts), or add a palette-exempt comment with the reason`
          : 'red, orange, yellow and green mean a status: use a token, or add a palette-exempt comment with the reason',
        literal: lit.text,
      });
    }
  }
  return hits;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
