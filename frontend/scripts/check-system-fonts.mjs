import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectCssFiles,
  computeLineStarts,
  lineForOffset,
  parseDeclarations,
  parseRules,
  stripComments,
} from './lib/css-scan.mjs';

// Design: one face everywhere. Text in the app is set in the app face, var(--sr-ui) (Inter), which the
// skin puts on body (slava-restraint.css). Two things break that and this check fails both:
//
//   1. A `font-family` or `font` declaration whose FIRST family is a system or browser face:
//      -apple-system, BlinkMacSystemFont, system-ui, ui-sans-serif, 'Segoe UI', Arial, Helvetica, or a
//      bare generic (sans-serif, serif, cursive, fantasy). A system face inside a var() is only the
//      fallback for a missing token and passes; so does a first family that is a named face
//      ('Inter', 'Helvetica Neue'), a mono stack (monospace, ui-monospace, 'SF Mono', ...; readouts
//      and ids are mono by design), `inherit`, and a `font` shorthand with no family in it.
//   2. The rule `:where(button, input, select, textarea) { font: inherit; }` missing from src. A button
//      or field does not inherit the page font on its own (Chrome gives it Arial at 13.33px), and
//      that rule, at zero specificity so every class that sets its own size or weight still wins, is
//      what puts the app face on every control that sets none.
//
// Scope: every stylesheet under frontend/src except src/extraction/. The extraction page is its own
// entry (extraction.html) with its own stylesheet and does not load the app's skin or App.css, so its
// face is that page's own decision, and the base rule above does not reach it.
//
// Known limits (a text check, not a CSS engine):
//   - nested CSS rules (`&`, or a `{` between declarations) are skipped;
//   - a face set through a custom property whose value is a system stack (`--x: system-ui`) is not
//     followed; only the `font-family` and `font` declarations are read;
//   - inline TSX styles (`fontFamily: ...`) are not read.

const SRC = join(import.meta.dirname, '..', 'src');
const EXCLUDED_DIR = 'extraction';

export const BASE_RULE_TEXT = ':where(button, input, select, textarea) { font: inherit; }';
const BASE_RULE_TAGS = ['button', 'input', 'select', 'textarea'];

// First families that are a system or browser face. Compared lower-cased, without quotes.
export const SYSTEM_FACES = new Set([
  '-apple-system',
  'blinkmacsystemfont',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-rounded',
  '-webkit-system-font',
  'segoe ui',
  'arial',
  'helvetica',
  'sans-serif',
  'serif',
  'cursive',
  'fantasy',
]);

const SIZE_KEYWORDS = 'xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller';
// The size of a `font` shorthand, with an optional /line-height, then the family list. A var() has
// already been replaced by VAR_MARK, so a size or a line height that is a token reads like a literal.
const VAR_MARK = '\u0000';
const SHORTHAND_FAMILY = new RegExp(
  `(?:^|\\s)(?:[\\d.]+[a-z%]+|${VAR_MARK}|${SIZE_KEYWORDS})(?:\\s*/\\s*(?:[\\d.]+[a-z%]*|normal|${VAR_MARK}))?\\s+(.+)$`,
  'i',
);

/** The value with every balanced var(...) replaced by one mark: what is inside one is a fallback. */
function maskVars(value) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (/^var\(/i.test(value.slice(i, i + 4))) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j += 1) {
        if (value[j] === '(') depth += 1;
        else if (value[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out += VAR_MARK;
      i = j + 1;
    } else {
      out += value[i];
      i += 1;
    }
  }
  return out;
}

/** The first comma-separated item outside quotes. */
function firstFamily(list) {
  let quote = '';
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') return list.slice(0, i).trim();
  }
  return list.trim();
}

function normaliseFace(face) {
  return face.replace(/^["']|["']$/g, '').trim().toLowerCase();
}

/** The first family a `font-family` or `font` value names, or null when it names none (a var, inherit, no family). */
export function firstFamilyOf(prop, value) {
  const masked = maskVars(value.replace(/!important\s*$/i, '').trim());
  let list = masked;
  if (prop === 'font') {
    const match = SHORTHAND_FAMILY.exec(masked);
    if (!match) return null;
    list = match[1];
  }
  const face = normaliseFace(firstFamily(list));
  if (!face || face.includes(VAR_MARK) || /^(inherit|initial|unset|revert|revert-layer)$/.test(face)) return null;
  return face;
}

/** Declarations in the sheets whose first family is a system or browser face. */
export function findSystemFonts(files) {
  const hits = [];
  for (const { file, source } of files) {
    const css = stripComments(source);
    const lineStarts = computeLineStarts(css);
    for (const rule of parseRules(css)) {
      if (rule.nested) continue;
      for (const decl of parseDeclarations(rule.body, rule.bodyStart)) {
        if (decl.prop !== 'font-family' && decl.prop !== 'font') continue;
        const face = firstFamilyOf(decl.prop, decl.value);
        if (face === null || !SYSTEM_FACES.has(face)) continue;
        hits.push({ file, line: lineForOffset(lineStarts, decl.offset), selector: rule.selector, prop: decl.prop, value: decl.value });
      }
    }
  }
  return hits;
}

/** True when some sheet has :where(button, input, select, textarea) { font: inherit }, in any tag order. */
export function hasBaseRule(files) {
  for (const { source } of files) {
    for (const rule of parseRules(stripComments(source))) {
      if (rule.nested || rule.group !== '') continue;
      const inner = /^:where\(([^()]*)\)$/.exec(rule.selector.trim());
      if (!inner) continue;
      const tags = inner[1].split(',').map((tag) => tag.trim().toLowerCase()).sort();
      if (tags.join() !== [...BASE_RULE_TAGS].sort().join()) continue;
      const font = parseDeclarations(rule.body, 0).find((decl) => decl.prop === 'font');
      if (font && font.value.replace(/!important\s*$/i, '').trim().toLowerCase() === 'inherit') return true;
    }
  }
  return false;
}

export const FAILURE_MESSAGE =
  'One face everywhere (design): text takes the app face, var(--sr-ui), or inherits it. A font-family or font whose first family is a system or browser face (-apple-system, system-ui, Segoe UI, Arial, Helvetica, a bare sans-serif) puts that surface in another typeface. A system face is allowed only as the fallback inside var(). Mono stacks are fine.';

export const MISSING_BASE_MESSAGE = `The base rule is missing from src: ${BASE_RULE_TEXT} (design). Without it a button or field is set in the browser's Arial at 13.33px, not in the app face. Put it with the base element rules in App.css.`;

export function scan(files) {
  return { hits: findSystemFonts(files), baseRule: hasBaseRule(files) };
}

function main() {
  const files = collectCssFiles(SRC)
    .filter((path) => relative(SRC, path).split(sep)[0] !== EXCLUDED_DIR)
    .map((path) => ({ file: relative(SRC, path), source: readFileSync(path, 'utf8') }));
  const { hits, baseRule } = scan(files);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ hits, baseRule }, null, 1));
    return;
  }
  if (hits.length > 0 || !baseRule) {
    if (hits.length > 0) {
      console.error(FAILURE_MESSAGE);
      for (const hit of hits) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}: ${hit.value}`);
    }
    if (!baseRule) console.error(MISSING_BASE_MESSAGE);
    process.exit(1);
  }
  console.log(`System-font guard passed (${files.length} stylesheets scanned, src/${EXCLUDED_DIR}/ excluded).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
