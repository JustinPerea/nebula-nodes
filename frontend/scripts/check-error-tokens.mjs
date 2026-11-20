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

// Design: an error is not a destructive action, and neither is the accent.
//   --sr-error*   something went wrong; it takes the warning tone.
//   --sr-danger*  a destructive action (the one red); nothing else.
//   --sr-accent*  the primary call to action, the selected state and the agent.
//
// This reads every stylesheet under src and fails on:
//   1. a token: --sr-error* or --sr-danger* (and the --sr-danger-ink/-fill/-tint/-edge aliases)
//      whose value resolves, through var() chains or fallbacks, to the accent
//      (var(--sr-accent...) or the literal #FF5A1F / rgba(255, 90, 31, ...)).
//   2. an error state (a selector holding `error`, `fail` or `invalid`) that uses
//      var(--sr-danger...) or the accent in any declaration.
//   3. a destructive control (the last compound of a selector holds `danger`, `delete`,
//      `destructive`, `--clear`, `discard`, `forget` or `trash__trigger`) that uses
//      var(--sr-error...) or the accent in any declaration.
// A selector that is both (`.kept-delete-chooser__error`) is an error state: the error check wins.
// Known limit: a colour reached through a local custom property (`--x: var(--sr-accent)`) is
// caught only where that property is declared inside such a rule; CSS nesting under such a
// selector is not read, so it fails.

const SRC = join(process.cwd(), 'src');
const TOKEN_NAME = /^--(?:sr-(?:error|danger)|jev-fail)(?![\w])/;
const ACCENT_VAR = /var\(\s*(--sr-accent(?![\w])[\w-]*)/gi;
const VAR_REF = /var\(\s*(--[\w-]+)/g;
const ACCENT_LITERAL = /#ff5a1f(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*255\s*[, ]\s*90\s*[, ]\s*31\b/i;
const ERROR_STATE = /error|fail|invalid/i;
const DESTRUCTIVE = /danger|delete|destructive|--clear|discard|forget|trash__trigger/i;
const DANGER_USE = /var\(\s*--sr-danger(?![\w])/i;
const ERROR_USE = /var\(\s*--sr-error(?![\w])/i;
const ACCENT_USE = /var\(\s*--sr-accent(?![\w])|#ff5a1f(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*255\s*[, ]\s*90\s*[, ]\s*31\b/i;

function main() {
  const files = collectCssFiles(SRC).map((file) => ({ file: relative(SRC, file), source: readFileSync(file, 'utf8') }));
  const hits = findErrorTokenHits(files);
  if (hits.length > 0) {
    console.error('Error, danger and accent are three different things (design). Errors take --sr-error (the warning tone), destructive actions take --sr-danger*, and the accent stays for the primary action, the selected state and the agent.');
    for (const hit of hits) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} { ${hit.decl} }  (${hit.reason})`);
    process.exit(1);
  }
  console.log(`Error token guard passed (${files.length} stylesheets scanned).`);
}

/** Every violation across a set of { file, source } sheets: { file, line, selector, decl, reason }. */
export function findErrorTokenHits(sheets) {
  const parsed = sheets.map(({ file, source }) => {
    const css = stripComments(source);
    return { file, css, lineStarts: computeLineStarts(css), rules: parseRules(css) };
  });

  // Every definition of a custom property, across all sheets (a local override counts).
  const defs = new Map();
  for (const sheet of parsed) {
    for (const rule of sheet.rules) {
      if (rule.nested) continue;
      for (const d of parseDeclarations(rule.body, rule.bodyStart)) {
        if (!d.prop.startsWith('--')) continue;
        if (!defs.has(d.prop)) defs.set(d.prop, []);
        defs.get(d.prop).push(d.value);
      }
    }
  }
  const reachesAccent = (value, seen = new Set()) => {
    if (ACCENT_LITERAL.test(value)) return 'the literal accent colour';
    ACCENT_VAR.lastIndex = 0;
    if (ACCENT_VAR.test(value)) return 'the accent';
    for (const match of value.matchAll(VAR_REF)) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      for (const next of defs.get(name) ?? []) {
        const found = reachesAccent(next, seen);
        if (found) return `${name} -> ${found}`;
      }
    }
    return null;
  };

  const hits = [];
  for (const sheet of parsed) {
    for (const rule of sheet.rules) {
      const selector = compact(rule.selector);
      const parts = selector.split(',').map((part) => part.trim());
      const errorState = parts.some((part) => ERROR_STATE.test(part));
      const destructive = !errorState && parts.some((part) => DESTRUCTIVE.test(lastCompound(part)));
      const lineAt = (offset) => lineForOffset(sheet.lineStarts, offset);
      if (rule.nested) {
        if (parts.some((part) => ERROR_STATE.test(part) || DESTRUCTIVE.test(lastCompound(part)))) {
          hits.push({ file: sheet.file, line: lineAt(rule.bodyStart), selector, decl: '{ ... }', reason: "nested CSS isn't read by this check; write each rule on its own" });
        }
        continue;
      }
      for (const d of parseDeclarations(rule.body, rule.bodyStart)) {
        const value = compact(d.value);
        const at = { file: sheet.file, line: lineAt(d.offset), selector, decl: `${d.prop}: ${value}` };
        if (TOKEN_NAME.test(d.prop)) {
          const found = reachesAccent(value);
          if (found) hits.push({ ...at, reason: `an error or danger token that resolves to the accent: ${found}` });
        }
        if (errorState) {
          if (DANGER_USE.test(value)) hits.push({ ...at, reason: 'an error state reads --sr-danger*: error is not danger, use --sr-error*' });
          else if (ACCENT_USE.test(value)) hits.push({ ...at, reason: 'an error state paints the accent: use --sr-error*' });
        } else if (destructive) {
          if (ERROR_USE.test(value)) hits.push({ ...at, reason: 'a destructive control reads --sr-error*: use --sr-danger*' });
          else if (ACCENT_USE.test(value)) hits.push({ ...at, reason: 'a destructive control paints the accent: use --sr-danger*' });
        }
      }
    }
  }
  return hits;
}

/** The last compound selector of a part ("a .b > .c:hover" -> ".c:hover"). */
function lastCompound(part) {
  return part.split(/[\s>+~]+/).filter(Boolean).pop() ?? part;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
