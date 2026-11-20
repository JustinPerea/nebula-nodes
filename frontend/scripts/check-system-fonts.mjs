import { readdirSync, readFileSync, statSync } from 'node:fs';
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
// skin puts on body (slava-restraint.css), or in the app mono, var(--sr-mono) (JetBrains Mono). This
// check fails each of these:
//
//   1. A `font-family` or `font` declaration whose FIRST family is not on the allowlist. Allowed: a
//      var(--token) (rule 2 checks the token exists), the CSS-wide keywords (inherit, initial, unset,
//      revert, revert-layer), and the two faces the app ships, 'Inter' and 'JetBrains Mono' (quoted or
//      not, any case). Everything else is a hit: a system face (-apple-system, system-ui, 'Segoe UI',
//      Arial), a generic (sans-serif, monospace, ui-monospace), or any other named face (Georgia,
//      Roboto). A face after the first family, or inside a var() fallback, is not read. A `font`
//      shorthand that is a system font keyword (caption, icon, menu, message-box, small-caption,
//      status-bar, or a -webkit- / -apple-system- keyword such as -webkit-small-control) is a hit.
//   2. A `var(--name, ...)` that is a declaration's first family, where `--name` is defined in no
//      stylesheet under src (a `--name:` declaration, any selector). The fallback is what renders, so
//      the token only looks like the app face. A token defined only in src/extraction/ counts as
//      undefined, since that page's sheets do not load with the app's.
//   3. A custom property (`--name: value`) used as the first family of a font-family or font, directly
//      or through other custom properties, whose own value leads with a face rule 1 does not allow.
//   4. The base rule. src/App.css (imported by App.tsx, so it loads for every surface) must hold, as a
//      top-level rule (not inside @media, @layer or @supports), a rule whose selector is
//      :where(button, input, select, textarea), in any order, declaring exactly `font-family: inherit`
//      and `font-size: var(--sr-type-control)`, in either order, in any case and spacing, and nothing
//      else. A button or field does not inherit the page font on its own (Chrome gives it Arial at
//      13.33px); that rule puts the app face and the skin's control size on every control, and its zero
//      specificity lets any class that sets its own size keep it. Two things break that promise, and
//      each is a hit that names the declaration:
//        - `!important` on either declaration: every class's own size on a control would lose;
//        - any extra declaration (line-height, font-weight, font, letter-spacing, a repeat of one of
//          the two): weight and line height stay the browser's, and a class's own values win.
//      Any other rule in any sheet whose selector is a :where() over only those tags and that sets
//      font, font-family or font-size is a hit, since it would undo or shadow the base rule. That
//      includes such a rule inside @media, @supports or @layer, at any depth of at-rules.
//   5. An inline style in a .ts or .tsx file under src, `fontFamily: '<string literal>'`, whose first
//      family rule 1 does not allow, unless the file and family are in INLINE_EXCEPTIONS below.
//
// Scope: every stylesheet and every .ts/.tsx file under frontend/src except src/extraction/. The
// extraction page is its own entry (extraction.html) with its own stylesheet and does not load the
// app's skin or App.css, so its face is that page's own decision.
//
// Known limits (a text check, not a CSS engine):
//   - nested CSS rules (`&`, or a `{` between declarations) are skipped, and so is an at-rule written
//     inside a style rule; at-rules around a rule (@media, @supports, @layer, any depth) are read;
//   - inline styles are read only when the value is a plain string literal; template literals and
//     computed values (`fontFamily: `${x}``, `fontFamily: face`) are not read;
//   - only `font-family` and `font` declare a face: a custom property that is never used as a first
//     family is not read.

const SRC = join(import.meta.dirname, '..', 'src');
const EXCLUDED_DIR = 'extraction';
const BASE_RULE_FILE = 'App.css';

export const BASE_RULE_TEXT = ':where(button, input, select, textarea) { font-family: inherit; font-size: var(--sr-type-control); }';
const BASE_RULE_TAGS = ['button', 'input', 'select', 'textarea'];

// Inline fontFamily literals that are deliberate. Each is text drawn into the rendered video, not the
// editor's own chrome, so the face is part of the video's content (design).
export const INLINE_EXCEPTIONS = [
  {
    file: 'components/video-editor/RemotionComposition.tsx',
    family: 'system-ui',
    reason: 'the placeholder a composition draws into the video for a component type with no renderer yet; it is video content, not editor chrome',
  },
  {
    file: 'components/video-editor/components/TextRenderer.tsx',
    family: 'system-ui',
    reason: 'the text track item, drawn into the rendered video; the face is video content, not editor chrome',
  },
];

