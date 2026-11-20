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

// Design: orange is the brand accent, not a status. A state badge (`commons-badge--*`) or a
// source tag (`commons-source--*`) is neutral, or uses the pending, warning or success tone;
// it is never painted in the accent.
//
// This reads every stylesheet under src and fails on a rule whose selector holds one of those
// state modifiers and sets color, border (any side), outline-color, background or a fill to the accent:
// var(--sr-accent...), var(--sr-error...) or var(--sr-danger...) (the last two alias the
// accent), or the literal #FF5A1F (with or without alpha) / rgba(255, 90, 31, ...). The base
// .commons-badge and .commons-source rules are held to the same rule, and box-shadow, text-shadow,
// border-image and the other colour-bearing properties count. Known limit: a colour reached
// through another custom property (`--x: var(--sr-accent)`) or set from TSX is not followed.
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
const ACCENT_VAR = /var\(\s*--sr-(?:accent|error|danger)(?![\w])[\w-]*/i;
// #FF5A1F, with or without an alpha pair (#FF5A1FCC), and rgb()/rgba() of 255 90 31.
const ACCENT_LITERAL = /#ff5a1f(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*255\s*[, ]\s*90\s*[, ]\s*31\b/i;

function main() {
  const files = collectCssFiles(SRC);
  const hits = [];
  for (const file of files) hits.push(...findAccentBadges(readFileSync(file, 'utf8'), relative(SRC, file)));
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
    if (!BADGE.test(selector)) continue;
    // Nested CSS isn't read: a nested block under any badge selector (`.commons-badge { &--inbox {...} }`) fails.
    if (rule.nested) {
      hits.push({ file, line: lineForOffset(lineStarts, rule.bodyStart), selector, decl: '{ ... }', reason: "nested CSS isn't read by this check; write each rule on its own" });
      continue;
    }
    for (const declaration of parseDeclarations(rule.body, rule.bodyStart)) {
      if (!COLOUR_PROP.test(declaration.prop)) continue;
      const reason = ROLE.test(selector)
        ? 'a role badge is neutral: it takes the plain badge colours'
        : ACCENT_VAR.test(declaration.value)
        ? 'the accent, or a token that aliases it'
        : ACCENT_LITERAL.test(declaration.value)
          ? 'the literal accent colour'
          : null;
      if (reason) hits.push({ file, line: lineForOffset(lineStarts, declaration.offset), selector, decl: `${declaration.prop}: ${compact(declaration.value)}`, reason });
    }
  }
  return hits;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
