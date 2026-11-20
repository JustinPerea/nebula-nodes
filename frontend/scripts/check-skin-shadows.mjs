import { readdirSync, readFileSync, statSync } from 'node:fs';
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
//   (c) the same as (b) when the unprefixed declaration sits inside an at-rule (@media, @supports,
//       @container) and its prefixed twin is at the top level. The twin wins at every width, so the
//       override never applies. This is reported on its own: the fix is to move the override into a
//       `body.app-slava-restraint` rule inside the same at-rule, after the twin, not to delete it.
// (a) is anchored to the leftmost compound of the selector: `body:not(.app-slava-restraint)` on
// body, or a legacy class as a plain class there (not inside :is()/:where()/:not() alternatives).
// (b) and (c) skip a selector whose leftmost compound can match html or body (`html`, `:root`,
// `body`, `*`, a bare pseudo-element, an attribute, or a class some component sets on body or
// html, read from src/), because `body.app-slava-restraint S` cannot match where S matches.
// Exempt a deliberate case with `skin-shadow-exempt: <reason>` on the rule's selector line or
// the line above it. An exemption with an empty reason is not one and fails the check.
//
// Known false negatives (this is a text check, not a CSS engine):
//   - nested CSS rules (`&`, or a `{` between declarations) are skipped;
//   - selectors match by text, so a twin that spells a combinator with different whitespace
//     (`.a>.b` against `.a > .b`) or an attribute with different quoting (`[x=y]` against
//     `[x="y"]`) is not recognised;
//   - a legacy class or `:not(.app-slava-restraint)` that is not in the leftmost compound
//     (`html body:not(...)`) is not reported;
//   - the import graph is ignored: a twin in a lazily loaded sheet still counts.

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

/** Split a compound's top level from its functional pseudo-classes: `plain` is the text outside every `(...)` and `[...]`, `groups` the `:name(inner)` groups at the top level. */
function splitCompound(compound) {
  let plain = '';
  const groups = [];
  let depth = 0;
  let bracket = 0;
  let groupStart = -1;
  for (let i = 0; i < compound.length; i += 1) {
    const c = compound[i];
    if (bracket > 0) {
      if (c === '[') bracket += 1;
      if (c === ']') bracket -= 1;
    } else if (c === '(') {
      if (depth === 0) groupStart = i;
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        const head = /(:[\w-]+)$/.exec(plain);
        groups.push({ name: head ? head[1] : '', inner: compound.slice(groupStart + 1, i).trim() });
        plain = plain.replace(/:[\w-]+$/, '');
      }
    } else if (depth > 0) {
      // Inside a group: not part of the top level.
    } else if (c === '[') {
      bracket = 1;
    } else {
      plain += c;
    }
  }
  return { plain, groups };
}

/** The first compound of a selector: everything before the first combinator outside `(...)` and `[...]`. */
export function leftmostCompound(selector) {
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(c)) return selector.slice(0, i);
  }
  return selector;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why one selector (no comma) can never match, or null. Only the leftmost compound is read. */
export function deadSelectorReason(selector, legacyClasses) {
  const { plain, groups } = splitCompound(leftmostCompound(selector));
  if (/^body(?![\w-])/.test(plain) && groups.some((group) => group.name === ':not' && group.inner === '.app-slava-restraint')) {
    return 'requires body:not(.app-slava-restraint)';
  }
  for (const name of legacyClasses) {
    if (new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`).test(plain)) return `requires the legacy body class .${name}`;
  }
  return null;
}

/**
 * Whether `body.app-slava-restraint S` could fail to match where S matches: S's leftmost compound
 * can itself be html or body (a tag, `:root`, `*`, a bare pseudo-element, an attribute that a
 * component may set on them, or a class in bodyClasses), so the prefixed twin would need body
 * to be a descendant of itself.
 */
export function leftmostMayBeRoot(selector, bodyClasses) {
  const compound = leftmostCompound(selector);
  if (/^(?:html|body)(?![\w-])/.test(compound) || /^[:*[]/.test(compound)) return true;
  const { plain } = splitCompound(compound);
  return bodyClasses.some((name) => new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`).test(plain));
}

