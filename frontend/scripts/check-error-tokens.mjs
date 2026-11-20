import { readFileSync } from 'node:fs';
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
//   2. an error state (the last compound of a selector part holds `error`, `fail`, `invalid`,
//      `refused`, `warn`, `blocked`, `denied` or `rejected`) that uses var(--sr-danger...), the
//      danger red literals (#ff887d, #ff9a91, rgba(255, 70, 60, ...)), the accent or the
//      accent literal in any declaration.
//   3. a destructive control (the last compound holds `danger`, `delete`, `destructive`,
//      `--clear`, `discard`, `forget` or `trash__trigger`) that uses var(--sr-error...),
//      var(--sr-warning...), the accent, the accent literal or the warning literal (#F5C518).
//   4. design's one rule, yellow means something needs attention or went wrong and nothing else:
//      a rule whose last compound names a state that needs neither (`running`, `pass`,
//      `passed`, `done`, `ready`, `ok`, `success`, `complete`, `completed`, `found`) may not read --sr-warning*, --sr-error* or
//      the warning literal.
// The state words are read from the element and modifier, not the BEM block, so
// `.personal-warning__accept` (a button in a warning dialog) is not an error state, and
// `not-ready` is not a ready state, and `.pass-through` is not a pass state. A :not(...) group is
// dropped before a selector is read, so `.row:not(.row--ready)` styles the not-ready case.
// Selectors are classified by the last compound of each part. A control inside an error container
// (a Retry or Delete button in `.chat__tool--error`) is not an error state; any other descendant
// of one (`.chat__tool--error .chat__tool-output`) is, so its text takes the error tone. A control
// is a last compound naming button, btn, retry, action, link, close, dismiss, delete, remove,
// toggle or menu, or the element button, a or input. A selector that
// is both error and destructive (`.kept-delete-chooser__error`) is an error state.
// Nested CSS is flattened first: a nested selector with & is resolved against each part of its
// parent (`.run { &--error {} }` reads as `.run--error`, `&.is-error` as `.run.is-error`), one
// without & is a descendant (`.run { .x {} }` reads as `.run .x`), and the declarations the
// parent holds beside the nested blocks are read under the parent selector.
// Limits: a custom property is followed one level, and only when it is declared in the same
// file (`--x: var(--sr-accent)` in one rule, `var(--x)` in an error rule of that file). A chain
// of two local properties, or a property declared in another file, is not followed.

