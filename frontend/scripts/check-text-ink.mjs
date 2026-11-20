import { readFileSync, readdirSync, statSync } from 'node:fs';
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

// Design: text takes the light ink, var(--sr-ink-light). Meta ink (--sr-ink-meta, white at .40)
// measures 3.6 to 3.9:1 on every surface the app draws, under the 4.5:1 text needs, so it is for
// non-text (borders, strokes, ticks, rules, backgrounds, shadows, decoration colours, swatches),
// for a disabled control, and for the icon-only controls named in ICON_ONLY below (an icon needs
// 3:1 and .40 clears it). Hierarchy between two text lines is carried by size and weight.
//
// What fails: a TEXT declaration that resolves to meta ink. TEXT properties are `color` (a
// ::placeholder rule's color included), `-webkit-text-fill-color`, `caret-color`, and `fill` on a
// rule whose selector targets an SVG `text` or `tspan`. "Resolves to meta ink" means:
//   - var(--sr-ink-meta, ...);
//   - var(--x) for any custom property that any rule in src defines as meta ink or as another such
//     alias (followed to a fixed point, so a chain of any length is read);
//   - white at .4 as a literal in every form: rgba(255,255,255,.4 / .40 / 0.4), rgb(255 255 255 / 40%),
//     #ffffff66, #fff6, hsla(0,0%,100%,.4), hsl(0 0% 100% / 40%).
// A fallback counts only when the variable is defined nowhere in src: var(--undefined, <meta>) fails.
//
// Exempt:
//   - a rule whose selector scopes to :disabled, [disabled] or [aria-disabled="true"]; every part of
//     a comma list must be scoped, so one live part in the list still fails;
//   - the icon-only controls in ICON_ONLY, by exact selector (the part after `body.app-slava-restraint `).
// Inline TSX: a `style={{ color: ... }}` (or a `const x = { color: ... }` style object) in src whose
// color is meta ink or the literal fails too.
//
// Rules with an unprefixed form and a `body.app-slava-restraint` twin are checked as written, both
// forms (the unprefixed one is dead CSS that check-skin-shadows reports; checking it as well is
// simpler and costs nothing).
//
// Known limits (this is a text check, not a CSS engine):
//   - nested CSS rules (`&`, or a `{` between declarations) are skipped;
//   - the value must be the colour itself: color-mix(...) of meta ink, or a calc, is not followed;
//   - a custom property defined as meta ink in ANY rule makes every use of it meta, even where
//     another rule overrides it (--swatch is meta by default and overridden per swatch; it is only
//     read by background, so it passes);
//   - TSX: only `color:` on an object literal in a style prop or a style-named object is read; a colour
//     built at run time (a template string, a function result) is not seen;
//   - a canvas or library colour passed as a prop (WaveformAudio's waveColor) is shape, not text.

const SRC = join(import.meta.dirname, '..', 'src');
const PREFIX = 'body.app-slava-restraint';

export const TEXT_PROPS = new Set(['color', '-webkit-text-fill-color', 'caret-color']);

// icon-only: colour tints an svg; non-text, 3:1. Exact selectors, without the body.app-slava-restraint prefix.
export const ICON_ONLY = new Set([
  '.agent-note-card__close',
  '.project-switch-toast__close',
  '.asset-trash__toast-close',
  '.reference-tray__remove',
  '.project-home__search svg',
  '.project-home__cover-close',
  '.project-home__rename',
  '.project-home__trash-toggle svg',
  '.project-home__toast-close',
  '.project-home__empty-search',
  '.project-home__notice-close',
  '.settings-pref--link svg',
  '.panel__header-action',
  '.model-node__header-action',
  '.connection-popup__category-chevron',
  '.connection-popup__close',
  '.chat__tool-icon',
]);

const META_TOKEN = '--sr-ink-meta';

function alphaIsFortyPercent(raw) {
  const text = raw.trim();
  const value = text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
  return Number.isFinite(value) && Math.abs(value - 0.4) < 0.005;
}

/** Whether a whole value is white at .4 in any literal form. */
export function isMetaLiteral(value) {
  const v = value.trim().toLowerCase().replace(/\s*!important$/, '').trim();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 4) return h.slice(0, 3) === 'fff' && h[3] === '6';
    if (h.length === 8) return h.slice(0, 6) === 'ffffff' && h.slice(6) === '66';
    return false;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (!fn) return false;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 4) return false;
  const [a, b, c, alpha] = parts;
  if (!alphaIsFortyPercent(alpha)) return false;
  if (fn[1].startsWith('rgb')) return [a, b, c].every((n) => Number.parseFloat(n) === 255 || n === '100%');
  return Number.parseFloat(a) === 0 && Number.parseFloat(b) === 0 && Number.parseFloat(c) === 100;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/**
 * Whether a value resolves to meta ink, given the set of custom properties that do and the set of
 * custom properties defined anywhere in src (a fallback only matters for a variable defined nowhere).
 */
export function resolvesToMeta(value, metaVars, definedVars) {
  const v = value.trim().replace(/\s*!important$/i, '').trim();
  if (isMetaLiteral(v)) return true;
  const wrapped = /^var\(([\s\S]*)\)$/.exec(v);
  if (!wrapped) return false;
  const [name, ...rest] = splitTopLevel(wrapped[1]);
  if (metaVars.has(name)) return true;
  if (definedVars.has(name) || rest.length === 0) return false;
  return resolvesToMeta(rest.join(','), metaVars, definedVars);
}