/** Class names components add to document.body or document.documentElement, read from source text. */
export function readBodyClasses(sources) {
  const names = new Set();
  for (const source of sources) {
    for (const call of source.matchAll(/(?:document\.body|document\.documentElement)\.classList\.(?:add|toggle|remove|replace)\(([^)]*)\)/g)) {
      for (const literal of call[1].matchAll(/['"`]([^'"`$]+)['"`]/g)) {
        for (const name of literal[1].split(/\s+/)) if (name) names.add(name);
      }
    }
  }
  return [...names];
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
      const marks = rawLines.slice(Math.max(0, line - span - 1), line).filter((text) => text.includes(EXEMPT));
      const reasons = marks.map((text) => text.slice(text.indexOf(EXEMPT) + EXEMPT.length).replace(/\*\/.*$/, '').trim());
      const exempt = reasons.some(Boolean);
      const emptyExempt = marks.length > 0 && !exempt;
      const decls = parseDeclarations(rule.body, rule.bodyStart).map((decl) => ({
        ...decl,
        line: lineForOffset(starts, decl.offset),
        important: /!\s*important\s*$/i.test(decl.value),
      }));
      return { ...rule, file, line, exempt, emptyExempt, decls, selectors: splitList(rule.selector) };
    });
  return rules;
}

/**
 * Dead CSS across a set of stylesheets: [{ file, kind: 'a' | 'b' | 'c' | 'x', line, selector, reason? / prop?, shadow?: { file, line, selector } }].
 * `sheets` is [{ file, source }].
 */
export function findSkinShadows(sheets, legacyClasses, bodyClasses = []) {
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
    if (rule.emptyExempt) hits.push({ file: rule.file, kind: 'x', line: rule.line, selector: rule.selector });
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
      if (leftmostMayBeRoot(selector, bodyClasses)) continue;
      const candidates = (prefixed.get(selector) ?? []).filter((other) => other !== rule);
      const sameBlock = candidates.filter((other) => other.group === rule.group);
      const topLevel = rule.group === '' ? [] : candidates.filter((other) => other.group === '');
      if (sameBlock.length === 0 && topLevel.length === 0) continue;
      for (const decl of rule.decls) {
        if (decl.important) continue;
        for (const [kind, others] of [['b', sameBlock], ['c', topLevel]]) {
          const other = others.find((candidate) => candidate.decls.some((d) => covers(d.prop, decl.prop)));
          if (!other) continue;
          const cover = other.decls.find((d) => covers(d.prop, decl.prop));
          hits.push({
            file: rule.file,
            kind,
            line: decl.line,
            ruleLine: rule.line,
            selector,
            prop: decl.prop,
            offset: decl.offset,
            atRule: rule.group,
            shadow: { file: other.file, line: other.line, selector: `${PREFIX} ${selector}`, prop: cover.prop },
          });
          break;
        }
      }
    }
  }
  return hits;
}

function collectSourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return collectSourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

function main() {
  const files = collectCssFiles(SRC);
  const bodyClasses = readBodyClasses(collectSourceFiles(SRC).map((file) => readFileSync(file, 'utf8')));
  const legacy = readLegacyBodyClasses(readFileSync(SKINS, 'utf8'));
  const sheets = files.map((file) => ({ file: relative(SRC, file), source: readFileSync(file, 'utf8') }));
  const hits = findSkinShadows(sheets, legacy, bodyClasses);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(hits, null, 1));
    return;
  }
  if (hits.length > 0) {
    console.error('This CSS can never apply: the app always runs with body.app-slava-restraint and none of the legacy body classes. Delete it, or add `skin-shadow-exempt: <reason>` on the rule. Where a line says "never applies", move the override instead (see that line).');
    for (const hit of hits) {
      if (hit.kind === 'a') console.error(`  src/${hit.file}:${hit.line} ${hit.selector} ${hit.reason}`);
      else if (hit.kind === 'x') console.error(`  src/${hit.file}:${hit.line} ${hit.selector} has \`skin-shadow-exempt:\` with no reason; write why the rule is kept, or remove the comment.`);
      else if (hit.kind === 'c') console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop} inside ${hit.atRule.replace(/@\d+;/g, ' ').trim()}, but src/${hit.shadow.file}:${hit.shadow.line} ${hit.shadow.selector} (${hit.shadow.prop}) at the top level wins at every width: the override never applies. Move it into a ${PREFIX} rule inside the same at-rule, after that rule (do not delete it).`);
      else console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}, overridden by src/${hit.shadow.file}:${hit.shadow.line} ${hit.shadow.selector} (${hit.shadow.prop})`);
    }
    process.exit(1);
  }
  console.log(`Skin-shadow guard passed (${files.length} stylesheets scanned).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