const SRC = join(process.cwd(), 'src');
const TOKEN_NAME = /^--(?:sr-(?:error|danger)|jev-fail)(?![\w])/;
const ACCENT_VAR = /var\(\s*(--sr-accent(?![\w])[\w-]*)/gi;
const VAR_REF = /var\(\s*(--[\w-]+)/g;
const ACCENT_LITERAL = /#ff5a1f(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*255\s*[, ]\s*90\s*[, ]\s*31\b/i;
export const ERROR_STATE = /error|fail|invalid|refused|warn|blocked|denied|rejected/i;
// A calm word is a whole class or modifier word: `.row--ready` and `.is-done` match, `.pass-through`
// does not, and `not-ready` (the state that needs attention) is the one not- form that is exempt.
export const CALM_STATE = /(?<![a-z0-9])(?:running|pass|passed|done|ok|success|complete|completed|(?<!not-)(?:ready|found))(?![a-z0-9-])/i;
// A control inside an error container (a Retry or Delete button) is not an error state; any other
// descendant of one (its output, its text) is.
const CONTROL = /^(?:button|a|input)(?![\w-])|button|btn|retry|action|link|close|dismiss|delete|remove|toggle|menu/i;
export const NOT_GROUP = /:not\((?:[^()]|\([^()]*\))*\)/g;
const ATTENTION_USE = /var\(\s*--sr-(?:warning|error)(?![\w])|#f5c518(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*245\s*[, ]\s*197\s*[, ]\s*24\b/i;
const WARNING_LITERAL = /#f5c518(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*245\s*[, ]\s*197\s*[, ]\s*24\b/i;
const DESTRUCTIVE = /danger|delete|destructive|--clear|discard|forget|trash__trigger/i;
const DANGER_USE = /var\(\s*--sr-danger(?![\w])|#ff887d(?:[0-9a-f]{2})?(?![0-9a-f])|#ff9a91(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*255\s*[, ]\s*70\s*[, ]\s*60\b/i;
const ERROR_USE = /var\(\s*--sr-(?:error|warning)(?![\w])|#f5c518(?:[0-9a-f]{2})?(?![0-9a-f])|rgba?\(\s*245\s*[, ]\s*197\s*[, ]\s*24\b/i;
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
    const rules = parseRules(css).flatMap((rule) => flattenNested(rule));
    // Custom properties declared in this file, for the one-level lookup.
    const local = new Map();
    for (const rule of rules) {
      for (const d of parseDeclarations(rule.body, rule.bodyStart)) {
        if (!d.prop.startsWith('--')) continue;
        if (!local.has(d.prop)) local.set(d.prop, []);
        local.get(d.prop).push(compact(d.value));
      }
    }
    return { file, css, lineStarts: computeLineStarts(css), rules, local };
  });

  // Every definition of a custom property, across all sheets (a local override counts).
  const defs = new Map();
  for (const sheet of parsed) {
    for (const rule of sheet.rules) {
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
      const parts = selector.split(',').map((part) => part.replace(NOT_GROUP, '').trim());
      const errorState = parts.some((part) => ERROR_STATE.test(stateOf(part)) || inErrorContainer(part));
      const calm = parts.some((part) => CALM_STATE.test(stateOf(part)));
      const destructive = !errorState && parts.some((part) => DESTRUCTIVE.test(lastCompound(part)));
      const lineAt = (offset) => lineForOffset(sheet.lineStarts, offset);
      for (const d of parseDeclarations(rule.body, rule.bodyStart)) {
        const value = compact(d.value);
        const seen = followLocal(value, sheet.local);
        const at = { file: sheet.file, line: lineAt(d.offset), selector, decl: `${d.prop}: ${value}` };
        if (TOKEN_NAME.test(d.prop)) {
          const found = reachesAccent(value);
          if (found) hits.push({ ...at, reason: `an error or danger token that resolves to the accent: ${found}` });
        }
        if (calm && ATTENTION_USE.test(seen)) {
          hits.push({ ...at, reason: 'yellow means something needs attention or went wrong; a running, passed, done or ready state takes a neutral or success tone' });
        }
        if (errorState) {
          if (DANGER_USE.test(seen)) hits.push({ ...at, reason: 'an error state reads --sr-danger*: error is not danger, use --sr-error*' });
          else if (ACCENT_USE.test(seen)) hits.push({ ...at, reason: 'an error state paints the accent: use --sr-error*' });
        } else if (destructive) {
          if (ERROR_USE.test(seen)) hits.push({ ...at, reason: 'a destructive control reads --sr-error*: use --sr-danger*' });
          else if (ACCENT_USE.test(seen)) hits.push({ ...at, reason: 'a destructive control paints the accent: use --sr-danger*' });
        }
      }
    }
  }
  return hits;
}

/**
 * A rule with its nested blocks taken out: the parent with its own declarations, then one rule per
 * nested block with its selector resolved against the parent (recursively).
 */
export function flattenNested(rule) {
  if (!rule.nested) return [rule];
  const out = [];
  let own = rule.body;
  let cursor = 0;
  while (cursor < rule.body.length) {
    const open = rule.body.indexOf('{', cursor);
    if (open === -1) break;
    const close = findMatchingBrace(rule.body, open);
    if (close === -1) break;
    const start = Math.max(cursor, findSelectorStart(rule.body, open));
    const inner = rule.body.slice(start, open).trim();
    const innerRule = {
      selector: resolveNested(inner, rule.selector),
      body: rule.body.slice(open + 1, close),
      bodyStart: rule.bodyStart + open + 1,
      nested: bodyHasBrace(rule.body.slice(open + 1, close)),
    };
    out.push(...flattenNested(innerRule));
    own = own.slice(0, start) + ' '.repeat(close + 1 - start) + own.slice(close + 1);
    cursor = close + 1;
  }
  return [{ ...rule, body: own, nested: false }, ...out];
}

/** A nested selector read against its parent: & becomes each parent part; no & means a descendant. An @-rule keeps the parent. */
function resolveNested(inner, parent) {
  if (inner.startsWith('@')) return parent;
  const parentParts = parent.split(',').map((part) => part.trim());
  return inner
    .split(',')
    .map((part) => part.trim())
    .flatMap((part) => parentParts.map((p) => (part.includes('&') ? part.replaceAll('&', p) : `${p} ${part}`)))
    .join(', ');
}

/** A part whose ancestor compound is an error state and whose own element is not a control: the text inside an error container. */
function inErrorContainer(part) {
  const compounds = part.split(/[\s>+~]+/).filter(Boolean);
  if (compounds.length < 2) return false;
  if (CONTROL.test(compounds[compounds.length - 1])) return false;
  return compounds.slice(0, -1).some((compound) => ERROR_STATE.test(compound.replace(/\.[\w-]*?__/g, '.')));
}

/** The state words of a part: its last compound without the BEM block (`.personal-warning__accept` -> `.accept`). */
export function stateOf(part) {
  return lastCompound(part).replace(/\.[\w-]*?__/g, '.');
}

/** A value plus, for each var(--x) in it, the values --x is given elsewhere in the same file. */
function followLocal(value, local) {
  let out = value;
  for (const match of value.matchAll(VAR_REF)) {
    for (const next of local.get(match[1]) ?? []) out += ` ${next}`;
  }
  return out;
}

/** The last compound selector of a part ("a .b > .c:hover" -> ".c:hover"). */
export function lastCompound(part) {
  return part.split(/[\s>+~]+/).filter(Boolean).pop() ?? part;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