/** Every custom property that is meta ink or an alias of one, followed to a fixed point. */
export function collectMetaVars(sources) {
  const defs = new Map();
  for (const { source } of sources) {
    const css = stripComments(source);
    for (const rule of parseRules(css)) {
      if (rule.nested) continue;
      for (const { prop, value } of parseDeclarations(rule.body, rule.bodyStart)) {
        if (!prop.startsWith('--')) continue;
        if (!defs.has(prop)) defs.set(prop, []);
        defs.get(prop).push(value);
      }
    }
  }
  const definedVars = new Set(defs.keys());
  const metaVars = new Set([META_TOKEN]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, values] of defs) {
      if (metaVars.has(name)) continue;
      if (values.some((value) => resolvesToMeta(value, metaVars, definedVars))) {
        metaVars.add(name);
        grew = true;
      }
    }
  }
  return { metaVars, definedVars };
}

export function splitList(selector) {
  return splitTopLevel(selector).map((part) => compact(part)).filter(Boolean);
}

const DISABLED = [/:disabled\b/, /\[disabled\]/, /\[aria-disabled\s*=\s*["']?true["']?\]/];

/** Whether one selector part applies only to a disabled control (a `:not(:disabled)` does not count). */
export function isDisabledScoped(part) {
  const withoutNot = part.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '');
  return DISABLED.some((pattern) => pattern.test(withoutNot));
}

function stripPrefix(part) {
  return part.startsWith(`${PREFIX} `) ? part.slice(PREFIX.length + 1) : part;
}

/** Expand :is(a, b) at the end of a part into its alternatives (the only form the icon list needs). */
function expandIs(part) {
  const match = /^(.*?)(?::is|:where)\(([^()]*)\)(.*)$/.exec(part);
  if (!match) return [part];
  return splitTopLevel(match[2]).map((alt) => `${match[1]}${alt}${match[3]}`.trim());
}

function isIconOnly(part) {
  return expandIs(stripPrefix(part)).every((alt) => ICON_ONLY.has(alt));
}

function isSvgTextSelector(part) {
  const lastCompound = part.split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
  return /^(text|tspan)(?![\w-])/.test(lastCompound);
}

/** The TEXT declarations in one stylesheet that resolve to meta ink and are not exempt. */
export function findCssTextInk(files, metaVars, definedVars) {
  const hits = [];
  for (const { file, source } of files) {
    const css = stripComments(source);
    const lineStarts = computeLineStarts(css);
    for (const rule of parseRules(css)) {
      if (rule.nested) continue;
      const parts = splitList(rule.selector);
      for (const decl of parseDeclarations(rule.body, rule.bodyStart)) {
        const textual = TEXT_PROPS.has(decl.prop) || (decl.prop === 'fill' && parts.some(isSvgTextSelector));
        if (!textual || !resolvesToMeta(decl.value, metaVars, definedVars)) continue;
        // Parts of the list this declaration reaches: for fill, only the svg text parts.
        const reached = decl.prop === 'fill' ? parts.filter(isSvgTextSelector) : parts;
        const live = reached.filter((part) => !isDisabledScoped(part) && !isIconOnly(part));
        if (live.length === 0) continue;
        hits.push({
          file,
          line: lineForOffset(lineStarts, decl.offset),
          selector: live.join(', '),
          prop: decl.prop,
          value: decl.value,
        });
      }
    }
  }
  return hits;
}

/**
 * Inline TSX: an object literal key `color:` whose value is meta ink. A line scan: the value runs to the
 * next `,` or `}` outside parentheses and quotes. A var() read is checked against the same alias set.
 */
export function findTsxTextInk(files, metaVars, definedVars) {
  const hits = [];
  for (const { file, source } of files) {
    const lines = source.split('\n');
    lines.forEach((text, index) => {
      for (const match of text.matchAll(/(?<![\w-])(?:color|caretColor|WebkitTextFillColor)\s*:\s*(['"`])([^'"`]*)\1/g)) {
        if (resolvesToMeta(match[2], metaVars, definedVars)) {
          hits.push({ file, line: index + 1, selector: 'inline style', prop: 'color', value: match[2] });
        }
      }
    });
  }
  return hits;
}

export const FAILURE_MESSAGE =
  'Text takes the light ink, var(--sr-ink-light). Meta ink (--sr-ink-meta, white at .40) is for non-text (borders, strokes, ticks, backgrounds, shadows), disabled controls and the named icon-only controls (design). Put the text on var(--sr-ink-light); size and weight carry the hierarchy.';

function collectFiles(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path, extensions));
    else if (extensions.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

export function scan(cssFiles, tsxFiles) {
  const { metaVars, definedVars } = collectMetaVars(cssFiles);
  return [...findCssTextInk(cssFiles, metaVars, definedVars), ...findTsxTextInk(tsxFiles, metaVars, definedVars)];
}

function main() {
  const read = (path) => ({ file: relative(SRC, path), source: readFileSync(path, 'utf8') });
  const cssFiles = collectCssFiles(SRC).map(read);
  const tsxFiles = collectFiles(SRC, ['.tsx', '.ts']).map(read);
  const hits = scan(cssFiles, tsxFiles);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(hits, null, 1));
    return;
  }
  if (hits.length > 0) {
    console.error(FAILURE_MESSAGE);
    for (const hit of hits) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}: ${hit.value}`);
    process.exit(1);
  }
  console.log(`Text-ink guard passed (${cssFiles.length} stylesheets, ${tsxFiles.length} TS files scanned).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