const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
// The faces the app ships (the @font-face files), compared lower-cased and without quotes.
export const ALLOWED_FACES = new Set(['inter', 'jetbrains mono']);
// `font` values that are a system font, not a size and a family.
const SYSTEM_FONT_KEYWORD = /^(?:caption|icon|menu|message-box|small-caption|status-bar|-webkit-[\w-]+|-apple-system-[\w-]+)$/i;

const SIZE_KEYWORDS = 'xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller';
// The size of a `font` shorthand, with an optional /line-height, then the family list. A var() or a
// calc()/clamp()/min()/max() has already been replaced by a mark, so a size or a line height written
// as one reads like a literal. A bare 0 is a size; any other number needs a unit.
const VAR_MARK = '\u0000';
const FN_MARK = '\u0001';
const SHORTHAND_FAMILY = new RegExp(
  `(?:^|\\s)(?:[\\d.]+[a-z%]+|0|${VAR_MARK}|${FN_MARK}|${SIZE_KEYWORDS})(?:\\s*/\\s*(?:[\\d.]+[a-z%]*|normal|${VAR_MARK}|${FN_MARK}))?\\s+(.+)$`,
  'i',
);

/** Replace every balanced `name(...)` for the given function names with one mark. */
function maskCalls(value, pattern, mark, names) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const head = pattern.exec(value.slice(i, i + 8));
    if (head && head.index === 0 && (i === 0 || !/[\w-]/.test(value[i - 1]))) {
      let depth = 0;
      let j = i + head[0].length - 1;
      for (; j < value.length; j += 1) {
        if (value[j] === '(') depth += 1;
        else if (value[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out += mark;
      if (names) names.push(/^var\(\s*(--[^\s,)]+)/i.exec(value.slice(i, j + 1))?.[1] ?? '');
      i = j + 1;
    } else {
      out += value[i];
      i += 1;
    }
  }
  return out;
}

/** The value with every balanced var(...) replaced by one mark: what is inside one is a fallback. */
function maskVars(value, names) {
  return maskCalls(value, /^var\(/i, VAR_MARK, names);
}

function maskValue(value, names) {
  return maskCalls(maskVars(value, names), /^(?:calc|clamp|min|max)\(/i, FN_MARK);
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

/**
 * The first family a `font-family` or `font` value names, lower-cased, or null when it names none (a
 * var(), a CSS-wide keyword, a shorthand with no family). A system font keyword as a whole `font`
 * value comes back as that keyword.
 */
export function firstFamilyOf(prop, value) {
  const trimmed = value.replace(/!important\s*$/i, '').trim();
  const masked = maskValue(trimmed);
  let list = masked;
  if (prop === 'font') {
    if (SYSTEM_FONT_KEYWORD.test(masked)) return masked.toLowerCase();
    const match = SHORTHAND_FAMILY.exec(masked);
    if (!match) return null;
    list = match[1];
  }
  const face = normaliseFace(firstFamily(list));
  if (!face || face.includes(VAR_MARK) || CSS_WIDE.has(face)) return null;
  return face;
}

/** True when a first family (from firstFamilyOf) is one rule 1 allows. */
export function isAllowedFace(face) {
  return face === null || ALLOWED_FACES.has(face);
}

/** The custom property a value's first family is a var() of, or null when the first family is anything else. */
export function firstFamilyVarOf(prop, value) {
  const names = [];
  const masked = maskValue(value.replace(/!important\s*$/i, '').trim(), names);
  let list = masked;
  let before = '';
  if (prop === 'font') {
    const match = SHORTHAND_FAMILY.exec(masked);
    if (!match) return null;
    list = match[1];
    before = masked.slice(0, match.index + match[0].length - match[1].length);
  }
  if (!firstFamily(list).startsWith(VAR_MARK)) return null;
  const skipped = [...before].filter((ch) => ch === VAR_MARK).length;
  return names[skipped] || null;
}

/** Every custom property a `--name:` declaration defines in the sheets, lower-cased. */
export function definedCustomProperties(files) {
  const defined = new Set();
  for (const { source } of files) {
    for (const match of stripComments(source).matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)) defined.add(match[1].toLowerCase());
  }
  return defined;
}

/** Every non-nested declaration in the sheets, with its file, line and selector. */
function* eachDeclaration(files) {
  for (const { file, source } of files) {
    const css = stripComments(source);
    const lineStarts = computeLineStarts(css);
    for (const rule of parseRules(css)) {
      if (rule.nested) continue;
      for (const decl of parseDeclarations(rule.body, rule.bodyStart)) {
        yield { file, line: lineForOffset(lineStarts, decl.offset), selector: rule.selector, prop: decl.prop, value: decl.value };
      }
    }
  }
}

const isFontProp = (prop) => prop === 'font-family' || prop === 'font';

/** Declarations whose first family is a var() of a token no sheet in `files` defines. */
export function findUndefinedFontTokens(files, defined = definedCustomProperties(files)) {
  const hits = [];
  for (const decl of eachDeclaration(files)) {
    if (!isFontProp(decl.prop)) continue;
    const token = firstFamilyVarOf(decl.prop, decl.value);
    if (token === null || defined.has(token.toLowerCase())) continue;
    hits.push({ ...decl, token });
  }
  return hits;
}

/** Declarations in the sheets whose first family is not on the allowlist. */
export function findSystemFonts(files) {
  const hits = [];
  for (const decl of eachDeclaration(files)) {
    if (!isFontProp(decl.prop)) continue;
    const face = firstFamilyOf(decl.prop, decl.value);
    if (isAllowedFace(face)) continue;
    hits.push({ ...decl, face });
  }
  return hits;
}

/** Custom properties used as a font family, directly or through another custom property, whose value leads with a disallowed face. */
export function findFontTokenHits(files) {
  const decls = [...eachDeclaration(files)];
  const used = new Set();
  for (const decl of decls) {
    if (!isFontProp(decl.prop)) continue;
    const token = firstFamilyVarOf(decl.prop, decl.value);
    if (token) used.add(token.toLowerCase());
  }
  const custom = decls.filter((decl) => decl.prop.startsWith('--'));
  for (let grew = true; grew; ) {
    grew = false;
    for (const decl of custom) {
      if (!used.has(decl.prop)) continue;
      const next = firstFamilyVarOf('font-family', decl.value);
      if (next && !used.has(next.toLowerCase())) {
        used.add(next.toLowerCase());
        grew = true;
      }
    }
  }
  const hits = [];
  for (const decl of custom) {
    if (!used.has(decl.prop)) continue;
    const face = firstFamilyOf('font-family', decl.value);
    if (!isAllowedFace(face)) hits.push({ ...decl, face });
  }
  return hits;
}

/** The tags of a rule whose selector is :where(...) over tags, lower-cased and sorted; null for any other rule. A rule inside an at-rule counts only with `grouped`. */
function whereTags(rule, grouped = false) {
  if (rule.nested || (!grouped && rule.group !== '')) return null;
  const inner = /^:where\(([^()]*)\)$/i.exec(rule.selector.trim());
  if (!inner) return null;
  return inner[1].split(',').map((tag) => tag.trim().toLowerCase()).sort();
}

const isBaseFile = (file) => file.split(sep).join('/') === BASE_RULE_FILE;
const IMPORTANT = /!\s*important\s*$/i;
const clean = (value) => value.replace(IMPORTANT, '').trim();
const BASE_TAGS_KEY = [...BASE_RULE_TAGS].sort().join();

/** The top-level rules of src/App.css whose selector is the base rule's, as { rule, decls } with decls read from the sheet. */
function baseCandidates(files) {
  const out = [];
  for (const { file, source } of files) {
    if (!isBaseFile(file)) continue;
    const css = stripComments(source);
    const lineStarts = computeLineStarts(css);
    for (const rule of parseRules(css)) {
      const tags = whereTags(rule);
      if (!tags || tags.join() !== BASE_TAGS_KEY) continue;
      out.push({ file, rule, line: lineForOffset(lineStarts, rule.bodyStart), decls: parseDeclarations(rule.body, rule.bodyStart) });
    }
  }
  return out;
}

/** The faults of one candidate: an `!important`, or a declaration beyond font-family and font-size (a repeat counts). */
function faultsOf(candidate) {
  const faults = [];
  const seen = new Set();
  for (const decl of candidate.decls) {
    const text = `${decl.prop}: ${clean(decl.value)}`;
    if (IMPORTANT.test(decl.value)) faults.push({ file: candidate.file, line: candidate.line, kind: 'important', declaration: `${text} !important` });
    if ((decl.prop !== 'font-family' && decl.prop !== 'font-size') || seen.has(decl.prop)) faults.push({ file: candidate.file, line: candidate.line, kind: 'extra', declaration: text });
    seen.add(decl.prop);
  }
  return faults;
}

const isExactBase = (candidate) => {
  if (candidate.decls.length !== 2 || faultsOf(candidate).length > 0) return false;
  const family = candidate.decls.find((decl) => decl.prop === 'font-family');
  const size = candidate.decls.find((decl) => decl.prop === 'font-size');
  return Boolean(family && size && clean(family.value).toLowerCase() === 'inherit' && clean(size.value).replace(/\s+/g, '') === 'var(--sr-type-control)');
};

/** True when src/App.css has the base rule as a top-level rule: exactly the two declarations, no !important, any order, case and spacing. */
export function hasBaseRule(files) {
  return baseCandidates(files).some(isExactBase);
}

/** The `!important` and extra declarations that break the base rule's promise, in src/App.css's base-rule-shaped rules: { file, line, kind, declaration }. */
export function findBaseRuleFaults(files) {
  return baseCandidates(files).flatMap(faultsOf);
}

/** :where() rules over the four tags, at the top level or inside any at-rule, other than the base rule itself, that set a font property. */
export function findBaseRuleShadows(files) {
  const shadows = [];
  for (const { file, source } of files) {
    const css = stripComments(source);
    const lineStarts = computeLineStarts(css);
    let seenBase = false;
    for (const rule of parseRules(css)) {
      const tags = whereTags(rule, true);
      if (!tags || tags.length === 0 || !tags.every((tag) => BASE_RULE_TAGS.includes(tag))) continue;
      const decls = parseDeclarations(rule.body, rule.bodyStart);
      const fontDecls = decls.filter((decl) => decl.prop === 'font' || decl.prop === 'font-family' || decl.prop === 'font-size');
      if (fontDecls.length === 0) continue;
      const isBase = isBaseFile(file) && !seenBase && rule.group === '' && isExactBase({ file, decls });
      if (isBase) {
        seenBase = true;
        continue;
      }
      shadows.push({ file, line: lineForOffset(lineStarts, fontDecls[0].offset), selector: rule.selector, prop: fontDecls[0].prop, value: fontDecls[0].value, group: rule.group !== '' });
    }
  }
  return shadows;
}

/** The first-family hits for `fontFamily: '...'` string literals in .ts/.tsx sources, minus INLINE_EXCEPTIONS. */
export function findInlineFonts(files, exceptions = INLINE_EXCEPTIONS) {
  const hits = [];
  for (const { file, source } of files) {
    const lineStarts = computeLineStarts(source);
    for (const match of source.matchAll(/\bfontFamily\s*:\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const face = firstFamilyOf('font-family', match[2]);
      if (isAllowedFace(face)) continue;
      const path = file.split(sep).join('/');
      if (exceptions.some((entry) => entry.file === path && entry.family === face)) continue;
      hits.push({ file, line: lineForOffset(lineStarts, match.index), value: match[2], face });
    }
  }
  return hits;
}

export const FAILURE_MESSAGE =
  'One face everywhere (design): text takes the app face, var(--sr-ui), or the app mono, var(--sr-mono), or inherits one. A font-family or font whose first family is anything else (a system face such as -apple-system, system-ui, Segoe UI or Arial; a generic such as sans-serif or monospace; ui-monospace; any other named face; a system font keyword such as caption or menu) puts that surface in another typeface. Use var(--sr-ui) or var(--sr-mono). A face after the first family, or inside var(), is only a fallback and is not read.';

export const UNDEFINED_TOKEN_MESSAGE =
  'A font declaration leads with a custom property that no stylesheet under src defines (design). The fallback after it is what renders, so the surface is in the fallback face, not the app face. Point it at var(--sr-ui) or var(--sr-mono), or define the token.';

export const FONT_TOKEN_MESSAGE =
  'A custom property used as a font family leads with a face the app does not allow (design). Every surface that reads it is set in that face. Point it at var(--sr-ui) or var(--sr-mono).';

export const MISSING_BASE_MESSAGE = `The base rule is missing from src/${BASE_RULE_FILE}: ${BASE_RULE_TEXT} (design). It must be a top-level rule in src/${BASE_RULE_FILE}, the sheet App.tsx imports, not inside @media or @layer and not in another file. Without it a button or field is set in the browser's Arial at 13.33px, not in the app face at the control size.`;

export const BASE_SHADOW_MESSAGE =
  'A :where(button, input, select, textarea) rule other than the base rule sets font, font-family or font-size (design), at the top level or inside @media, @supports or @layer. It undoes or shadows the base rule in src/App.css. Put the face and size on the class that needs them, or edit the base rule in src/App.css.';

export const BASE_IMPORTANT_MESSAGE =
  'The base rule in src/App.css has !important on a declaration (design). Its zero specificity is what lets a class set its own size on a control; with !important every class\'s own size would lose to the control size. Remove the !important.';

export const BASE_EXTRA_MESSAGE =
  'The base rule in src/App.css declares more than font-family: inherit and font-size: var(--sr-type-control) (design). Weight and line height stay the browser\'s and a class\'s own values win; an extra declaration changes every control that sets none of its own. Put it on the class that needs it.';

export const INLINE_MESSAGE =
  'An inline fontFamily string leads with a face the app does not allow (design). Use var(--sr-ui) or var(--sr-mono), or add the file and family to INLINE_EXCEPTIONS in scripts/check-system-fonts.mjs with the reason, when the text is drawn into rendered content and not into the app.';

export function scan(files, sourceFiles = []) {
  return {
    hits: findSystemFonts(files),
    undefinedTokens: findUndefinedFontTokens(files),
    fontTokens: findFontTokenHits(files),
    baseRule: hasBaseRule(files),
    baseRuleFaults: findBaseRuleFaults(files),
    baseRuleShadows: findBaseRuleShadows(files),
    inlineHits: findInlineFonts(sourceFiles),
  };
}

function walk(dir, test, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, test, out);
    else if (test(entry)) out.push(path);
  }
  return out;
}

const excluded = (srcDir, path) => relative(srcDir, path).split(sep)[0] === EXCLUDED_DIR;

/** Every stylesheet under srcDir except src/extraction/, as { file (relative to srcDir), source }. */
export function collectAppSheets(srcDir) {
  return collectCssFiles(srcDir)
    .filter((path) => !excluded(srcDir, path))
    .map((path) => ({ file: relative(srcDir, path), source: readFileSync(path, 'utf8') }));
}

/** Every .ts/.tsx source under srcDir except src/extraction/ and test files, as { file, source }. */
export function collectAppSources(srcDir) {
  return walk(srcDir, (name) => /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
    .filter((path) => !excluded(srcDir, path))
    .map((path) => ({ file: relative(srcDir, path), source: readFileSync(path, 'utf8') }));
}

function main() {
  const files = collectAppSheets(SRC);
  const result = scan(files, collectAppSources(SRC));
  const { hits, undefinedTokens, fontTokens, baseRule, baseRuleFaults, baseRuleShadows, inlineHits } = result;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 1));
    return;
  }
  const failed = hits.length + undefinedTokens.length + fontTokens.length + baseRuleFaults.length + baseRuleShadows.length + inlineHits.length > 0 || !baseRule;
  if (failed) {
    if (hits.length > 0) {
      console.error(FAILURE_MESSAGE);
      for (const hit of hits) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}: ${hit.value}`);
    }
    if (undefinedTokens.length > 0) {
      console.error(UNDEFINED_TOKEN_MESSAGE);
      for (const hit of undefinedTokens) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}: ${hit.value} (${hit.token} is defined nowhere)`);
    }
    if (fontTokens.length > 0) {
      console.error(FONT_TOKEN_MESSAGE);
      for (const hit of fontTokens) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}: ${hit.value}`);
    }
    if (!baseRule && baseRuleFaults.length === 0) console.error(MISSING_BASE_MESSAGE);
    for (const [kind, message] of [['important', BASE_IMPORTANT_MESSAGE], ['extra', BASE_EXTRA_MESSAGE]]) {
      const faults = baseRuleFaults.filter((fault) => fault.kind === kind);
      if (faults.length === 0) continue;
      console.error(message);
      for (const fault of faults) console.error(`  src/${fault.file}:${fault.line} ${fault.declaration}`);
    }
    if (baseRuleShadows.length > 0) {
      console.error(BASE_SHADOW_MESSAGE);
      for (const hit of baseRuleShadows) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}: ${hit.value}`);
    }
    if (inlineHits.length > 0) {
      console.error(INLINE_MESSAGE);
      for (const hit of inlineHits) console.error(`  src/${hit.file}:${hit.line} fontFamily: ${hit.value}`);
    }
    process.exit(1);
  }
  console.log(`System-font guard passed (${files.length} stylesheets scanned, src/${EXCLUDED_DIR}/ excluded).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
