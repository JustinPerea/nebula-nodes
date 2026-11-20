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

// Design: the app has one appearance. applySkinBodyClass (src/lib/skins.ts) removes the legacy
// body classes and adds `app-slava-restraint` before first paint, every time. So two kinds of
// CSS can never apply:
//   (a) a rule whose selector requires `body:not(.app-slava-restraint)` or one of the legacy
//       body classes (a comma list is checked part by part);
//   (b) a declaration on an unprefixed selector S when a rule `body.app-slava-restraint S`
//       (same selector text) declares the same property and applies whenever the unprefixed one
//       does: the prefixed rule sits at the top level or in the same at-rule block. The prefixed
//       selector has more specificity, so the unprefixed declaration never wins. A declaration
//       marked !important is not reported. A prefixed shorthand covers the longhands it resets
//       (`background` covers `background-color`), never the other way round.
// Exempt a deliberate case with `skin-shadow-exempt: <reason>` on the rule's selector line or
// the line above it.

const SRC = join(import.meta.dirname, '..', 'src');
const SKINS = join(SRC, 'lib', 'skins.ts');
const PREFIX = 'body.app-slava-restraint';
const EXEMPT = 'skin-shadow-exempt:';

/** The legacy body classes, read from skins.ts so the list and this check can't drift. */
export function readLegacyBodyClasses(skinsSource) {
  const block = /LEGACY_BODY_CLASSES\s*=\s*\[([\s\S]*?)\]/.exec(skinsSource);
  if (!block) throw new Error('LEGACY_BODY_CLASSES not found in skins.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const SHORTHANDS = {
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip'],
  border: ['border-color', 'border-width', 'border-style', 'border-image', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-top': ['border-top-color', 'border-top-width', 'border-top-style'],
  'border-right': ['border-right-color', 'border-right-width', 'border-right-style'],
  'border-bottom': ['border-bottom-color', 'border-bottom-width', 'border-bottom-style'],
  'border-left': ['border-left-color', 'border-left-width', 'border-left-style'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  overflow: ['overflow-x', 'overflow-y'],
  outline: ['outline-color', 'outline-width', 'outline-style'],
  font: ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height', 'font-stretch'],
  gap: ['row-gap', 'column-gap'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  'text-decoration': ['text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness'],
};

/** Whether a prefixed declaration of `prefixedProp` sets everything an unprefixed `prop` declaration sets. */
export function covers(prefixedProp, prop) {
  return prefixedProp === prop || (SHORTHANDS[prefixedProp]?.includes(prop) ?? false);
}

export function splitList(selector) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => compact(part.trim())).filter(Boolean);
}

/** The selector with every `:not(...)` group removed, so a class named only inside one isn't read as required. */
function withoutNegations(selector) {
  let out = '';
  for (let i = 0; i < selector.length; i += 1) {
    if (selector.startsWith(':not(', i)) {
      let depth = 0;
      let j = i + 4;
      for (; j < selector.length; j += 1) {
        if (selector[j] === '(') depth += 1;
        if (selector[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      i = j;
    } else {
      out += selector[i];
    }
  }
  return out;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why one selector (no comma) can never match, or null. */
export function deadSelectorReason(selector, legacyClasses) {
  if (/:not\(\s*\.app-slava-restraint\s*\)/.test(selector)) return 'requires body:not(.app-slava-restraint)';
  const positive = withoutNegations(selector);
  for (const name of legacyClasses) {
    if (new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`).test(positive)) return `requires the legacy body class .${name}`;
  }
  return null;
}

function loadSheet(source, file) {
  const css = stripComments(source);
  const starts = computeLineStarts(css);
  const rawLines = source.split('\n');
  const rules = parseRules(css)
    .filter((rule) => !rule.nested)
    .map((rule) => {
      const line = lineForOffset(starts, rule.bodyStart - 1);
      const span = rule.selector.split('\n').length;
      const exempt = rawLines.slice(Math.max(0, line - span - 1), line).some((text) => text.includes(EXEMPT));
      const decls = parseDeclarations(rule.body, rule.bodyStart).map((decl) => ({
        ...decl,
        line: lineForOffset(starts, decl.offset),
        important: /!\s*important\s*$/i.test(decl.value),
      }));
      return { ...rule, file, line, exempt, decls, selectors: splitList(rule.selector) };
    });
  return rules;
}

/**
 * Dead CSS across a set of stylesheets: [{ file, kind: 'a' | 'b', line, selector, reason? / prop?, shadow?: { file, line, selector } }].
 * `sheets` is [{ file, source }].
 */
export function findSkinShadows(sheets, legacyClasses) {
  const rules = sheets.flatMap((sheet) => loadSheet(sheet.source, sheet.file));
  const hits = [];

  // Prefixed declarations by unprefixed selector text: the later of two prefixed rules wins, so any one that covers the property is enough.
  const prefixed = new Map();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (!selector.startsWith(`${PREFIX} `)) continue;
      const base = selector.slice(PREFIX.length + 1);
      if (!prefixed.has(base)) prefixed.set(base, []);
      prefixed.get(base).push(rule);
    }
  }

  for (const rule of rules) {
    if (rule.exempt) continue;
    const dead = rule.selectors.map((selector) => deadSelectorReason(selector, legacyClasses));
    if (dead.every(Boolean) && dead.length > 0) {
      hits.push({ file: rule.file, kind: 'a', line: rule.line, selector: rule.selector, reason: dead[0] });
      continue;
    }
    dead.forEach((reason, index) => {
      if (reason) hits.push({ file: rule.file, kind: 'a', line: rule.line, selector: rule.selectors[index], reason, partial: true });
    });
    for (const selector of rule.selectors) {
      if (selector.startsWith(`${PREFIX} `)) continue;
      const candidates = (prefixed.get(selector) ?? []).filter((other) => other !== rule && (other.group === '' || other.group === rule.group));
      if (candidates.length === 0) continue;
      for (const decl of rule.decls) {
        if (decl.important) continue;
        for (const other of candidates) {
          const cover = other.decls.find((d) => covers(d.prop, decl.prop));
          if (!cover) continue;
          hits.push({
            file: rule.file,
            kind: 'b',
            line: decl.line,
            ruleLine: rule.line,
            selector,
            prop: decl.prop,
            offset: decl.offset,
            shadow: { file: other.file, line: other.line, selector: `${PREFIX} ${selector}`, prop: cover.prop },
          });
          break;
        }
      }
    }
  }
  return hits;
}

function main() {
  const files = collectCssFiles(SRC);
  const legacy = readLegacyBodyClasses(readFileSync(SKINS, 'utf8'));
  const sheets = files.map((file) => ({ file: relative(SRC, file), source: readFileSync(file, 'utf8') }));
  const hits = findSkinShadows(sheets, legacy);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(hits, null, 1));
    return;
  }
  if (hits.length > 0) {
    console.error('This CSS can never apply: the app always runs with body.app-slava-restraint and none of the legacy body classes. Delete it, or add `skin-shadow-exempt: <reason>` on the rule.');
    for (const hit of hits) {
      if (hit.kind === 'a') console.error(`  src/${hit.file}:${hit.line} ${hit.selector} ${hit.reason}`);
      else console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}, overridden by src/${hit.shadow.file}:${hit.shadow.line} ${hit.shadow.selector} (${hit.shadow.prop})`);
    }
    process.exit(1);
  }
  console.log(`Skin-shadow guard passed (${files.length} stylesheets scanned).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
