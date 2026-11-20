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

// Design: orange is the brand accent, not a status. The badge classes listed under findCapsBadges
// (World, Saved, Cover and the like) take the accent-free rule too: no accent var or literal. A state badge (`commons-badge--*`) or a
// source tag (`commons-source--*`) is neutral, or uses the pending, warning or success tone;
// it is never painted in the accent.
//
// This reads every stylesheet under src and fails on a rule whose selector holds one of those
// state modifiers and sets color, border (any side), outline-color, background or a fill to the accent:
// var(--sr-accent...) or the literal #FF5A1F (with or without alpha) / rgba(255, 90, 31, ...),
// or the destructive red var(--sr-danger...): a badge is a state, never a destructive action.
// --sr-error is the warning tone, so a failure badge may use it. The base
// .commons-badge and .commons-source rules are held to the same rule, and box-shadow, text-shadow,
// border-image and the other colour-bearing properties count. Known limit: a colour reached
// through another custom property (`--x: var(--sr-accent)`) or set from TSX is not followed.
// The no-accent check sees only a literal `var(--sr-accent…)`: a badge whose colour reads an alias
// token (like `--evaluation-unsaved-ink`) is not checked for the accent.
// CSS nesting under a badge selector is not read, so it fails.
// Role badges (`commons-badge--role-*`: Attract, Avoid) are neutral by rule: design says a role is a
// category, not good or bad news, so a role rule may not set color, border or background at all
// (the plain badge colours come from the base .commons-badge rule). There is no allow-list.

const SRC = join(process.cwd(), 'src');
const MODIFIER = /\.commons-(?:badge|source)--[\w-]+/;
/** The badge or source class itself, with or without a modifier: the base rule may not use the accent either. */
const BADGE = /\.commons-(?:badge|source)(?![\w])/;
const COLOUR_PROP = /^(?:color|fill|stroke|background(?:-color|-image)?|outline(?:-color)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?|border-image(?:-source)?|box-shadow|text-shadow|accent-color|caret-color|text-decoration(?:-color)?|column-rule(?:-color)?)$/i;
const ROLE = /\.commons-badge--role-[\w-]+/;
const ACCENT_VAR = /var\(\s*--sr-accent(?![\w])[\w-]*/i;
const DANGER_VAR = /var\(\s*--sr-danger(?![\w])[\w-]*/i;
// #FF5A1F, with or without an alpha pair (#FF5A1FCC), and rgb()/rgba() of 255 90 31.
const ACCENT_LITERAL = /#ff5a1f(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*255\s*[, ]\s*90\s*[, ]\s*31\b/i;

function main() {
  const files = collectCssFiles(SRC);
  const hits = [];
  const capsHits = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    hits.push(...findAccentBadges(source, relative(SRC, file)));
    capsHits.push(...findCapsBadges(source, relative(SRC, file)));
  }
  if (capsHits.length > 0) {
    console.error('A badge or tag is drawn in capitals. A badge reads in sentence case; only a field label keeps its caps (design).');
    for (const hit of capsHits) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} { ${hit.decl} }${hit.reason ? `  (${hit.reason})` : ''}`);
    process.exit(1);
  }
  if (hits.length > 0) {
    console.error('A state badge is painted in the brand accent. Use the neutral, pending, warning or success tone (design: orange is the brand accent, not a status).');
    for (const hit of hits) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} { ${hit.decl} }  (${hit.reason})`);
    process.exit(1);
  }
  console.log(`Badge tone guard passed (${files.length} stylesheets scanned).`);
}

/** Every declaration on a state-badge selector that paints the accent: { file, line, selector, decl, reason }. */
export function findAccentBadges(source, file) {
  const css = stripComments(source);
  const lineStarts = computeLineStarts(css);
  const hits = [];
  for (const rule of parseRules(css)) {
    const selector = compact(rule.selector);
    const commons = BADGE.test(selector);
    // Design: the named badge classes (the list below) never take the accent either. The suffix
    // match (__badge, __tag, __state, __status) stays with the caps rule: other accent badges are for design to rule on.
    if (!commons && !selector.split(',').some((part) => [...part.matchAll(CLASS)].some((m) => noAccentClass(m[1])))) continue;
    // Nested CSS isn't read: a nested block under any badge selector (`.commons-badge { &--inbox {...} }`) fails.
    if (rule.nested) {
      hits.push({ file, line: lineForOffset(lineStarts, rule.bodyStart), selector, decl: '{ ... }', reason: "nested CSS isn't read by this check; write each rule on its own" });
      continue;
    }
    for (const declaration of parseDeclarations(rule.body, rule.bodyStart)) {
      if (!COLOUR_PROP.test(declaration.prop)) continue;
      const reason = !commons
        ? ACCENT_VAR.test(declaration.value)
          ? 'the brand accent: a badge is a kind or a state, not the current selection'
          : ACCENT_LITERAL.test(declaration.value)
            ? 'the literal accent colour'
            : null
        : ROLE.test(selector)
        ? 'a role badge is neutral: it takes the plain badge colours'
        : ACCENT_VAR.test(declaration.value)
        ? 'the brand accent'
        : DANGER_VAR.test(declaration.value)
        ? 'the destructive red: a badge is a state, not a destructive action'
        : ACCENT_LITERAL.test(declaration.value)
          ? 'the literal accent colour'
          : null;
      if (reason) hits.push({ file, line: lineForOffset(lineStarts, declaration.offset), selector, decl: `${declaration.prop}: ${compact(declaration.value)}`, reason });
    }
  }
  return hits;
}

// Design: a badge or tag, whether it carries a state or a kind, reads in sentence case. A field
// label (the small heading over a field or section) keeps its caps, so only badge-shaped class
// names are read: the commons badge and source classes, the explicit list of non-Commons badges
// below, and any class that ends in __badge, __tag, __state or __status or contains -badge.
const NAMED_BADGES = new Set([
  'world-modal__status', 'moodboard-studio-toolbar__state', 'moodboard-view-switch__badge',
  'world-preview__badge', 'character-studio-toolbar__state', 'jev-result__badge', 'character-def__ref-badge', 'reference-set-node__role-badge',
  'commons-unsaved',
]);
const CLASS = /\.(-?[_a-zA-Z][\w-]*)/g;
// Badges design moved off the accent, matched by the exact class so a sibling keeps its tone:
// `.cinema-shots-rail__badge` (the unread count) stays accent, its `--running` variant does not.
const NO_ACCENT_CLASSES = new Set([
  'moodboard-tile__cover', 'moodboard-color__flag', 'cinema-shots-rail__badge--running', 'edit-node__speed-badge',
]);
const noAccentClass = (name) => NAMED_BADGES.has(name.replace(/--[\w-]+$/, '')) || NO_ACCENT_CLASSES.has(name);
const BADGE_SUFFIX = /(?:__(?:badge|tag|state|status)(?![a-zA-Z0-9_])|-badge)/;
const CAPS_PROP = /^(?:text-transform|font-variant|font-variant-caps)$/i;
const CAPS_VALUE = /(?:^|\s)(?:uppercase|small-caps|all-small-caps|petite-caps|all-petite-caps)(?![\w-])/i;
const isBadgeClass = (name) => NAMED_BADGES.has(name.replace(/--[\w-]+$/, '')) || /^commons-(?:badge|source)/.test(name) || BADGE_SUFFIX.test(name);

/** True when a rule nested in this body selects a badge class and sets capitals, at any depth. */
function nestedCapsUnderBadge(body) {
  return parseRules(body).some((inner) => {
    const badge = inner.selector.split(',').some((part) => [...part.matchAll(CLASS)].some((m) => isBadgeClass(m[1])));
    if (inner.nested) return nestedCapsUnderBadge(inner.body) || (badge && CAPS_TEXT.test(inner.body));
    return badge && CAPS_TEXT.test(inner.body);
  });
}
const CAPS_TEXT = /(?:text-transform|font-variant(?:-caps)?)\s*:\s*[^;}]*(?:uppercase|small-caps|all-small-caps|petite-caps|all-petite-caps)/i;

/** Every declaration that capitalises a badge or tag: { file, line, selector, decl }. */
export function findCapsBadges(source, file) {
  const css = stripComments(source);
  const lineStarts = computeLineStarts(css);
  const hits = [];
  for (const rule of parseRules(css)) {
    const selector = compact(rule.selector);
    const badgeParts = selector.split(',').filter((part) => [...part.matchAll(CLASS)].some((m) => isBadgeClass(m[1])));
    // Design: nested CSS isn't read, so it fails the same way findAccentBadges does: a nested block
    // under a badge selector, or a badge selector nested under another rule that sets capitals.
    if (rule.nested) {
      const nestedBadge = badgeParts.length > 0 || nestedCapsUnderBadge(rule.body);
      if (nestedBadge) hits.push({ file, line: lineForOffset(lineStarts, rule.bodyStart), selector, decl: '{ ... }', reason: "nested CSS isn't read by this check; write each rule on its own" });
      continue;
    }
    if (badgeParts.length === 0) continue;
    for (const declaration of parseDeclarations(rule.body, rule.bodyStart)) {
      if (CAPS_PROP.test(declaration.prop) && CAPS_VALUE.test(declaration.value)) {
        hits.push({ file, line: lineForOffset(lineStarts, declaration.offset), selector: badgeParts.map((part) => part.trim()).join(', '), decl: `${declaration.prop}: ${compact(declaration.value)}` });
      }
    }
  }
  return hits;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
